import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const nativeRoot = resolve(repository, "native/blake3");
const generated = resolve(repository, "src/stems/blake3-wasm.ts");
const manifestPath = resolve(repository, "src/stems/blake3-wasm.manifest.json");
const buildRoot = resolve(repository, ".cache/blake3-wasm-build");
const target = "wasm32-unknown-unknown";
const rustToolchain = "1.97.1";
const memoryBytes = 128 * 1024;
const stackBytes = 64 * 1024;
const inputBytes = 16 * 1024;
const outputBytes = 32;
const rustFlags = [
  "-C", "target-feature=+simd128",
  "-C", "link-arg=--no-entry",
  "-C", "link-arg=--export-memory",
  "-C", "link-arg=--initial-memory=131072",
  "-C", "link-arg=--max-memory=131072",
  "-C", "link-arg=--stack-first",
  "-C", "link-arg=-zstack-size=65536",
  "--remap-path-prefix=" + nativeRoot + "=/native/blake3",
];
const upstream = {
  crate: "blake3",
  version: "1.8.7",
  tag: "1.8.7",
  commit: "f3149ec5bb5449af877ba20377a11008ff499fa2",
  archiveBytes: 209_726,
  archiveSha256: "6d9e454fc11f76977dc803893aff6304ed33d6a26efae8696573bea74baa27ae",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function run(command, args, cwd = repository, env = {}) {
  const result = await exec(command, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.stdout;
}

async function verifyToolchain() {
  const rustc = await run("rustc", ["+" + rustToolchain, "-vV"]);
  if (
    !rustc.includes("rustc 1.97.1 ") ||
    !rustc.includes("commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452") ||
    !rustc.includes(`host: x86_64-unknown-linux-gnu`)
  ) {
    throw new Error(`unexpected rustc identity:\n${rustc}`);
  }
  const cargo = (await run("cargo", ["+" + rustToolchain, "-V"])).trim();
  if (cargo !== "cargo 1.97.1 (c980f4866 2026-06-30)") {
    throw new Error(`unexpected cargo identity: ${cargo}`);
  }
  const targets = await run("rustup", ["target", "list", "--toolchain", rustToolchain, "--installed"]);
  if (!targets.split(/\s+/u).includes(target)) {
    throw new Error(`${target} is not installed`);
  }
  return {
    rustc: "rustc 1.97.1 (8bab26f4f 2026-07-14)",
    rustcCommit: "8bab26f4f68e0e26f0bb7960be334d5b520ea452",
    cargo,
    target,
  };
}

async function compile(buildDirectory) {
  await mkdir(buildDirectory, { recursive: true });
  await run(
    "cargo",
    ["+" + rustToolchain, "build", "--release", "--locked", "--offline", "--target", target],
    nativeRoot,
    {
      CARGO_TARGET_DIR: resolve(buildDirectory, "target"),
      RUSTFLAGS: rustFlags.join(" "),
    },
  );
  return new Uint8Array(
    await readFile(
      resolve(buildDirectory, "target", target, "release/miso_blake3_wasm.wasm"),
    ),
  );
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
  const expectedExports = [
    "blake3_finalize:function",
    "blake3_init:function",
    "blake3_input_capacity:function",
    "blake3_input_ptr:function",
    "blake3_output_len:function",
    "blake3_output_ptr:function",
    "blake3_update:function",
    "memory:memory",
  ];
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
    throw new Error(`unexpected BLAKE3 Wasm imports: ${imports.join(", ")}`);
  }
  if (JSON.stringify(exports) !== JSON.stringify(expectedExports)) {
    throw new Error(`unexpected BLAKE3 Wasm exports: ${exports.join(", ")}`);
  }
  const instance = new WebAssembly.Instance(module);
  const wasmExports = instance.exports;
  const memory = wasmExports.memory;
  if (!(memory instanceof WebAssembly.Memory) || memory.buffer.byteLength !== memoryBytes) {
    throw new Error("BLAKE3 Wasm memory is not fixed at 128 KiB");
  }
  let grew = false;
  try {
    memory.grow(1);
    grew = true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  if (grew || memory.buffer.byteLength !== memoryBytes) {
    throw new Error("BLAKE3 Wasm memory unexpectedly grows");
  }
  const inputPtr = wasmExports.blake3_input_ptr();
  const outputPtr = wasmExports.blake3_output_ptr();
  const inputCapacity = wasmExports.blake3_input_capacity();
  const actualOutputBytes = wasmExports.blake3_output_len();
  if (
    !Number.isInteger(inputPtr) ||
    !Number.isInteger(outputPtr) ||
    inputPtr < 0 ||
    outputPtr < 0 ||
    inputCapacity !== inputBytes ||
    actualOutputBytes !== outputBytes ||
    inputPtr + inputCapacity > memoryBytes ||
    outputPtr + actualOutputBytes > memoryBytes ||
    inputPtr % 16 !== 0 ||
    outputPtr % 16 !== 0 ||
    (inputPtr + inputCapacity > outputPtr && outputPtr + actualOutputBytes > inputPtr)
  ) {
    throw new Error("BLAKE3 Wasm buffer layout is outside the fixed ABI");
  }
  return {
    imports,
    exports,
    initialMemoryBytes: memory.buffer.byteLength,
    maximumMemoryBytes: memoryBytes,
    inputPtr,
    inputCapacity,
    outputPtr,
    outputBytes: actualOutputBytes,
    state: "module-owned upstream Hasher; no host pointer or serialized state",
  };
}

async function filesUnder(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(directory);
  return files.sort();
}

async function vendorIdentity() {
  const entries = [];
  for (const directory of (await readdir(resolve(nativeRoot, "vendor"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const root = resolve(nativeRoot, "vendor", directory.name);
    const checksumPath = resolve(root, ".cargo-checksum.json");
    const checksum = JSON.parse(await readFile(checksumPath, "utf8"));
    entries.push({
      directory: directory.name,
      packageSha256: checksum.package ?? null,
      checksumFileSha256: sha256(await readFile(checksumPath)),
    });
  }
  return entries;
}

async function treeHash(directory) {
  const hash = createHash("sha256");
  for (const file of await filesUnder(directory)) {
    const bytes = await readFile(file);
    hash.update(relative(directory, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function generatedSource(bytes, hash) {
  const values = Array.from(bytes, (byte) => `0x${byte.toString(16).padStart(2, "0")}`);
  const lines = [];
  for (let index = 0; index < values.length; index += 20) {
    lines.push(`  ${values.slice(index, index + 20).join(", ")},`);
  }
  return (
    "// Generated by scripts/build-blake3-wasm.mjs; do not edit.\n" +
    `export const BLAKE3_WASM_VARIANT = "official-rust-wasm32-simd" as const;\n` +
    `export const BLAKE3_WASM_SHA256 = "${hash}";\n` +
    `export const BLAKE3_WASM_BYTES = Uint8Array.from([\n${lines.join("\n")}\n]);\n`
  );
}

async function manifestFor(bytes, shape, toolchain, firstBytes) {
  const lock = await readFile(resolve(nativeRoot, "Cargo.lock"));
  const wrapper = await readFile(resolve(nativeRoot, "src/lib.rs"));
  const rustToolchainFile = await readFile(resolve(nativeRoot, "rust-toolchain.toml"));
  const cargoConfig = await readFile(resolve(nativeRoot, ".cargo/config.toml"));
  const sourceTree = await treeHash(resolve(nativeRoot, "vendor/blake3"));
  const wasmHash = sha256(bytes);
  const licenseFiles = [
    "licenses/LICENSE_A2",
    "licenses/LICENSE_A2LLVM",
    "licenses/LICENSE_CC0",
    "vendor/arrayvec/LICENSE-APACHE",
    "vendor/arrayvec/LICENSE-MIT",
    "vendor/cfg-if/LICENSE-APACHE",
    "vendor/cfg-if/LICENSE-MIT",
    "vendor/constant_time_eq/LICENSE-APACHE",
    "vendor/constant_time_eq/LICENSE-CC0",
    "vendor/constant_time_eq/LICENSE-MIT0",
  ];
  if (wasmHash !== sha256(firstBytes)) throw new Error("reproducible BLAKE3 Wasm builds differ");
  return {
    asset: "src/stems/blake3-wasm.ts",
    assetSha256: wasmHash,
    upstream,
    source: {
      crateTreeSha256: sourceTree,
      wrapperSha256: sha256(wrapper),
      cargoLockSha256: sha256(lock),
      rustToolchainSha256: sha256(rustToolchainFile),
      cargoConfigSha256: sha256(cargoConfig),
      vendor: await vendorIdentity(),
      licenses: await Promise.all(licenseFiles.map(async (file) => ({
        file,
        sha256: sha256(await readFile(resolve(nativeRoot, file))),
      }))),
    },
    toolchain,
    build: {
      profile: {
        optLevel: 3,
        lto: true,
        codegenUnits: 1,
        panic: "abort",
      },
      rustFlags: [
        "-C target-feature=+simd128",
        "-C link-arg=--no-entry",
        "-C link-arg=--export-memory",
        "-C link-arg=--initial-memory=131072",
        "-C link-arg=--max-memory=131072",
        "-C link-arg=--stack-first",
        "-C link-arg=-zstack-size=65536",
        "--remap-path-prefix=<nativeRoot>=/native/blake3",
      ],
      wasmFeatures: ["simd128"],
      simdDegree: 4,
      initialMemoryBytes: memoryBytes,
      maximumMemoryBytes: memoryBytes,
      stackBytes,
      inputBytes,
      outputBytes,
      state: shape.state,
      imports: shape.imports,
      exports: shape.exports,
      inputPtr: shape.inputPtr,
      outputPtr: shape.outputPtr,
    },
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--verify" && mode !== "--update") {
    throw new Error("usage: node scripts/build-blake3-wasm.mjs --verify|--update");
  }
  const toolchain = await verifyToolchain();
  await rm(buildRoot, { recursive: true, force: true });
  const first = await compile(resolve(buildRoot, "first"));
  const second = await compile(resolve(buildRoot, "second"));
  const shape = moduleShape(first);
  moduleShape(second);
  const manifest = await manifestFor(first, shape, toolchain, second);
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const generatedText = generatedSource(first, manifest.assetSha256);
  if (mode === "--update") {
    await mkdir(dirname(generated), { recursive: true });
    await writeFile(generated, generatedText);
    await writeFile(manifestPath, serializedManifest);
    process.stdout.write(`updated ${generated} (${manifest.assetSha256})\n`);
    return;
  }
  const [checkedGenerated, checkedManifest] = await Promise.all([
    readFile(generated, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  if (checkedGenerated !== generatedText || checkedManifest !== serializedManifest) {
    throw new Error(
      "rebuilt BLAKE3 Wasm does not match the checked-in generated module/manifest; run build:blake3:wasm:update intentionally",
    );
  }
  process.stdout.write(`verified ${generated} (${manifest.assetSha256})\n`);
}

await main();
