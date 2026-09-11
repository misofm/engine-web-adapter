/** Internal canonical lexical JSON used by the accepted sparse formats. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  throw new Error("canonical JSON received an unsupported value");
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
