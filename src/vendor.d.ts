declare module "fbx2gltf" {
  function fbx2gltf(
    srcFile: string,
    destFile: string,
    opts?: string[],
  ): Promise<string>;
  export default fbx2gltf;
}

declare module "obj2gltf" {
  function obj2gltf(
    objPath: string,
    options?: { binary?: boolean },
  ): Promise<Buffer>;
  export default obj2gltf;
}
