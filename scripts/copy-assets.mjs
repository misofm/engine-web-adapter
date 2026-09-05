import { build } from "vite";
import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/internal/engine-web-flac-decoder.wasm", import.meta.url),
  new URL("../dist/internal/engine-web-flac-decoder.wasm", import.meta.url),
);

// Factory overrides receive an asset URL, so this entry must carry its imports.
await build({
  configFile: false,
  build: {
    emptyOutDir: false,
    outDir: "dist/internal",
    minify: false,
    lib: { entry: "src/internal/engine-web-opfs-worker.ts", formats: ["es"], fileName: () => "engine-web-opfs-worker.js" },
  },
});
