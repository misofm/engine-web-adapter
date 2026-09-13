import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const source = resolve(repository, "native/sha256.c");
const generated = resolve(repository, "src/stems/sha256-wasm.ts");
const manifestPath = resolve(repository, "src/stems/sha256-wasm.manifest.json");
const buildRoot = resolve(repository, ".cache/sha256-wasm-build");
const emscriptenRoot =
  process.env.CODEC_EMSCRIPTEN_ROOT ??
  "/data/codec-tooling/emsdk/upstream/emscripten";
const emcc = resolve(emscriptenRoot, "emcc");
const wasmLd = resolve(emscriptenRoot, "../bin/wasm-ld");
const wasmOpt = resolve(emscriptenRoot, "../bin/wasm-opt");
const emsdkRoot = resolve(emscriptenRoot, "../..");

const EMCC_VERSION = "6.0.9";
const EMCC_COMMIT = "4e4223852a0835923411059a3929907d7df1232e";
const SDK_TAG_COMMIT = "5eb0bde7585670252e8ba05e9d361627bffd08b5";
const SDK_RELEASES_COMMIT = "f04ea239d533260dd1db760dd2d668d5f9a88d6b";
const WASM_OPT_VERSION = "wasm-opt version 132 (version_132-49-gd03c25ea4)";
const MEMORY_BYTES = 64 * 1024;
const SCRATCH_BYTES = 16 * 1024;
const STATE_OFFSET = 0;
// wasm-ld places the fixed round constants immediately below the stack when
// --stack-first is used. Keep the host state and input scratch away from both.
const INPUT_OFFSET = 16 * 1024;
const STACK_BYTES = 4 * 1024;
const SELECTED_VARIANT = "simd";
const reproducibleEnv = {
  SOURCE_DATE_EPOCH: "1735689600",
  ZERO_AR_DATE: "1",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function run(command, args, cwd = repository, env = {}) {
  const { stdout, stderr } = await exec(command, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stderr.length > 0) process.stderr.write(stderr);
  return stdout;
}

async function verifyToolchain() {
  const version = await run(emcc, ["--version"]);
  if (
    !version.includes(
      `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${EMCC_VERSION}`,
    ) ||
    !version.includes(EMCC_COMMIT)
  ) {
    throw new Error(`unexpected compiler version:\n${version}`);
  }
  const sdkCommit = (await run("git", ["rev-parse", "HEAD"], emsdkRoot)).trim();
  if (sdkCommit !== SDK_TAG_COMMIT) {
    throw new Error(`unexpected emsdk checkout commit: ${sdkCommit}`);
  }
  const releases = JSON.parse(
    await readFile(resolve(emsdkRoot, "emscripten-releases-tags.json"), "utf8"),
  );
  if (releases.releases?.[EMCC_VERSION] !== SDK_RELEASES_COMMIT) {
    throw new Error(`emsdk release mapping for ${EMCC_VERSION} is not pinned`);
  }
  const wasmOptVersion = (await run(wasmOpt, ["--version"])).trim();
  if (wasmOptVersion !== WASM_OPT_VERSION) {
    throw new Error(`unexpected wasm-opt version: ${wasmOptVersion}`);
  }
}

async function compileVariant(variant) {
  const variantRoot = resolve(buildRoot, variant);
  await mkdir(variantRoot, { recursive: true });
  const object = resolve(variantRoot, "sha256.o");
  const rawOutput = resolve(variantRoot, "sha256.raw.wasm");
  const output = resolve(variantRoot, "sha256.wasm");
  const common = [
    "-O3",
    "-ffreestanding",
    "-fno-builtin",
    "-nostdlib",
    ...(variant === "simd" ? ["-msimd128", "-DSHA256_SIMD=1"] : ["-DSHA256_SIMD=0"]),
  ];
  await run(emcc, [...common, "-c", source, "-o", object], repository, reproducibleEnv);
  await run(wasmLd, [
    "--no-entry",
    "--export-memory",
    `--initial-memory=${MEMORY_BYTES}`,
    `--max-memory=${MEMORY_BYTES}`,
    "--stack-first",
    `-zstack-size=${STACK_BYTES}`,
    "--strip-all",
    "--export=sha256_compress",
    "-o",
    rawOutput,
    object,
  ], repository, reproducibleEnv);
  await run(wasmOpt, [
    rawOutput,
    ...(variant === "simd" ? ["--enable-simd"] : []),
    "-O3",
    "--strip-debug",
    "-o",
    output,
  ], repository, reproducibleEnv);
  return new Uint8Array(await readFile(output));
}

function moduleShape(bytes) {
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module)
    .map(({ module: moduleName, name, kind }) => `${moduleName}.${name}:${kind}`)
    .sort();
  const exports = WebAssembly.Module.exports(module)
    .map(({ name, kind }) => `${name}:${kind}`)
    .sort();
  const expectedImports = [];
  const expectedExports = ["memory:memory", "sha256_compress:function"];
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
    throw new Error(`unexpected SHA Wasm imports: ${imports.join(", ")}`);
  }
  if (JSON.stringify(exports) !== JSON.stringify(expectedExports)) {
    throw new Error(`unexpected SHA Wasm exports: ${exports.join(", ")}`);
  }
  const instance = new WebAssembly.Instance(module);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory) || memory.buffer.byteLength !== MEMORY_BYTES) {
    throw new Error("SHA Wasm memory is not fixed at one 64 KiB page");
  }
  assertNoGrowth(memory);
  return { imports, exports };
}

function assertNoGrowth(memory) {
  try {
    memory.grow(1);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return;
  }
  throw new Error("SHA Wasm memory unexpectedly grows");
}

function generatedSource(bytes, hash) {
  const values = Array.from(bytes, (byte) => `0x${byte.toString(16).padStart(2, "0")}`);
  const lines = [];
  for (let index = 0; index < values.length; index += 20) {
    lines.push(`  ${values.slice(index, index + 20).join(", ")},`);
  }
  return `// Generated by scripts/build-sha256-wasm.mjs; do not edit.\n` +
    `export const SHA256_WASM_VARIANT = "${SELECTED_VARIANT}" as const;\n` +
    `export const SHA256_WASM_SHA256 = "${hash}";\n` +
    `export const SHA256_WASM_BYTES = Uint8Array.from([\n${lines.join("\n")}\n]);\n`;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--verify" && mode !== "--update") {
    throw new Error("usage: node scripts/build-sha256-wasm.mjs --verify|--update");
  }
  await verifyToolchain();
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  const sourceBytes = new Uint8Array(await readFile(source));
  const variants = {
    scalar: await compileVariant("scalar"),
    simd: await compileVariant("simd"),
  };
  const selected = variants[SELECTED_VARIANT];
  const selectedHash = sha256(selected);
  const shapes = Object.fromEntries(
    Object.entries(variants).map(([variant, bytes]) => [variant, moduleShape(bytes)]),
  );
  const shape = shapes[SELECTED_VARIANT];
  const manifest = {
    asset: "src/stems/sha256-wasm.ts",
    assetSha256: selectedHash,
    source: "native/sha256.c",
    sourceSha256: sha256(sourceBytes),
    emscripten: {
      version: EMCC_VERSION,
      compilerCommit: EMCC_COMMIT,
      sdkTagCommit: SDK_TAG_COMMIT,
      sdkReleasesCommit: SDK_RELEASES_COMMIT,
      wasmOptVersion: WASM_OPT_VERSION,
    },
    build: {
      selectedVariant: SELECTED_VARIANT,
      compilerFlags: ["-O3", "-ffreestanding", "-fno-builtin", "-nostdlib"],
      selectedCompilerFlags: ["-msimd128", "-DSHA256_SIMD=1"],
      wasmFeatures: ["simd128"],
      initialMemoryBytes: MEMORY_BYTES,
      maximumMemoryBytes: MEMORY_BYTES,
      stackBytes: STACK_BYTES,
      stateOffset: STATE_OFFSET,
      inputOffset: INPUT_OFFSET,
      scratchBytes: SCRATCH_BYTES,
      batchBytes: SCRATCH_BYTES,
      imports: shape.imports,
      exports: shape.exports,
    },
  };
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const generatedText = generatedSource(selected, selectedHash);
  if (mode === "--update") {
    await mkdir(dirname(generated), { recursive: true });
    await writeFile(generated, generatedText);
    await writeFile(manifestPath, serializedManifest);
    process.stdout.write(`updated ${generated} (${selectedHash})\n`);
    return;
  }
  const [checkedGenerated, checkedManifest] = await Promise.all([
    readFile(generated, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  if (checkedGenerated !== generatedText || checkedManifest !== serializedManifest) {
    throw new Error(
      "rebuilt SHA Wasm does not match the checked-in generated module/manifest; run build:sha256:wasm:update intentionally",
    );
  }
  process.stdout.write(`verified ${generated} (${selectedHash})\n`);
}

await main();
