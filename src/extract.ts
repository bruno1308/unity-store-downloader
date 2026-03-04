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
import { resolveUnityMaterials } from "./unity-materials.js";

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
 * Walk a directory and find all files with given extensions.
 */
function findModelFiles(dir: string): string[] {
  const modelExts = new Set([".fbx", ".obj", ".gltf"]);
  const results: string[] = [];

  function walk(d: string) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (modelExts.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Convert all FBX/OBJ/GLTF files in a directory to GLB, then resolve
 * Unity material textures. Deletes original files after successful conversion.
 *
 * @param assetDir - Root directory of extracted Unity assets
 * @param guidMap - GUID→relativePath map from extractUnityPackage()
 */
export async function convertModels(
  assetDir: string,
  guidMap: Map<string, string>,
): Promise<void> {
  const modelFiles = findModelFiles(assetDir);
  if (modelFiles.length === 0) {
    console.log("  No FBX/OBJ/GLTF files to convert");
    return;
  }

  console.log(`  Converting ${modelFiles.length} model files to GLB...`);
  let converted = 0;
  let texturesInjected = 0;

  for (const modelPath of modelFiles) {
    const ext = path.extname(modelPath).toLowerCase();
    const glbPath = modelPath.replace(/\.(fbx|obj|gltf)$/i, ".glb");
    const relPath = path.relative(assetDir, modelPath);

    try {
      if (ext === ".fbx") {
        const fbx2gltf = await getFbx2gltf();
        // fbx2gltf writes to a temp file, then we move it
        const tmpOut = path.join(
          os.tmpdir(),
          `unity-fbx-${crypto.randomUUID()}.glb`,
        );
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

      // Resolve Unity material textures
      const injected = await resolveUnityMaterials(glbPath, assetDir, guidMap);
      texturesInjected += injected;

      // Delete original file (keep only GLB)
      if (fs.existsSync(glbPath) && modelPath !== glbPath) {
        fs.unlinkSync(modelPath);
      }

      converted++;
      if (injected > 0) {
        console.log(`    ✓ ${relPath} → GLB (${injected} textures injected)`);
      } else {
        console.log(`    ✓ ${relPath} → GLB`);
      }
    } catch (err) {
      console.warn(`    ✗ ${relPath}: ${err}`);
    }
  }

  console.log(
    `  Converted ${converted}/${modelFiles.length} models, ${texturesInjected} textures injected`,
  );
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
