/**
 * The advanced entry.
 *
 * What is here is what a caller can legitimately supply or replace: the
 * canonical-PCM resolver seam, the verified store, the FLAC resolver the
 * default path builds, the pump a `createPump` override returns, and the ring
 * control words that override needs to read. Ring layout arithmetic, the
 * incremental digest, the admission width rule, the Worker wire protocols and
 * the decoder pool are the package's own mechanics and are not exported: they
 * are reachable only through the contracts above, which is the whole point of
 * the package owning them.
 */
export { MemoryStemResolver } from "./memory-resolver.js";
export { MemoryStemStorageBackend, OpfsStorageBackend } from "./storage.js";
export { OpfsStemStore, VerifiedStemStore } from "./store.js";
export { BoundedStemAdmission } from "./flac-admission.js";
export { createFlacStemResolver } from "./flac-resolver.js";
export { MSB1_CONTROL } from "./ring.js";
export { PcmPumpWorkerClient } from "./worker-client.js";
export type { PcmPumpSource } from "./pump.js";
export type { Msb1RingCounters } from "./ring.js";
// The OPFS write Worker's own mechanics stay unexported like every other Worker
// wire protocol here; this one type is the exception because
// `OpfsStorageBackend`'s `createWorker` override is a contract a caller can
// legitimately supply.
export type { OpfsWorkerLike } from "./opfs-worker-protocol.js";
export type { FlacProcessingOptions, StemAdmissionLease } from "./flac-admission.js";
export type { FlacLocator, FlacRangeAttempt } from "./flac-delivery.js";
export type { FlacDeliveryOptions } from "./flac-resolver.js";
export type {
  StemStorageBackend,
  StemStorageWriter,
  StorageManagerLike,
} from "./storage.js";
export type { VerifiedStemStoreOptions, WebLockProvider } from "./store.js";
export type {
  DeclaredStemSource,
  CanonicalPcmExpectation,
  ResolvedStem,
  StemIdentity,
  StemProgress,
  StemProgressStage,
  StemRequirement,
  StemResolver,
  StemSessionLease,
  StemStore,
} from "./types.js";
export {
  SPARSE_STEM_FORMAT,
  SPARSE_STEM_MAGIC,
  SPARSE_STEM_HEADER_BYTES,
  SPARSE_STEM_MAX_INDEX_BYTES,
  SPARSE_STEM_MAX_INTERVALS,
  SPARSE_STEM_MAX_CHUNKS,
  SPARSE_STEM_MAX_CHUNK_BYTES,
  SPARSE_STEM_MAX_OBJECT_BYTES,
  admitSparseStemHeader,
  admitSparseStemManifest,
  validateSparseStemManifest,
  serializeSparseStemIndex,
  serializeSparseStemPackage,
  parseSparseStemPackage,
  assertSparseStemSessionBinding,
} from "./sparse-format.js";
export type {
  SparseStemInterval,
  SparseStemChunk,
  SparseStemManifest,
  ParsedSparseStemPackage,
  SparseStemHeaderAdmission,
  SparseSessionSourceShape,
  SparseSessionDeclaredSource,
  SparseSessionSourceExpectation,
  SparsePayload,
} from "./sparse-format.js";
export {
  SPARSE_PCM_FORMAT,
  SPARSE_PCM_MAX_WINDOW_FRAMES,
  SPARSE_PCM_MAX_INTERVALS,
  SPARSE_PCM_MAX_INDEX_BYTES,
  deriveSparsePcmIndex,
  validateSparsePcmIndex,
  readSparsePcmWindow,
} from "./sparse-pcm.js";
export type { SparsePcmInterval, SparsePcmIndex, SparsePcmIndexDraft, SparsePcmDerivation } from "./sparse-pcm.js";
