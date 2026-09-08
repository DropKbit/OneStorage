declare module "esbuild-wasm/lib/browser.js" {
  export * from "esbuild-wasm";
}
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
