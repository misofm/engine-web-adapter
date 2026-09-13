/** Private package-relative factory for the bounded warm verification worker. */
export function createSparseVerifyWorker(): Worker {
  return new Worker(new URL("../internal/engine-web-sparse-verify-worker.js", import.meta.url), { type: "module" });
}
