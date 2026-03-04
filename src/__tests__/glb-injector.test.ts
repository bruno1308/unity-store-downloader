import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  loadAndConvertTexture,
  resolveUnityMaterials,
} from "../unity-materials.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a 1x1 red PNG pixel (smallest valid PNG). */
function createTinyPng(): Buffer {
  // Minimal 1x1 red PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==",
    "base64",
  );
  return png;
}

/** Create a minimal GLB with named materials (no textures). */
async function createTestGlb(
  outPath: string,
  materialNames: string[],
): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();

  for (const name of materialNames) {
    const mat = doc.createMaterial(name);
    mat.setBaseColorFactor([0.5, 0.5, 0.5, 1.0]);

    // Create a trivial mesh referencing this material
    const position = doc
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);

    const prim = doc.createPrimitive().setAttribute("POSITION", position).setMaterial(mat);
    const mesh = doc.createMesh(name + "_mesh").addPrimitive(prim);
    const node = doc.createNode(name + "_node").setMesh(mesh);
    scene.addChild(node);
  }

  const io = new NodeIO();
  await io.write(outPath, doc);
}

/** Write a minimal Unity .mat file. */
function writeMat(dir: string, name: string, textures: Record<string, string>): void {
  const texEntries = Object.entries(textures)
    .map(
      ([slot, guid]) => `    - ${slot}:
        m_Texture: {fileID: 2800000, guid: ${guid}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}`,
    )
    .join("\n");

  const content = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 6
  m_Name: ${name}
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
${texEntries}
    m_Floats:
    - _Cutoff: 0.5`;

  const matDir = path.join(dir, "Materials");
  fs.mkdirSync(matDir, { recursive: true });
  fs.writeFileSync(path.join(matDir, `${name}.mat`), content);
}

// ── Tests ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glb-inject-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadAndConvertTexture", () => {
  it("loads PNG directly", async () => {
    const pngPath = path.join(tmpDir, "test.png");
    fs.writeFileSync(pngPath, createTinyPng());

    const result = await loadAndConvertTexture(pngPath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/png");
    expect(result!.buffer.length).toBeGreaterThan(0);
  });

  it("loads JPEG directly", async () => {
    // Create a minimal JPEG via sharp is complex, just test the path logic
    const jpgPath = path.join(tmpDir, "test.jpg");
    fs.writeFileSync(jpgPath, createTinyPng()); // Not a real JPEG but tests the branch

    const result = await loadAndConvertTexture(jpgPath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/jpeg");
  });

  it("returns null for missing file", async () => {
    const result = await loadAndConvertTexture("/nonexistent/file.png");
    expect(result).toBeNull();
  });

  it("returns null for unsupported extension", async () => {
    const txtPath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(txtPath, "not an image");

    const result = await loadAndConvertTexture(txtPath);
    expect(result).toBeNull();
  });
});

describe("resolveUnityMaterials", () => {
  it("injects textures into matching GLB materials", async () => {
    const glbPath = path.join(tmpDir, "test.glb");
    await createTestGlb(glbPath, ["WoodFloor", "BrickWall"]);

    // Write texture file
    const texRelPath = "Textures/wood_diffuse.png";
    const texDir = path.join(tmpDir, "Textures");
    fs.mkdirSync(texDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, texRelPath), createTinyPng());

    // Write .mat that references texture by GUID
    const guid = "aabbccdd11223344aabbccdd11223344";
    writeMat(tmpDir, "WoodFloor", { _MainTex: guid });

    // Build GUID map
    const guidMap = new Map<string, string>();
    guidMap.set(guid, texRelPath);

    const count = await resolveUnityMaterials(glbPath, tmpDir, guidMap);
    expect(count).toBe(1);

    // Verify the GLB now has a texture on WoodFloor
    const io = new NodeIO();
    const doc = await io.read(glbPath);
    const materials = doc.getRoot().listMaterials();
    const woodFloor = materials.find((m) => m.getName() === "WoodFloor");
    expect(woodFloor).toBeDefined();
    expect(woodFloor!.getBaseColorTexture()).not.toBeNull();

    // BrickWall should have no texture (no .mat for it)
    const brickWall = materials.find((m) => m.getName() === "BrickWall");
    expect(brickWall).toBeDefined();
    expect(brickWall!.getBaseColorTexture()).toBeNull();
  });

  it("returns 0 when no .mat files exist", async () => {
    const glbPath = path.join(tmpDir, "test.glb");
    await createTestGlb(glbPath, ["SomeMaterial"]);

    const count = await resolveUnityMaterials(glbPath, tmpDir, new Map());
    expect(count).toBe(0);
  });

  it("deduplicates textures when multiple materials reference same GUID", async () => {
    const glbPath = path.join(tmpDir, "test.glb");
    await createTestGlb(glbPath, ["MatA", "MatB"]);

    // Same texture GUID for both materials
    const guid = "1111222233334444555566667777888e";
    const texRelPath = "Textures/shared.png";
    fs.mkdirSync(path.join(tmpDir, "Textures"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, texRelPath), createTinyPng());

    writeMat(tmpDir, "MatA", { _MainTex: guid });

    // Write second .mat in a different subdir to avoid filename collision
    const matDir2 = path.join(tmpDir, "Materials2");
    fs.mkdirSync(matDir2, { recursive: true });
    fs.writeFileSync(
      path.join(matDir2, "MatB.mat"),
      `%YAML 1.1
--- !u!21 &2100000
Material:
  m_Name: MatB
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${guid}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _Cutoff: 0.5`,
    );

    const guidMap = new Map<string, string>();
    guidMap.set(guid, texRelPath);

    const count = await resolveUnityMaterials(glbPath, tmpDir, guidMap);
    expect(count).toBe(2); // Two material assignments

    // Verify both materials have textures
    const io = new NodeIO();
    const doc = await io.read(glbPath);
    const textures = doc.getRoot().listTextures();
    // Only ONE texture node should exist (deduped)
    expect(textures).toHaveLength(1);

    // Both materials should reference it
    const materials = doc.getRoot().listMaterials();
    for (const mat of materials) {
      expect(mat.getBaseColorTexture()).not.toBeNull();
    }
  });

  it("matches material names case-insensitively and strips (Instance) suffix", async () => {
    const glbPath = path.join(tmpDir, "test.glb");
    await createTestGlb(glbPath, ["MyMaterial (Instance)"]);

    const guid = "aaaa1111bbbb2222cccc3333dddd4444";
    const texRelPath = "Textures/tex.png";
    fs.mkdirSync(path.join(tmpDir, "Textures"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, texRelPath), createTinyPng());

    // .mat uses "mymaterial" (lowercase, no Instance suffix)
    writeMat(tmpDir, "mymaterial", { _MainTex: guid });

    const guidMap = new Map<string, string>();
    guidMap.set(guid, texRelPath);

    const count = await resolveUnityMaterials(glbPath, tmpDir, guidMap);
    expect(count).toBe(1);
  });
});
