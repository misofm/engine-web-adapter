import type { ResolvedStem } from "./types.js";

interface FlacResult {
  readonly stream: ReadableStream<Uint8Array>;
  readonly digest?: () => string | undefined;
}

// A caller's optional fields never establish verified provenance. Replacing a
// registered result's stream also revokes it. Custom Workers keep store hashing.
const results = new WeakMap<ResolvedStem, FlacResult>();
export function registerFlacResult(result: ResolvedStem, digest?: () => string | undefined): void {
  results.set(result, { stream: result.stream, ...(digest === undefined ? {} : { digest }) });
}
export function flacResult(result: ResolvedStem): FlacResult | undefined {
  const registered = results.get(result);
  return registered?.stream === result.stream ? registered : undefined;
}
