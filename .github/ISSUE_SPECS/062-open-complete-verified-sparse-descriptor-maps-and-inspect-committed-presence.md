# Open complete verified sparse descriptor maps and inspect committed presence

Scope approved by independent non-implementing Astra medium planning review. Implementation baseline: merged adapter #60 ea19c2b381b2d2e82f50b53589df4b5349ea4392, with accepted #58 sparse store implementation and #60 pump (reviewed source fdcef5b). Root authorized attempt1 after CLI checkpoint4632ec4 and a clean/upstream/GitHub audit of0951146. A separate Luna xhigh works only in this adapter worktree; CLI consumes a fixed accepted56 candidate and app lifetime work consumes the published dense package, so their files and gates do not overlap. Astra medium independently reviews the completed slice. Root owns exact-path checkpoints before another tranche. Smallest capability: prepare a complete verified source map, retain it for bounded reads, and expose truthful metadata-only presence. Session-controller wiring is explicitly the next closable issue.

## Public surface

Add to the existing `/stems` exports, implemented alongside sparse-store.ts:

```ts
interface SparsePcmSessionSource extends SparsePcmExpectation {
  readonly sourceId: string;
}
interface SparsePcmSessionOptions {
  readonly leaseId: string;
  readonly sources: readonly SparsePcmSessionSource[];
  readonly maximumMetadataBytes?: number;
  readonly resolve?: (
    expected: SparsePcmExpectation,
    signal: AbortSignal,
  ) => Promise<SparsePcmResolved>;
  readonly signal?: AbortSignal;
}
interface SparsePcmSessionLease {
  readonly leaseId: string;
  readonly sources: readonly SparsePcmSessionSource[];
  read(identity: StemIdentity): Promise<SparsePcmDescriptor>;
  close(): Promise<void>;
}
type SparsePcmPresence =
  | { readonly status: "missing" }
  | { readonly status: "present"; readonly activeBytes: number };
```

Add `VerifiedSparsePcmStore.openSession(options): Promise<SparsePcmSessionLease>` and `inspectSourcePresence(expected, {signal}?): Promise<SparsePcmPresence>`. Existing openSource/installSource signatures and behavior remain unchanged. No separate store interface, lease class registry, source list/catalog, owner/pin metadata, eviction API, progress events or runtime factory is needed here. A future session-options type can use a structural Pick of these methods.

`leaseId` is a caller label, not a unique lock token; duplicate labels across separate maps are permitted. Preserve source declarations in caller order and preserve every sourceId even when canonical mono folding converges two identities. Return frozen detached declarations. Empty source arrays are valid for a session without audio sources. Refuse duplicate source IDs and conflicting full shapes for one identity before any backend/resolver work. Identical identity plus all expectation fields dedupes only verification, installation and descriptor storage.

## One configurable admission budget

Use one documented `maximumMetadataBytes` resource-accounting budget, default64MiB, positive safe integer. It bounds caller declarations and retained index metadata; it is not an assertion of exact JavaScript heap consumption. Do not add an unrelated compiled MAX_TRACKS or a second scheduler capacity.

Freeze a simple conservative accounting model:256 bytes per source declaration plus2*sourceId.length,2*leaseId.length for the label, and512+128*intervalCount per UNIQUE retained descriptor index. Fixed-size identity/shape fields are covered by the fixed charges. Charge aliases' declarations separately but their shared index once. Safe-integer-check every sum/product; do not sum canonical PCM bytes across the session as an allocation requirement. Blob payload sizes are not resident metadata and do not count against this budget.

Preflight Array.isArray and sources.length against floor(budget/256) BEFORE reading elements, cloning or Schema.Array traversal. Bound label/string lengths from the remaining budget before copying them. Preflight each exact source shape and cumulative charge, then use Schema for the new options/source boundary and the accepted decodeExpected kernel for the six expectation fields; do not pass sourceId into the existing exact-key expectation validator. Finish validating and snapshotting the entire requirement set before the first I/O. Reject unknown option/source keys and malformed signal/resolver through existing boundary error mapping. No full JSON.stringify of an unadmitted array or arbitrary user object.

After an accepted source descriptor is produced, charge its index before retaining it or beginning the next source. The existing one-source accepted index/marker bounds remain the transient admission scratch limit; state explicitly that at most one such additional descriptor is under consideration outside the retained budget. If its charge exceeds the remainder, fail without a lease; leave already verified/committed PCM intact. No retrospective rollback of valid files. This bounds retained maps without requiring a second index validator or modifying #58's marker admission. Caller can raise the budget for larger valid sessions.

## Existing Effect program, complete barrier, precise lock scopes

Extend existing SparseProgram and the existing ManagedRuntime. Use Effect.fn/gen, current SparseBackend/SparseCoordination/SparseLifecycle services, and existing full Exit-to-public-error mapping. Compose internal source Effects directly, never invoke public Promise methods from an Effect or add a second runtime/scheduler.

Process unique identities sequentially in first declaration order. With a resolver, call the existing internal installSource for that expectation: it already checks and fully verifies a committed source before invoking resolve, so no redundant open-then-install hash pass is needed. Without a resolver, call internal openSource and map undefined to `stem.not_found`. Wrap EACH internal source program in its own Effect.scoped so its source locks/writer/iterator finalizers release before proceeding to the next identity; do not retain all source locks until the outer session ends. The all-source barrier does not require a multi-source filesystem transaction.

Every warm source undergoes accepted full canonical hashing, including implicit zeros. Every missing source uses the existing bounded sparse span install and marker-last commit. A present corrupt source refuses; it does not invoke resolve as repair or select a dense fallback. Any source failure, resource refusal or cancellation yields no returned lease. Already committed valid sources remain available for later opens.

Keep existing caller/store cancellation and physical operation finalization. Check cancellation/store closure at the final successful public handoff; a store.close or abort before handoff cannot yield a live map. Do not impose an aggregate session deadline: each accepted source/read/write progress deadline remains independent of source count. Do not alter #58's backend-owned write deadlines or full cleanup Cause policy.

## Lease semantics and facade independence

The lease owns only an immutable verified-descriptor map and its admitted declarations. After successful handoff it is detached from the store runtime and preparation signal: store.close prevents/settles store operations but does not invalidate already returned leases. It does not close the caller-owned backend or remove committed files. This choice needs no store-to-lease registry, live token or retained facade runtime. The caller owns session cancellation and must close its pump before closing the map; the next integration issue wires that ordering.

Use one operation-local Ref holding the map or a closed state. Lease read/close contain no I/O, awaits to storage or runtime services. They may execute their small synchronous Ref Effects at their actual public method edge and return the required Promise, reusing the existing error mapping; no new ManagedRuntime, listener or background fiber. This is not permission to run Effects inside helper loops. Freeze the outward object and keep the mutable map inaccessible.

read returns the already verified descriptor without rehash/re-admission. Unknown identity refuses with `stem.not_found`; malformed identity uses the existing declaration error; after close, read refuses with `session.closed`. Close is idempotent and atomically drops map references; it writes/removes nothing. A read already completed before close may have handed its descriptor to its caller; close is not retroactive revocation. Independent leases sharing an asset remain unaffected when one closes. No source data is retained through hidden global references after map close.

The lease proves complete verified preparation, not protection from arbitrary deletion. Caller must exclude external removal for its full pump/map lifetime. Actual app launch must hold its existing `miso:offline-library` shared lock and registered Clear Data signal through physical session teardown. No adapter owner file would enforce that app-wide lock. Presence of a Blob object alone is not proof that deleting its underlying OPFS generation is safe.

## Presence reuses metadata admission, not verification authority

Extract the smallest INTERNAL metadata/extent portion of verifyMarker: accepted readMarker decoding/canonical/index validation; all marker-to-authoritative-expectation checks; payload-name derivation; payload existence and bounded backend.read; exact Blob.size check. Return an internal admitted metadata/data pair, never a public verified descriptor. Existing verifyMarker continues hashing that pair using the unchanged full canonical verifier. Presence uses the pair only to return activeBytes, with no payload arrayBuffer read, zero hashing, resolver, install or mutation.

Use existing operation scope, historical identity locks, backend metadata deadlines and cancellation. Only absent commit marker returns missing. Orphan-only data is missing without scanning or deleting it. Present malformed/noncanonical/conflicting marker, missing generation, wrong length, or absent zero-byte silent generation refuses as `stem.corrupt`. Preserve genuine backend capability/I/O/deadline/cancellation errors rather than translating every failure to missing/corrupt. A narrow payload exists check under the same lock can distinguish missing generation before backend.read; do not broadly reclassify backend errors.

Presence is a sequential snapshot, not a descriptor, pin, full hash proof or readiness authority. Same-length PCM tampering can return present and MUST fail later openSource/openSession. The app may use all-source presence to reconcile an already-established canonical snapshot; it cannot promote an incomplete record to ready, refresh verification timestamps or infer expected shape from cache metadata. App code and its all-identity iteration are outside this issue.

## Minimum gates and closure

Use existing sparse-store tests and backend spies, not a new harness:

- Two unique sources plus an alias: one verification/install per identity, all three IDs/order retained, resolver never called for warm content; second open fully rehashes while lease reads do not. Empty session succeeds.
- Late duplicate-ID/conflicting-alias/malformed expectation/budget failure refuses before I/O. Oversized ordinary array with a late getter refuses before traversal; configurable budget permits a larger valid set. Unique index charges stop retention at the budget without deleting committed assets.
- Last source missing, corrupt, resolver failure or cancellation returns no lease; successful earlier files survive. Existing source scopes release before next source; simultaneous opens in different source order cannot deadlock by retaining multiple source locks.
- Store closure/cancellation during preparation and at handoff refuses; completed lease survives facade.close without a new runtime/backend operation. Close/read/unknown identity and two-map independence follow the stated semantics.
- Presence: absent marker/orphan-only missing; malformed/conflicting marker and missing/short/long generation refuse; silent zero-byte generation present; same-size tamper present then full open fails. Spies prove no PCM reads/hash/resolver/writes. Metadata timeout and cancellation preserve errors/locks.
- Existing #58 integrity, cancellation, marker-last and full Cause regressions stay green. Run focused tests, typecheck/format/source policy and one full package check. A tiny existing packed Node consumer can assert exports and detached lease reads; no new real-browser/transport matrix is required for this control-only addition.

Expected tracked boundary: src/stems/sparse-store.ts, src/stems/index.ts, focused sparse-store tests, numbered spec. A small private file extraction is allowed only if it reduces this implementation without duplicating services/validators. Do not edit session.ts, pump, codec/acquisition, app, CLI or cache policy here.

Next independently closable issue: explicit sparse session-open/options selecting this map and #60 createSparse through the existing shared controller, preserving source shapes and reverse teardown. HTTP/native/indexed acquisition, app offline snapshot/lifetime, package publication and deployment remain required successors. No owners/pins/catalog/eviction, broad orphan cleanup or speculative future-remover design is included.

## Attempt 1, implementation checkpoint before qualification

Luna xhigh implemented the complete source-map API, logical metadata admission, sequential per-source scopes/deduplication, detached map read/close and metadata-only presence through extracted shared marker admission. Four focused tests add successful alias/detachment, silent presence, admission budget and cancelled handoff cases. Root independently rebuilt the tests and ran typecheck plus all33 sparse-store tests successfully; retained logs: `/data/sparse-pcm-launch/tooling/adapter-62/attempt1-tranche1/`. Luna additionally reports lint, package check and a packed export/detached proof; exact retained producer artifact paths must be attached before relying on that publication evidence.

This is a compiling intermediate checkpoint, not an independent verdict or completed issue. Before review, finish the named discriminators: metadata-only presence read/hash spies and corruption/extent cases; duplicate IDs/conflicting shapes before I/O; warm no-resolver work; late failure preserving earlier assets; reverse-order lock scopes; empty and independent map behavior; store/caller final handoff cases. Handoff-only AbortSignals currently remain referenced by the lease; eliminate that unnecessary post-transfer retention while preserving final cancellation checks. Run one full package check and retain the packed consumer proof at the completed evidence boundary. Session-controller/acquisition/app integration remains separate.

## Attempt 1, completed implementation and qualification tranche

Luna xhigh removed post-transfer signal retention from the lease, added presence PCM-read spying and tamper distinction, missing/malformed/wrong-extent marker cases, preflight duplicate/shape rejection, per-source lock release with late failure preservation, warm resolver avoidance and reverse-order independent map tests. All38 focused storage tests and the full package check PASS:258 tests, format/type/source/decoder/package policies. Logs and producer provenance: `/data/sparse-pcm-launch/tooling/adapter-62/attempt1-tranche2/`. The producer file named `packed-consumer.log` actually imports repository `./dist/stems/index.js`; it is a built-export smoke proof, not an installed tarball consumer. Root is retaining an actual packed/fresh consumer before independent Astra medium review. No independent verdict or registry publication is claimed yet.

## Independent Astra medium verdict — attempt 1 FAIL

Fresh reviewer `descriptor_review_astra` reviewed frozen6ee0eb9 and reproduced a real metadata admission bypass: preflight reads the caller objects, then Schema reads them again. With a1024-byte budget, a changing sources getter returned100 aliases requiring28022 charged bytes; a stable one-element array with a changing sourceId getter returned a10000-character ID requiring20898 bytes. Focused38 tests, independent typecheck and root's actual installed archive proof passed but do not excuse this resource-contract failure. Review: `/data/sparse-pcm-launch/tooling/adapter-62/review-attempt1.md`; reproducible scripts/results: `review-repros.{mjs,log}` in the same directory.

Attempt2 is bounded to single-read admission: capture caller options/array elements/source scalar fields once, preflight and charge those captured values before bounded snapshot allocation/traversal, and pass only the detached snapshot to Schema and subsequent preparation. No rereads of caller accessors or source/label/array substitutions may bypass the budget. Add the retained reproductions and matching label/source substitutions as small regressions. No other API or ownership expansion. Maximum five coherent attempts remains; this is verdict1, not acceptance.

Actual packed consumer evidence for6ee0eb9 is retained at `/data/sparse-pcm-launch/tooling/adapter-62/packed-6ee0eb9/`:200598-byte unpublished archive SHA256`d674d82169b416a18a68a3398fdcf852d98760b445fddb0632100e320ad974fc`, normal fresh npm installation and Node22.23.2 export/alias/presence/detached-read/closed-read checks PASS. The reviewer independently reran this proof. It supersedes the earlier repository-dist-only claim, but the failed candidate is not release-ready.

## Attempt 2, bounded snapshot correction

Luna xhigh replaced preflight followed by caller-object re-reading with a single-read detached snapshot. Options, array elements and source scalar fields are captured once; declaration metadata is charged before retaining each snapshot source, and Schema/preparation consume only detached values. Regressions cover changing option/source/label accessors and preserve cancellation and post-handoff signal independence. Focused40 tests and the full package check PASS:260 tests plus format/type/source/decoder/package policies. Retained producer evidence: `/data/sparse-pcm-launch/tooling/adapter-62/attempt2-tranche1/`; root inspected the correction and logs before this checkpoint.

This is the frozen attempt2 implementation checkpoint, awaiting one independent Astra medium verdict. The prior archive proof remains evidence for6ee0eb9 only; root will pack this corrected checkpoint into a fresh installed consumer before review. No registry publication, session-controller wiring or completed issue is claimed.
