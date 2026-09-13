/** The verified platform operation for disposing a consumed ArrayBuffer. */
export type SparseVerifyArrayBufferTransfer = (buffer: ArrayBuffer, newByteLength: number) => ArrayBuffer;

/**
 * Probe the current realm's native ArrayBuffer transfer operation.
 *
 * The returned closure keeps the receiver explicit so callers cannot
 * accidentally invoke a detached or substituted prototype method. This is
 * intentionally evaluated by each pool/worker realm rather than cached
 * globally; tests and embedded realms may have different built-ins.
 */
export function verifiedSparseVerifyArrayBufferTransfer(): SparseVerifyArrayBufferTransfer | undefined {
  const candidate = (ArrayBuffer.prototype as unknown as { readonly transfer?: unknown }).transfer;
  if (typeof candidate !== "function") return undefined;
  const transfer = candidate as (this: ArrayBuffer, newByteLength?: number) => ArrayBuffer;
  try {
    const source = new ArrayBuffer(1);
    const result = Reflect.apply(transfer, source, [0]);
    if (!(result instanceof ArrayBuffer) || result.byteLength !== 0 || source.byteLength !== 0) return undefined;
    try {
      new Uint8Array(source);
      return undefined;
    } catch {
      // A detached source must reject view construction. A zero-length resize
      // leaves the source constructible and is therefore not sufficient.
    }
    return (buffer, newByteLength) => Reflect.apply(transfer, buffer, [newByteLength]);
  } catch {
    return undefined;
  }
}
