/**
 * Unity .mat file parser and GLB texture injector.
 *
 * Parses Unity Material YAML files to extract texture GUID references,
 * resolves them via the GUID→pathname map from .unitypackage extraction,
 * and injects textures into GLB files via @gltf-transform.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Document,
  NodeIO,
  Texture,
  type Material as GltfMaterial,
} from "@gltf-transform/core";
import sharp from "sharp";

// ── Types ────────────────────────────────────────────────────────────────

export interface UnityTextureRef {
  /** Shader slot name, e.g. "_MainTex", "_BumpMap" */
  slotName: string;
  /** 32-char hex GUID referencing a texture asset */
  guid: string;
}

export interface UnityMaterial {
  /** Material name from m_Name field */
  name: string;
  /** Texture references with non-zero GUIDs */
  textures: UnityTextureRef[];
}

// ── Unity slot → glTF mapping ────────────────────────────────────────────

type TextureSetter = (mat: GltfMaterial, tex: Texture) => void;

const SLOT_MAP: Record<string, TextureSetter> = {
  _MainTex: (mat, tex) => mat.setBaseColorTexture(tex),
  _BumpMap: (mat, tex) => mat.setNormalTexture(tex),
  _EmissionMap: (mat, tex) => mat.setEmissiveTexture(tex),
  _OcclusionMap: (mat, tex) => mat.setOcclusionTexture(tex),
  _MetallicGlossMap: (mat, tex) => mat.setMetallicRoughnessTexture(tex),
};

// ── .mat parser ──────────────────────────────────────────────────────────

const ZERO_GUID = "00000000000000000000000000000000";
const GUID_RE = /guid:\s*([0-9a-f]{32})/;

/**
 * Parse a Unity .mat file (YAML) and extract material name + texture refs.
 * Returns null if the content is not a valid Unity material.
 */
export function parseUnityMaterial(matContent: string): UnityMaterial | null {
  const lines = matContent.split("\n");

  // Find m_Name
  let name: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("m_Name:")) {
      name = trimmed.slice("m_Name:".length).trim();
      break;
    }
  }
  if (!name) return null;

  // Find m_TexEnvs section and extract texture refs
  const textures: UnityTextureRef[] = [];
  let inTexEnvs = false;
  let texEnvsIndent = -1;
  let currentSlot: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Measure leading whitespace
    const indent = line.length - line.trimStart().length;

    if (trimmed === "m_TexEnvs:") {
      inTexEnvs = true;
      texEnvsIndent = indent;
      continue;
    }

    // End of m_TexEnvs: any non-array line at same or lower indent
    if (
      inTexEnvs &&
      indent <= texEnvsIndent &&
      !trimmed.startsWith("- ")
    ) {
      inTexEnvs = false;
      continue;
    }

    if (!inTexEnvs) continue;

    // Slot entry: "- _MainTex:" or "- _BumpMap:"
    const slotMatch = trimmed.match(/^- (_\w+):$/);
    if (slotMatch) {
      currentSlot = slotMatch[1];
      continue;
    }

    // Texture reference line
    if (currentSlot && trimmed.startsWith("m_Texture:")) {
      // {fileID: 0} means no texture
      if (trimmed.includes("fileID: 0}") && !trimmed.includes("guid:")) {
        currentSlot = null;
        continue;
      }
      const guidMatch = trimmed.match(GUID_RE);
      if (guidMatch && guidMatch[1] !== ZERO_GUID) {
        textures.push({ slotName: currentSlot, guid: guidMatch[1] });
      }
      currentSlot = null;
    }
  }

  return { name, textures };
}

// ── Texture loader ───────────────────────────────────────────────────────

const PASSTHROUGH_EXTS = new Set([".png", ".jpg", ".jpeg"]);
const CONVERT_EXTS = new Set([".tga", ".psd", ".bmp", ".tif", ".tiff"]);

/**
 * Load a texture file, converting non-web formats to PNG via sharp.
 * Returns null if file missing or conversion fails.
 */
export async function loadAndConvertTexture(
  texturePath: string,
): Promise<{ buffer: Uint8Array; mimeType: string } | null> {
  if (!fs.existsSync(texturePath)) return null;

  const ext = path.extname(texturePath).toLowerCase();

  try {
    if (PASSTHROUGH_EXTS.has(ext)) {
      const buffer = fs.readFileSync(texturePath);
      const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
      return { buffer: new Uint8Array(buffer), mimeType };
    }

    if (CONVERT_EXTS.has(ext)) {
      const pngBuffer = await sharp(texturePath).png().toBuffer();
      return { buffer: new Uint8Array(pngBuffer), mimeType: "image/png" };
    }

    return null;
  } catch {
    return null;
  }
}

// ── GLB texture injector ─────────────────────────────────────────────────

/**
 * Walk a directory recursively and find all files matching given extensions.
 */
function findFiles(dir: string, extensions: Set<string>): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, extensions));
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Normalize a material name for matching:
 * - Strip " (Instance)" suffix (Unity adds this at runtime)
 * - Case-insensitive comparison
 */
function normalizeMaterialName(name: string): string {
  return name.replace(/\s*\(Instance\)$/i, "").toLowerCase().trim();
}

export interface MaterialResolveResult {
  /** Number of textures injected into the GLB */
  injectedCount: number;
  /** Absolute paths of texture files consumed (for exclusion from image ingestion) */
  consumedTextures: Set<string>;
}

/**
 * Resolve Unity material textures and inject them into a GLB file.
 *
 * @param glbPath - Path to the GLB file to modify in place
 * @param assetDir - Root directory of extracted Unity assets
 * @param guidMap - Map of GUID → relative file path from .unitypackage extraction
 * @returns Number of textures injected
 */
export async function resolveUnityMaterials(
  glbPath: string,
  assetDir: string,
  guidMap: Map<string, string>,
): Promise<number>;
export async function resolveUnityMaterials(
  glbPath: string,
  assetDir: string,
  guidMap: Map<string, string>,
  trackConsumed: true,
): Promise<MaterialResolveResult>;
export async function resolveUnityMaterials(
  glbPath: string,
  assetDir: string,
  guidMap: Map<string, string>,
  trackConsumed?: boolean,
): Promise<number | MaterialResolveResult> {
  const EMPTY_RESULT: MaterialResolveResult = { injectedCount: 0, consumedTextures: new Set<string>() };

  // 1. Find and parse all .mat files
  const matFiles = findFiles(assetDir, new Set([".mat"]));
  if (matFiles.length === 0) return trackConsumed ? EMPTY_RESULT : 0;

  const parsedMaterials = new Map<string, UnityTextureRef[]>();
  for (const matFile of matFiles) {
    const content = fs.readFileSync(matFile, "utf-8");
    const parsed = parseUnityMaterial(content);
    if (parsed && parsed.textures.length > 0) {
      parsedMaterials.set(normalizeMaterialName(parsed.name), parsed.textures);
    }
  }
  if (parsedMaterials.size === 0) return trackConsumed ? EMPTY_RESULT : 0;

  // 2. Read GLB
  const io = new NodeIO();
  const document = await io.read(glbPath);
  const root = document.getRoot();

  // 3. Match and inject textures
  let injectedCount = 0;
  const textureCache = new Map<string, Texture>(); // GUID → reusable Texture node
  const consumedTextures = new Set<string>(); // absolute paths of consumed textures

  for (const material of root.listMaterials()) {
    const matName = normalizeMaterialName(material.getName());
    const texRefs = parsedMaterials.get(matName);
    if (!texRefs) continue;

    for (const ref of texRefs) {
      const setter = SLOT_MAP[ref.slotName];
      if (!setter) continue;

      // Reuse cached texture if same GUID
      let texture = textureCache.get(ref.guid);
      if (!texture) {
        // Resolve GUID → file path
        const relativePath = guidMap.get(ref.guid);
        if (!relativePath) continue;

        const absolutePath = path.join(assetDir, relativePath);
        const loaded = await loadAndConvertTexture(absolutePath);
        if (!loaded) continue;

        texture = document
          .createTexture(path.basename(relativePath, path.extname(relativePath)))
          .setImage(loaded.buffer)
          .setMimeType(loaded.mimeType);
        textureCache.set(ref.guid, texture);
      }

      // Track the consumed texture file path
      const relativePath = guidMap.get(ref.guid);
      if (relativePath) consumedTextures.add(path.join(assetDir, relativePath));

      setter(material, texture);
      injectedCount++;
    }
  }

  // Also track ALL textures referenced by any .mat file (even those not in SLOT_MAP)
  // so we exclude normal maps, height maps, detail maps etc. that couldn't be injected
  for (const [, texRefs] of parsedMaterials) {
    for (const ref of texRefs) {
      const relativePath = guidMap.get(ref.guid);
      if (relativePath) consumedTextures.add(path.join(assetDir, relativePath));
    }
  }

  // 4. Write back if any textures were injected
  if (injectedCount > 0) {
    await io.write(glbPath, document);
  }

  if (trackConsumed) return { injectedCount, consumedTextures };
  return injectedCount;
}

// ── Proximity-based texture fallback ──────────────────────────────────

/** Common texture suffix patterns mapped to glTF material slots */
const SUFFIX_SLOT_MAP: Array<{ suffixes: string[]; setter: TextureSetter }> = [
  { suffixes: ["_diffuse", "_albedo", "_basecolor", "_base_color", "_color", "_d", "_base", "_col"],
    setter: (mat, tex) => mat.setBaseColorTexture(tex) },
  { suffixes: ["_normal", "_bump", "_n", "_nrm", "_norm"],
    setter: (mat, tex) => mat.setNormalTexture(tex) },
  { suffixes: ["_emission", "_emissive", "_e", "_emit"],
    setter: (mat, tex) => mat.setEmissiveTexture(tex) },
  { suffixes: ["_ao", "_occlusion", "_occ", "_ambient"],
    setter: (mat, tex) => mat.setOcclusionTexture(tex) },
  { suffixes: ["_metallic", "_roughness", "_mr", "_metallicgloss", "_metalroughness"],
    setter: (mat, tex) => mat.setMetallicRoughnessTexture(tex) },
];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tga", ".psd", ".bmp", ".tif", ".tiff"]);

/**
 * Classify an image filename into a glTF texture slot based on its suffix.
 * Returns the setter function and the "stem" (filename without the suffix keyword).
 * If no suffix matches, assumes base color.
 */
function classifyTextureSuffix(
  stem: string,
): { setter: TextureSetter; baseStem: string } {
  const lower = stem.toLowerCase();
  for (const { suffixes, setter } of SUFFIX_SLOT_MAP) {
    for (const suffix of suffixes) {
      if (lower.endsWith(suffix)) {
        return { setter, baseStem: lower.slice(0, -suffix.length) };
      }
    }
  }
  // No recognized suffix — default to base color
  return { setter: (mat, tex) => mat.setBaseColorTexture(tex), baseStem: lower };
}

/**
 * Tokenize a name for fuzzy matching: lowercase, split on non-alphanumeric.
 * Filters out short tokens (≤2 chars) and purely numeric tokens (e.g. "01", "02")
 * which cause false positive matches between unrelated assets.
 */
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1_$2")   // split at letter→digit boundary
    .replace(/(\d)([a-z])/g, "$1_$2")   // split at digit→letter boundary
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !/^\d+$/.test(t));
}

/**
 * Count shared tokens between two token arrays.
 * Uses exact match first, then prefix match (min 4 chars) to handle
 * plurals and suffixed variants (e.g. "cabinet" ↔ "cabinets").
 */
function sharedTokenCount(a: string[], b: string[]): number {
  let count = 0;
  for (const ta of a) {
    for (const tb of b) {
      if (ta === tb) { count++; break; }
      // Prefix match: shorter token must be prefix of longer, min 4 chars
      const shorter = ta.length <= tb.length ? ta : tb;
      const longer = ta.length > tb.length ? ta : tb;
      if (shorter.length >= 4 && longer.startsWith(shorter)) { count += 0.8; break; }
    }
  }
  return count;
}

/**
 * Inject textures into a GLB by matching nearby image files to untextured materials
 * using naming conventions. This is a fallback for when Unity .mat resolution fails.
 *
 * Only touches materials that lack a baseColorTexture — won't overwrite existing textures.
 *
 * @param modelName - Optional model filename (without extension) for fallback matching
 *   when material names are generic (e.g. "DefaultMaterial" from fbx2gltf)
 */
export async function injectProximityTextures(
  glbPath: string,
  assetDir: string,
  alreadyConsumed: Set<string>,
  modelName?: string,
): Promise<MaterialResolveResult> {
  const io = new NodeIO();
  const document = await io.read(glbPath);
  const root = document.getRoot();

  // Find materials that lack a base color texture
  const untexturedMaterials = root.listMaterials().filter(
    (mat) => !mat.getBaseColorTexture(),
  );
  if (untexturedMaterials.length === 0) {
    return { injectedCount: 0, consumedTextures: new Set() };
  }

  // Find candidate image files in the asset directory.
  // NOTE: Do NOT filter by alreadyConsumed here — multiple models in the same
  // package often share the same textures (e.g. Face.png used by every animation FBX).
  // The consumed set is for excluding textures from standalone image ingestion, not
  // for preventing reuse across models.
  const allImages = findFiles(assetDir, IMAGE_EXTS);
  if (allImages.length === 0) {
    return { injectedCount: 0, consumedTextures: new Set() };
  }

  // Pre-classify all image files
  const candidates = allImages.map((imgPath) => {
    const stem = path.basename(imgPath, path.extname(imgPath));
    const { setter, baseStem } = classifyTextureSuffix(stem);
    const tokens = tokenize(baseStem);
    return { imgPath, stem, baseStem, setter, tokens };
  });

  let injectedCount = 0;
  const consumedTextures = new Set<string>();
  const textureCache = new Map<string, Texture>();

  // Special case: single material + single image → auto-match
  if (untexturedMaterials.length === 1 && candidates.length === 1) {
    const mat = untexturedMaterials[0];
    const cand = candidates[0];
    const loaded = await loadAndConvertTexture(cand.imgPath);
    if (loaded) {
      const texture = document
        .createTexture(cand.stem)
        .setImage(loaded.buffer)
        .setMimeType(loaded.mimeType);
      cand.setter(mat, texture);
      consumedTextures.add(cand.imgPath);
      injectedCount++;
      console.log(`    [proximity] Auto-matched ${path.basename(cand.imgPath)} → ${mat.getName()} (single-pair)`);
    }
  } else {
    // Match by name similarity
    for (const mat of untexturedMaterials) {
      const matTokens = tokenize(normalizeMaterialName(mat.getName()));

      let bestMatch: typeof candidates[0] | null = null;
      let bestScore = 0;

      // Strategy 1: Match texture name against material name
      if (matTokens.length > 0) {
        for (const cand of candidates) {
          if (consumedTextures.has(cand.imgPath)) continue;
          const shared = sharedTokenCount(matTokens, cand.tokens);
          if (shared === 0) continue;
          if (shared > bestScore) {
            bestScore = shared;
            bestMatch = cand;
          }
        }
      }

      // Strategy 2: Fallback — match texture name against MODEL filename
      // Handles generic material names like "DefaultMaterial" from fbx2gltf
      if (!bestMatch && modelName) {
        const modelTokens = tokenize(modelName);
        if (modelTokens.length > 0) {
          for (const cand of candidates) {
            if (consumedTextures.has(cand.imgPath)) continue;
            const shared = sharedTokenCount(modelTokens, cand.tokens);
            if (shared === 0) continue;
            // Only pick base color candidates for model-name fallback
            const isBCCandidate = !cand.baseStem.match(/[_-](normal|bump|n|nrm|ao|occlusion|metallic|roughness|emission|emissive)$/i);
            if (!isBCCandidate) continue;
            if (shared > bestScore) {
              bestScore = shared;
              bestMatch = cand;
            }
          }
        }
      }

      if (bestMatch) {
        let texture = textureCache.get(bestMatch.imgPath);
        if (!texture) {
          const loaded = await loadAndConvertTexture(bestMatch.imgPath);
          if (!loaded) continue;
          texture = document
            .createTexture(bestMatch.stem)
            .setImage(loaded.buffer)
            .setMimeType(loaded.mimeType);
          textureCache.set(bestMatch.imgPath, texture);
        }
        bestMatch.setter(mat, texture);
        consumedTextures.add(bestMatch.imgPath);
        injectedCount++;
        console.log(`    [proximity] Matched ${path.basename(bestMatch.imgPath)} → ${mat.getName()} (score: ${bestScore})`);
      }
    }
  }

  if (injectedCount > 0) {
    await io.write(glbPath, document);
  }

  return { injectedCount, consumedTextures };
}
