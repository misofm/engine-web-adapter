import { build } from "vite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const codecAsset = new URL("../node_modules/@misofm/codec/wasm/flac-decoder.wasm", import.meta.url);
const codecBytes = await readFile(codecAsset);
const codecHash = createHash("sha256").update(codecBytes).digest("hex");
if (codecHash !== "5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925") {
  throw new Error(`installed @misofm/codec decoder asset hash ${codecHash} is not the pinned public asset`);
}

await copyFile(
  codecAsset,
  new URL("../dist/internal/engine-web-flac-decoder.wasm", import.meta.url),
);

const codecLicenseRoot = new URL("../node_modules/@misofm/codec/", import.meta.url);
const effectLicenseRoot = new URL("../node_modules/effect/", import.meta.url);
const adapterLicenseRoot = new URL("../dist/codec-licenses/", import.meta.url);
await mkdir(new URL("vendor/licenses/", adapterLicenseRoot), { recursive: true });
await copyFile(
  new URL("LICENSE", codecLicenseRoot),
  new URL("codec-LICENSE", adapterLicenseRoot),
);
await copyFile(
  new URL("LICENSE", effectLicenseRoot),
  new URL("effect-LICENSE", adapterLicenseRoot),
);
await copyFile(
  new URL("THIRD_PARTY_NOTICES.md", codecLicenseRoot),
  new URL("THIRD_PARTY_NOTICES.md", adapterLicenseRoot),
);
for (const license of ["compiler-rt.txt", "emscripten.txt", "libFLAC.txt", "musl.txt"]) {
  await copyFile(
    new URL(`vendor/licenses/${license}`, codecLicenseRoot),
    new URL(`vendor/licenses/${license}`, adapterLicenseRoot),
  );
}

// Factory overrides receive an asset URL, so these entries must carry their imports.
await build({
  configFile: false,
  logLevel: "silent",
  build: {
    emptyOutDir: false,
    outDir: "dist/internal",
    minify: true,
    lib: { entry: "src/internal/engine-web-flac-worker.ts", formats: ["es"], fileName: () => "engine-web-flac-worker.js" },
  },
});

await build({
  configFile: false,
  logLevel: "silent",
  build: {
    emptyOutDir: false,
    outDir: "dist/internal",
    minify: true,
    lib: { entry: "src/internal/engine-web-opfs-worker.ts", formats: ["es"], fileName: () => "engine-web-opfs-worker.js" },
  },
});

// Effect's defensive type error includes a documentation URL. Keep the
// browser worker artifacts free of URL literals so the package policy can
// prove that delivery endpoints are caller-owned.
for (const worker of ["engine-web-flac-worker.js", "engine-web-opfs-worker.js"]) {
  const path = new URL(`../dist/internal/${worker}`, import.meta.url);
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replaceAll("https://github.com/Effect-TS/effect/issues", "the upstream Effect issue tracker"));
}
