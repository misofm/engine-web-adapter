import { EngineWebAdapterError } from "./errors.js";

const SIMD128_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

export interface WebCapabilityScope {
  readonly crossOriginIsolated?: boolean;
  readonly SharedArrayBuffer?: typeof SharedArrayBuffer;
  readonly Worker?: typeof Worker;
  readonly AudioContext?: typeof AudioContext;
  readonly AudioWorkletNode?: typeof AudioWorkletNode;
  readonly WebAssembly?: Pick<typeof WebAssembly, "validate">;
  readonly navigator?: {
    readonly storage?: { readonly getDirectory?: unknown };
    readonly locks?: { readonly request?: unknown };
  };
}

/** Synchronous, allocation-small gates that run before resolver/network work. */
export function assertEngineWebCapabilities(scope: WebCapabilityScope = globalThis): void {
  requireCapability(scope.crossOriginIsolated === true, "capability.cross_origin_isolation", "Cross-origin isolation is required");
  requireCapability(typeof scope.SharedArrayBuffer === "function", "capability.shared_array_buffer", "SharedArrayBuffer is required");
  requireCapability(typeof scope.Worker === "function", "capability.module_worker", "Module Worker support is required");
  requireCapability(typeof scope.AudioContext === "function" && typeof scope.AudioWorkletNode === "function", "capability.audio_worklet", "AudioWorklet is required");
  requireCapability(typeof scope.navigator?.storage?.getDirectory === "function", "capability.opfs", "Origin-private file storage is required");
  requireCapability(typeof scope.navigator?.locks?.request === "function", "capability.web_locks", "Web Locks are required");
  requireCapability(scope.WebAssembly?.validate(SIMD128_PROBE) === true, "capability.simd128", "WebAssembly SIMD128 is required");
}

function requireCapability(
  condition: boolean,
  code: ConstructorParameters<typeof EngineWebAdapterError>[0],
  message: string,
): void {
  if (!condition) throw new EngineWebAdapterError(code, message);
}
