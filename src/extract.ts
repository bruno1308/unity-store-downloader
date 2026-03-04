/**
 * Unity Package Extraction & Model Conversion
 *
 * Extracts .unitypackage files (tar.gz with GUID-based structure),
 * converts FBX/OBJ/GLTF to GLB, and injects textures via material resolution.
 *
 * CLI usage:
 *   npx tsx src/extract.ts --input <path-to-unitypackage> [--output <dir>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { NodeIO } from "@gltf-transform/core";
import { resolveUnityMaterials, injectProximityTextures } from "./unity-materials.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ExtractResult {
  /** Directory containing extracted & converted assets */
  tmpDir: string;
  /** Map of Unity GUID → relative file path */
  guidMap: Map<string, string>;
}

// ── .unitypackage extraction ─────────────────────────────────────────────

/**
 * Extract a .unitypackage file (tar.gz with GUID-based structure).
 *
 * Each entry in the tar is a GUID folder containing:
 *   - pathname: original file path (e.g., "Assets/_Pack/Textures/knight.png")
 *   - asset: the actual file bytes
 *   - asset.meta: Unity metadata (skipped)
 *   - preview.png: Unity thumbnail (skipped)
 *
 * Returns the temp directory and the GUID→pathname map for texture resolution.
 */
export async function extractUnityPackage(
  pkgPath: string,
  outputDir?: string,
): Promise<ExtractResult> {
  const tmpDir =
    outputDir || path.join(os.tmpdir(), `ingest-unity-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const compressed = fs.readFileSync(pkgPath);
  const tarBuffer = zlib.gunzipSync(compressed);

  // Parse tar format: 512-byte header blocks + data blocks
  const entries = new Map<
    string,
    { pathname?: string; assetOffset?: number; assetSize?: number }
  >();
  let offset = 0;

  while (offset < tarBuffer.length - 512) {
    const header = tarBuffer.subarray(offset, offset + 512);
    // Check for empty block (end of archive)
    if (header.every((b) => b === 0)) break;

    // Parse tar header
    const nameRaw = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0/g, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0/g, "")
      .trim();
    const fileSize = parseInt(sizeOctal, 8) || 0;
    const dataOffset = offset + 512;

    // Entries look like: "GUID/pathname", "GUID/asset", "GUID/preview.png"
    const parts = nameRaw.replace(/^\.\//, "").split("/");
    if (parts.length >= 2) {
      const guid = parts[0];
      const fileName = parts.slice(1).join("/");
      if (!entries.has(guid)) entries.set(guid, {});
      const entry = entries.get(guid)!;

      if (fileName === "pathname" && fileSize > 0) {
        entry.pathname = tarBuffer
          .subarray(dataOffset, dataOffset + fileSize)
          .toString("utf8")
          .split("\n")[0]
          .replace(/\0/g, "")
          .trim();
      } else if (fileName === "asset" && fileSize > 0) {
        entry.assetOffset = dataOffset;
        entry.assetSize = fileSize;
      }
    }

    // Advance past header + data (data is padded to 512-byte boundary)
    offset = dataOffset + Math.ceil(fileSize / 512) * 512;
  }

  // Build GUID→relativePath map and write assets to disk
  const guidMap = new Map<string, string>();
  let extracted = 0;

  for (const [guid, entry] of entries) {
    if (
      !entry.pathname ||
      entry.assetOffset === undefined ||
      entry.assetSize === undefined
    )
      continue;

    // Strip leading "Assets/" prefix — Unity convention
    let relPath = entry.pathname;
    if (relPath.startsWith("Assets/")) relPath = relPath.slice(7);

    // Normalize path separators
    relPath = relPath.replace(/\\/g, "/");

    const outPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const assetData = tarBuffer.subarray(
      entry.assetOffset,
      entry.assetOffset + entry.assetSize,
    );
    fs.writeFileSync(outPath, assetData);
    guidMap.set(guid, relPath);
    extracted++;
  }

  console.log(`  Extracted ${extracted} files from .unitypackage`);
  console.log(`  GUID map: ${guidMap.size} entries`);

  return { tmpDir, guidMap };
}

// ── Model conversion ─────────────────────────────────────────────────────

// fbx2gltf ships as CJS with a default export function
let _fbx2gltf: ((src: string, dest: string, opts?: string[]) => Promise<string>) | null = null;
async function getFbx2gltf() {
  if (!_fbx2gltf) {
    const mod = await import("fbx2gltf");
    _fbx2gltf = (mod.default ?? mod) as (src: string, dest: string, opts?: string[]) => Promise<string>;
  }
  return _fbx2gltf;
}

let _obj2gltf: ((objPath: string, options?: { binary?: boolean }) => Promise<Buffer>) | null = null;
async function getObj2gltf() {
  if (!_obj2gltf) {
    const mod = await import("obj2gltf");
    _obj2gltf = (mod.default ?? mod) as (objPath: string, options?: { binary?: boolean }) => Promise<Buffer>;
  }
  return _obj2gltf;
}

/**
 * Walk a directory and find all model files, separating base models from animation clips.
 *
 * Unity convention: "Model@AnimationName.fbx" is an animation clip for "Model.fbx".
 * Base models are returned in `models`, animation clips grouped by base name in `animations`.
 */
function findModelFiles(dir: string): {
  models: string[];
  animations: Map<string, string[]>; // baseName → [animPath, ...]
} {
  const modelExts = new Set([".fbx", ".obj", ".gltf"]);
  const models: string[] = [];
  const animations = new Map<string, string[]>();

  function walk(d: string) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (modelExts.has(path.extname(entry.name).toLowerCase())) {
        const baseName = path.basename(entry.name, path.extname(entry.name));
        if (baseName.includes("@")) {
          // Animation clip — group by base model name
          const modelBase = baseName.split("@")[0];
          const key = path.join(path.dirname(fullPath), modelBase);
          if (!animations.has(key)) animations.set(key, []);
          animations.get(key)!.push(fullPath);
        } else {
          models.push(fullPath);
        }
      }
    }
  }
  walk(dir);
  return { models, animations };
}

/**
 * Convert a single model file (FBX/OBJ/GLTF) to GLB.
 * Returns the output GLB path.
 */
async function convertSingleModel(modelPath: string, glbPath: string): Promise<void> {
  const ext = path.extname(modelPath).toLowerCase();
  if (ext === ".fbx") {
    const fbx2gltf = await getFbx2gltf();
    const tmpOut = path.join(os.tmpdir(), `unity-fbx-${crypto.randomUUID()}.glb`);
    await fbx2gltf(modelPath, tmpOut, ["--binary"]);
    fs.renameSync(tmpOut, glbPath);
  } else if (ext === ".obj") {
    const obj2gltf = await getObj2gltf();
    const glbBuffer = await obj2gltf(modelPath, { binary: true });
    fs.writeFileSync(glbPath, glbBuffer);
  } else if (ext === ".gltf") {
    const io = new NodeIO();
    const document = await io.read(modelPath);
    await io.write(glbPath, document);
  }
}

/**
 * Merge animation clips from animation GLBs into a base model GLB.
 *
 * Each animation FBX (e.g., "Dragon_11@Walk.fbx") contains the same skeleton
 * with a different animation baked in. We convert each to a temp GLB, extract
 * the animation tracks, and copy them into the base model's document.
 *
 * Returns the list of animation names merged.
 */
async function mergeAnimations(
  baseGlbPath: string,
  animPaths: string[],
): Promise<string[]> {
  const io = new NodeIO();
  const baseDoc = await io.read(baseGlbPath);
  const baseRoot = baseDoc.getRoot();
  const mergedNames: string[] = [];

  // Also collect any animations already in the base model (e.g., T-pose)
  for (const existing of baseRoot.listAnimations()) {
    const name = existing.getName();
    if (name) mergedNames.push(name);
  }

  for (const animPath of animPaths) {
    const baseName = path.basename(animPath, path.extname(animPath));
    const animName = baseName.split("@")[1];
    if (!animName) continue;

    // Convert animation FBX to temp GLB
    const tmpGlb = path.join(os.tmpdir(), `unity-anim-${crypto.randomUUID()}.glb`);
    try {
      await convertSingleModel(animPath, tmpGlb);
      const animDoc = await io.read(tmpGlb);
      const animRoot = animDoc.getRoot();
      const animations = animRoot.listAnimations();

      if (animations.length === 0) continue;

      // Build a node name→node map from the base document for retargeting
      const baseNodes = new Map<string, import("@gltf-transform/core").Node>();
      for (const scene of baseRoot.listScenes()) {
        for (const node of scene.listChildren()) {
          collectNodes(node, baseNodes);
        }
      }

      // Copy each animation from the animation document into the base
      for (const srcAnim of animations) {
        const dstAnim = baseDoc.createAnimation(animName);

        for (const srcChannel of srcAnim.listChannels()) {
          const srcSampler = srcChannel.getSampler();
          const targetNode = srcChannel.getTargetNode();
          if (!srcSampler || !targetNode) continue;

          // Find the matching node in the base model by name
          const nodeName = targetNode.getName();
          const baseNode = baseNodes.get(nodeName);
          if (!baseNode) continue; // skeleton bone not found — skip

          // Copy sampler (input/output accessors + interpolation)
          const srcInput = srcSampler.getInput();
          const srcOutput = srcSampler.getOutput();
          if (!srcInput || !srcOutput) continue;

          const dstInput = baseDoc.createAccessor()
            .setType(srcInput.getType())
            .setArray(srcInput.getArray()!.slice());
          const dstOutput = baseDoc.createAccessor()
            .setType(srcOutput.getType())
            .setArray(srcOutput.getArray()!.slice());

          const dstSampler = baseDoc.createAnimationSampler()
            .setInput(dstInput)
            .setOutput(dstOutput)
            .setInterpolation(srcSampler.getInterpolation());

          const targetPath = srcChannel.getTargetPath();
          if (!targetPath) continue;

          const dstChannel = baseDoc.createAnimationChannel()
            .setSampler(dstSampler)
            .setTargetNode(baseNode)
            .setTargetPath(targetPath);

          dstAnim.addSampler(dstSampler);
          dstAnim.addChannel(dstChannel);
        }

        if (dstAnim.listChannels().length > 0) {
          mergedNames.push(animName);
        } else {
          // No channels matched — discard empty animation
          dstAnim.dispose();
        }
      }
    } catch (err) {
      console.warn(`      ⚠ Failed to merge animation ${animName}: ${err}`);
    } finally {
      // Clean up temp GLB
      if (fs.existsSync(tmpGlb)) fs.unlinkSync(tmpGlb);
    }
  }

  if (mergedNames.length > 0) {
    await io.write(baseGlbPath, baseDoc);
  }

  return mergedNames;
}

/** Recursively collect all nodes by name */
function collectNodes(
  node: import("@gltf-transform/core").Node,
  map: Map<string, import("@gltf-transform/core").Node>,
) {
  const name = node.getName();
  if (name) map.set(name, node);
  for (const child of node.listChildren()) {
    collectNodes(child, map);
  }
}

/**
 * Convert all FBX/OBJ/GLTF files in a directory to GLB, resolve Unity material
 * textures, and merge animation clips into base models.
 *
 * Animation FBX files ("Model@Walk.fbx") are not ingested as separate assets.
 * Instead, their animation tracks are merged into the base model GLB, and
 * animation names are returned in the result for metadata.
 *
 * @param assetDir - Root directory of extracted Unity assets
 * @param guidMap - GUID→relativePath map from extractUnityPackage()
 */
export async function convertModels(
  assetDir: string,
  guidMap: Map<string, string>,
): Promise<Set<string>> {
  const allConsumedTextures = new Set<string>();
  const { models: modelFiles, animations: animationMap } = findModelFiles(assetDir);

  if (modelFiles.length === 0 && animationMap.size === 0) {
    console.log("  No FBX/OBJ/GLTF files to convert");
    return allConsumedTextures;
  }

  const totalAnims = Array.from(animationMap.values()).reduce((s, v) => s + v.length, 0);
  console.log(`  Converting ${modelFiles.length} model files to GLB (${totalAnims} animation clips to merge)...`);
  let converted = 0;
  let texturesInjected = 0;
  let animationsMerged = 0;

  for (const modelPath of modelFiles) {
    const glbPath = modelPath.replace(/\.(fbx|obj|gltf)$/i, ".glb");
    const relPath = path.relative(assetDir, modelPath);

    try {
      await convertSingleModel(modelPath, glbPath);

      // Resolve Unity material textures via .mat files
      const result = await resolveUnityMaterials(glbPath, assetDir, guidMap, true);
      texturesInjected += result.injectedCount;
      for (const t of result.consumedTextures) allConsumedTextures.add(t);

      // Fallback: proximity-based texture matching for still-untextured materials
      const modelName = path.basename(modelPath, path.extname(modelPath));
      const proxResult = await injectProximityTextures(glbPath, assetDir, allConsumedTextures, modelName);
      texturesInjected += proxResult.injectedCount;
      for (const t of proxResult.consumedTextures) allConsumedTextures.add(t);

      // Merge animation clips if any exist for this base model
      const baseKey = path.join(
        path.dirname(modelPath),
        path.basename(modelPath, path.extname(modelPath)),
      );
      const animFiles = animationMap.get(baseKey);
      let mergedAnims: string[] = [];
      if (animFiles && animFiles.length > 0) {
        mergedAnims = await mergeAnimations(glbPath, animFiles);
        animationsMerged += mergedAnims.length;
        // Store animation names in a sidecar file for the ingestion pipeline to pick up
        if (mergedAnims.length > 0) {
          fs.writeFileSync(
            glbPath + ".animations.json",
            JSON.stringify(mergedAnims),
          );
        }
      }

      // Delete original source file (keep only GLB)
      if (fs.existsSync(glbPath) && modelPath !== glbPath) {
        fs.unlinkSync(modelPath);
      }
      // Delete animation source files
      if (animFiles) {
        for (const af of animFiles) {
          if (fs.existsSync(af)) fs.unlinkSync(af);
        }
      }

      const totalInjected = result.injectedCount + proxResult.injectedCount;
      converted++;
      const parts = [`✓ ${relPath} → GLB`];
      if (totalInjected > 0) parts.push(`${totalInjected} textures`);
      if (mergedAnims.length > 0) parts.push(`${mergedAnims.length} animations: ${mergedAnims.join(", ")}`);
      console.log(`    ${parts.join(" | ")}`);
    } catch (err) {
      console.warn(`    ✗ ${relPath}: ${err}`);
    }
  }

  // Handle animation-only groups (no base model found — pick first as base)
  for (const [baseKey, animFiles] of animationMap) {
    const baseModelExists = modelFiles.some((m) => {
      const k = path.join(path.dirname(m), path.basename(m, path.extname(m)));
      return k === baseKey;
    });
    if (baseModelExists) continue; // already handled above

    // No base model — use first animation file as the base, merge rest into it
    const sorted = [...animFiles].sort();
    const baseAnimPath = sorted[0];
    const restAnims = sorted.slice(1);
    const baseName = path.basename(baseAnimPath, path.extname(baseAnimPath)).split("@")[0];
    const glbPath = path.join(path.dirname(baseAnimPath), baseName + ".glb");
    const relPath = path.relative(assetDir, baseAnimPath);

    try {
      await convertSingleModel(baseAnimPath, glbPath);

      // Resolve textures
      const result = await resolveUnityMaterials(glbPath, assetDir, guidMap, true);
      texturesInjected += result.injectedCount;
      for (const t of result.consumedTextures) allConsumedTextures.add(t);

      const proxResult = await injectProximityTextures(glbPath, assetDir, allConsumedTextures, baseName);
      texturesInjected += proxResult.injectedCount;
      for (const t of proxResult.consumedTextures) allConsumedTextures.add(t);

      // Rename the baked-in animation from the first file
      const io = new NodeIO();
      const doc = await io.read(glbPath);
      const firstAnimName = path.basename(baseAnimPath, path.extname(baseAnimPath)).split("@")[1] || "default";
      for (const anim of doc.getRoot().listAnimations()) {
        if (!anim.getName()) anim.setName(firstAnimName);
      }
      await io.write(glbPath, doc);

      // Merge remaining animations
      let mergedAnims = [firstAnimName];
      if (restAnims.length > 0) {
        const additional = await mergeAnimations(glbPath, restAnims);
        mergedAnims.push(...additional);
        animationsMerged += additional.length;
      }

      if (mergedAnims.length > 0) {
        fs.writeFileSync(glbPath + ".animations.json", JSON.stringify(mergedAnims));
      }

      // Delete source animation files
      for (const af of animFiles) {
        if (fs.existsSync(af)) fs.unlinkSync(af);
      }

      converted++;
      animationsMerged++; // count the first file too
      console.log(`    ✓ ${relPath} → GLB (no base model, built from animations | ${mergedAnims.length} animations: ${mergedAnims.join(", ")})`);
    } catch (err) {
      console.warn(`    ✗ ${relPath} (animation-only): ${err}`);
    }
  }

  console.log(
    `  Converted ${converted}/${modelFiles.length} models, ${texturesInjected} textures injected, ${animationsMerged} animations merged, ${allConsumedTextures.size} textures excluded from image scan`,
  );

  return allConsumedTextures;
}

// ── CLI entry point ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let inputPath: string | null = null;
  let outputDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      inputPath = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputDir = args[++i];
    }
  }

  if (!inputPath) {
    console.error("Usage: npx tsx src/extract.ts --input <path-to-unitypackage> [--output <dir>]");
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Extracting: ${inputPath}`);
  const { tmpDir, guidMap } = await extractUnityPackage(inputPath, outputDir);
  console.log(`Output: ${tmpDir}`);

  await convertModels(tmpDir, guidMap);
  console.log("\nDone.");
}

// Only run CLI when executed directly
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith("extract.ts") || process.argv[1].endsWith("extract.js"));
if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
