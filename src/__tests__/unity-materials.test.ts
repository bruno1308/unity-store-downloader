import { describe, it, expect } from "vitest";
import { parseUnityMaterial } from "../unity-materials.js";

// ── Real .mat fixtures from POLYGON city pack ────────────────────────────

const MAT_WITH_TEXTURES = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 6
  m_ObjectHideFlags: 0
  m_PrefabParentObject: {fileID: 0}
  m_PrefabInternal: {fileID: 0}
  m_Name: air conditioner roof
  m_Shader: {fileID: 46, guid: 0000000000000000f000000000000000, type: 0}
  m_ShaderKeywords: _NORMALMAP
  m_LightmapFlags: 4
  m_EnableInstancingVariants: 0
  m_DoubleSidedGI: 0
  m_CustomRenderQueue: -1
  stringTagMap: {}
  disabledShaderPasses: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _BumpMap:
        m_Texture: {fileID: 2800000, guid: a1b2c3d4e5f67890a1b2c3d4e5f67890, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _DetailAlbedoMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: 3d103ca190f8b1f43ba15dda71097d0a, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _EmissionMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _MetallicGlossMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _OcclusionMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _BumpScale: 1
    - _Cutoff: 0.5`;

const MAT_FLAT_COLOR = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 6
  m_ObjectHideFlags: 0
  m_PrefabParentObject: {fileID: 0}
  m_PrefabInternal: {fileID: 0}
  m_Name: A
  m_Shader: {fileID: 46, guid: 0000000000000000f000000000000000, type: 0}
  m_ShaderKeywords:
  m_LightmapFlags: 4
  m_EnableInstancingVariants: 0
  m_DoubleSidedGI: 0
  m_CustomRenderQueue: -1
  stringTagMap: {}
  disabledShaderPasses: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _BumpMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _MainTex:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _OcclusionMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _BumpScale: 1`;

const MAT_WITH_ZERO_GUID = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 6
  m_Name: test_material
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: 00000000000000000000000000000000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _BumpScale: 1`;

const MAT_SPECIAL_NAME = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 6
  m_Name: Brick Wall (Damaged) #2
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: abcdef1234567890abcdef1234567890, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _Cutoff: 0.5`;

// ── Tests ────────────────────────────────────────────────────────────────

describe("parseUnityMaterial", () => {
  it("parses .mat with _MainTex + _BumpMap GUIDs", () => {
    const result = parseUnityMaterial(MAT_WITH_TEXTURES);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("air conditioner roof");
    expect(result!.textures).toHaveLength(2);

    const mainTex = result!.textures.find((t) => t.slotName === "_MainTex");
    expect(mainTex).toBeDefined();
    expect(mainTex!.guid).toBe("3d103ca190f8b1f43ba15dda71097d0a");

    const bumpMap = result!.textures.find((t) => t.slotName === "_BumpMap");
    expect(bumpMap).toBeDefined();
    expect(bumpMap!.guid).toBe("a1b2c3d4e5f67890a1b2c3d4e5f67890");
  });

  it("returns empty textures for flat-color materials (all {fileID: 0})", () => {
    const result = parseUnityMaterial(MAT_FLAT_COLOR);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("A");
    expect(result!.textures).toHaveLength(0);
  });

  it("skips zero GUIDs (00000000...)", () => {
    const result = parseUnityMaterial(MAT_WITH_ZERO_GUID);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test_material");
    expect(result!.textures).toHaveLength(0);
  });

  it("handles m_Name with special characters", () => {
    const result = parseUnityMaterial(MAT_SPECIAL_NAME);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Brick Wall (Damaged) #2");
    expect(result!.textures).toHaveLength(1);
    expect(result!.textures[0].slotName).toBe("_MainTex");
    expect(result!.textures[0].guid).toBe("abcdef1234567890abcdef1234567890");
  });

  it("returns null for unparseable content", () => {
    expect(parseUnityMaterial("")).toBeNull();
    expect(parseUnityMaterial("not a unity material")).toBeNull();
    expect(parseUnityMaterial("{ invalid json }")).toBeNull();
  });

  it("handles material with all five supported slots", () => {
    const mat = `%YAML 1.1
--- !u!21 &2100000
Material:
  m_Name: FullPBR
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _BumpMap:
        m_Texture: {fileID: 2800000, guid: bbbb0000bbbb0000bbbb0000bbbb0000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _EmissionMap:
        m_Texture: {fileID: 2800000, guid: cccc0000cccc0000cccc0000cccc0000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _OcclusionMap:
        m_Texture: {fileID: 2800000, guid: dddd0000dddd0000dddd0000dddd0000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _MetallicGlossMap:
        m_Texture: {fileID: 2800000, guid: eeee0000eeee0000eeee0000eeee0000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _Cutoff: 0.5`;

    const result = parseUnityMaterial(mat);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("FullPBR");
    expect(result!.textures).toHaveLength(5);

    const slots = result!.textures.map((t) => t.slotName).sort();
    expect(slots).toEqual([
      "_BumpMap",
      "_EmissionMap",
      "_MainTex",
      "_MetallicGlossMap",
      "_OcclusionMap",
    ]);
  });
});
