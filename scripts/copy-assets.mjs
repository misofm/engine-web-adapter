import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/internal/engine-web-flac-decoder.wasm", import.meta.url),
  new URL("../dist/internal/engine-web-flac-decoder.wasm", import.meta.url),
);
