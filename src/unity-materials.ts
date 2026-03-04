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
): Promise<number> {
  // 1. Find and parse all .mat files
  const matFiles = findFiles(assetDir, new Set([".mat"]));
  if (matFiles.length === 0) return 0;

  const parsedMaterials = new Map<string, UnityTextureRef[]>();
  for (const matFile of matFiles) {
    const content = fs.readFileSync(matFile, "utf-8");
    const parsed = parseUnityMaterial(content);
    if (parsed && parsed.textures.length > 0) {
      parsedMaterials.set(normalizeMaterialName(parsed.name), parsed.textures);
    }
  }
  if (parsedMaterials.size === 0) return 0;

  // 2. Read GLB
  const io = new NodeIO();
  const document = await io.read(glbPath);
  const root = document.getRoot();

  // 3. Match and inject textures
  let injectedCount = 0;
  const textureCache = new Map<string, Texture>(); // GUID → reusable Texture node

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

      setter(material, texture);
      injectedCount++;
    }
  }

  // 4. Write back if any textures were injected
  if (injectedCount > 0) {
    await io.write(glbPath, document);
  }

  return injectedCount;
}
