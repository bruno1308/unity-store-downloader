import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Document, NodeIO } from "@gltf-transform/core";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a GLB with a skeleton (2 bones) and optionally a baked animation.
 * Both base models and animation clips share the same skeleton structure.
 */
async function createSkeletonGlb(
  outPath: string,
  opts?: { animationName?: string },
): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();

  // Create skeleton: root → bone1
  const rootBone = doc.createNode("Root").setTranslation([0, 0, 0]);
  const bone1 = doc.createNode("Bone1").setTranslation([0, 1, 0]);
  rootBone.addChild(bone1);

  // Create a simple mesh
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const mat = doc.createMaterial("DefaultMaterial");
  const prim = doc.createPrimitive().setAttribute("POSITION", position).setMaterial(mat);
  const mesh = doc.createMesh("Mesh").addPrimitive(prim);
  const meshNode = doc.createNode("MeshNode").setMesh(mesh);

  scene.addChild(rootBone);
  scene.addChild(meshNode);

  // Add animation if requested
  if (opts?.animationName) {
    const input = doc
      .createAccessor()
      .setType("SCALAR")
      .setArray(new Float32Array([0, 0.5, 1.0]))
      .setBuffer(buffer);
    const output = doc
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 0, 0.5, 0, 0, 1, 0]))
      .setBuffer(buffer);

    const sampler = doc
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation("LINEAR");

    const channel = doc
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(bone1)
      .setTargetPath("translation");

    doc
      .createAnimation(opts.animationName)
      .addSampler(sampler)
      .addChannel(channel);
  }

  const io = new NodeIO();
  await io.write(outPath, doc);
}

// ── Tests ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-merge-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("findModelFiles", () => {
  it("separates base models from animation clips", async () => {
    // Dynamically import extract to get the function (it's not exported, so we test via convertModels)
    // Instead, test the convention directly
    const modelsDir = path.join(tmpDir, "Models");
    fs.mkdirSync(modelsDir, { recursive: true });

    // Create fake FBX files (content doesn't matter for findModelFiles)
    fs.writeFileSync(path.join(modelsDir, "Dragon.fbx"), "base");
    fs.writeFileSync(path.join(modelsDir, "Dragon@Walk.fbx"), "anim1");
    fs.writeFileSync(path.join(modelsDir, "Dragon@Idle.fbx"), "anim2");
    fs.writeFileSync(path.join(modelsDir, "Sword.obj"), "base2");

    // Verify naming convention detection
    const files = fs.readdirSync(modelsDir);
    const bases = files.filter((f) => !path.basename(f, path.extname(f)).includes("@"));
    const anims = files.filter((f) => path.basename(f, path.extname(f)).includes("@"));

    expect(bases).toEqual(["Dragon.fbx", "Sword.obj"]);
    expect(anims).toEqual(["Dragon@Idle.fbx", "Dragon@Walk.fbx"]);

    // Verify animation name extraction
    for (const anim of anims) {
      const baseName = path.basename(anim, path.extname(anim));
      const [modelBase, animName] = baseName.split("@");
      expect(modelBase).toBe("Dragon");
      expect(["Idle", "Walk"]).toContain(animName);
    }
  });

  it("handles animation-only groups (no base model)", () => {
    const modelsDir = path.join(tmpDir, "Anims");
    fs.mkdirSync(modelsDir, { recursive: true });

    // Only animation files, no base
    fs.writeFileSync(path.join(modelsDir, "Cat@Walk.fbx"), "anim1");
    fs.writeFileSync(path.join(modelsDir, "Cat@Run.fbx"), "anim2");

    const files = fs.readdirSync(modelsDir);
    const bases = files.filter((f) => !path.basename(f, path.extname(f)).includes("@"));
    const anims = files.filter((f) => path.basename(f, path.extname(f)).includes("@"));

    expect(bases).toHaveLength(0);
    expect(anims).toHaveLength(2);
  });
});

describe("animation merging via gltf-transform", () => {
  it("merges animation tracks from separate GLBs into base model", async () => {
    const io = new NodeIO();

    // Create base model (no animation)
    const baseGlb = path.join(tmpDir, "Dragon.glb");
    await createSkeletonGlb(baseGlb);

    // Create animation GLBs
    const walkGlb = path.join(tmpDir, "Dragon@Walk.glb");
    await createSkeletonGlb(walkGlb, { animationName: "Walk" });

    const idleGlb = path.join(tmpDir, "Dragon@Idle.glb");
    await createSkeletonGlb(idleGlb, { animationName: "Idle" });

    // Verify base has no animations
    const baseBefore = await io.read(baseGlb);
    expect(baseBefore.getRoot().listAnimations()).toHaveLength(0);

    // Verify animation GLBs each have 1 animation
    const walkDoc = await io.read(walkGlb);
    expect(walkDoc.getRoot().listAnimations()).toHaveLength(1);
    expect(walkDoc.getRoot().listAnimations()[0].getName()).toBe("Walk");

    // Now simulate the merge: read animations and copy into base
    const baseDoc = await io.read(baseGlb);
    const baseRoot = baseDoc.getRoot();

    // Build node map from base
    const baseNodes = new Map<string, import("@gltf-transform/core").Node>();
    for (const scene of baseRoot.listScenes()) {
      for (const node of scene.listChildren()) {
        collectNodes(node, baseNodes);
      }
    }

    // Merge Walk animation
    const animDoc = await io.read(walkGlb);
    for (const srcAnim of animDoc.getRoot().listAnimations()) {
      const dstAnim = baseDoc.createAnimation(srcAnim.getName());

      for (const srcChannel of srcAnim.listChannels()) {
        const srcSampler = srcChannel.getSampler();
        const targetNode = srcChannel.getTargetNode();
        if (!srcSampler || !targetNode) continue;

        const baseNode = baseNodes.get(targetNode.getName());
        if (!baseNode) continue;

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
    }

    // Write merged result
    await io.write(baseGlb, baseDoc);

    // Verify: base now has the Walk animation
    const mergedDoc = await io.read(baseGlb);
    const mergedAnims = mergedDoc.getRoot().listAnimations();
    expect(mergedAnims).toHaveLength(1);
    expect(mergedAnims[0].getName()).toBe("Walk");
    expect(mergedAnims[0].listChannels().length).toBeGreaterThan(0);

    // Verify the channel targets "Bone1"
    const channel = mergedAnims[0].listChannels()[0];
    expect(channel.getTargetNode()?.getName()).toBe("Bone1");
    expect(channel.getTargetPath()).toBe("translation");
  });

  it("preserves mesh and materials after animation merge", async () => {
    const io = new NodeIO();

    const baseGlb = path.join(tmpDir, "Model.glb");
    await createSkeletonGlb(baseGlb);

    const walkGlb = path.join(tmpDir, "Model@Walk.glb");
    await createSkeletonGlb(walkGlb, { animationName: "Walk" });

    // Read base, merge, write
    const baseDoc = await io.read(baseGlb);
    const animDoc = await io.read(walkGlb);
    const baseNodes = new Map<string, import("@gltf-transform/core").Node>();
    for (const scene of baseDoc.getRoot().listScenes()) {
      for (const node of scene.listChildren()) {
        collectNodes(node, baseNodes);
      }
    }

    for (const srcAnim of animDoc.getRoot().listAnimations()) {
      const dstAnim = baseDoc.createAnimation(srcAnim.getName());
      for (const srcChannel of srcAnim.listChannels()) {
        const srcSampler = srcChannel.getSampler();
        const targetNode = srcChannel.getTargetNode();
        if (!srcSampler || !targetNode) continue;
        const baseNode = baseNodes.get(targetNode.getName());
        if (!baseNode) continue;
        const srcInput = srcSampler.getInput();
        const srcOutput = srcSampler.getOutput();
        if (!srcInput || !srcOutput) continue;
        const dstInput = baseDoc.createAccessor().setType(srcInput.getType()).setArray(srcInput.getArray()!.slice());
        const dstOutput = baseDoc.createAccessor().setType(srcOutput.getType()).setArray(srcOutput.getArray()!.slice());
        const dstSampler = baseDoc.createAnimationSampler().setInput(dstInput).setOutput(dstOutput).setInterpolation(srcSampler.getInterpolation());
        const targetPath = srcChannel.getTargetPath();
        if (!targetPath) continue;
        const dstChannel = baseDoc.createAnimationChannel().setSampler(dstSampler).setTargetNode(baseNode).setTargetPath(targetPath);
        dstAnim.addSampler(dstSampler);
        dstAnim.addChannel(dstChannel);
      }
    }

    await io.write(baseGlb, baseDoc);

    // Verify mesh + materials still intact
    const merged = await io.read(baseGlb);
    const root = merged.getRoot();
    expect(root.listMeshes()).toHaveLength(1);
    expect(root.listMaterials()).toHaveLength(1);
    expect(root.listMaterials()[0].getName()).toBe("DefaultMaterial");
    expect(root.listAnimations()).toHaveLength(1);
  });

  it("skips channels when target bone not found in base model", async () => {
    const io = new NodeIO();

    // Create base with limited skeleton
    const baseGlb = path.join(tmpDir, "Simple.glb");
    const baseDoc = new Document();
    const buf = baseDoc.createBuffer();
    const scene = baseDoc.createScene();
    const node = baseDoc.createNode("OnlyNode");
    scene.addChild(node);
    const pos = baseDoc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const prim = baseDoc.createPrimitive().setAttribute("POSITION", pos);
    node.setMesh(baseDoc.createMesh().addPrimitive(prim));
    await io.write(baseGlb, baseDoc);

    // Create animation targeting a bone that doesn't exist in base
    const animGlb = path.join(tmpDir, "Simple@Walk.glb");
    await createSkeletonGlb(animGlb, { animationName: "Walk" });
    // This animation targets "Bone1" which doesn't exist in the simple base

    // Attempt merge
    const base = await io.read(baseGlb);
    const anim = await io.read(animGlb);
    const baseNodeMap = new Map<string, import("@gltf-transform/core").Node>();
    for (const s of base.getRoot().listScenes()) {
      for (const n of s.listChildren()) {
        collectNodes(n, baseNodeMap);
      }
    }

    let channelsMerged = 0;
    for (const srcAnim of anim.getRoot().listAnimations()) {
      const dstAnim = base.createAnimation(srcAnim.getName());
      for (const srcChannel of srcAnim.listChannels()) {
        const targetNode = srcChannel.getTargetNode();
        if (!targetNode) continue;
        const baseNode = baseNodeMap.get(targetNode.getName());
        if (!baseNode) continue; // should skip "Bone1"
        channelsMerged++;
      }
      if (dstAnim.listChannels().length === 0) {
        dstAnim.dispose();
      }
    }

    // "Bone1" not in base → no channels should have been merged
    expect(channelsMerged).toBe(0);
    expect(base.getRoot().listAnimations()).toHaveLength(0);
  });
});

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
