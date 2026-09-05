# Preserve offline pins and independent leases in the shared verified cache

## Existing app contract

App#101 must replace its store without deleting offline library behavior. Existing callers require read(identity) (already implemented) and setOfflinePin(identity,pinId,pinned) (missing). Both stores use canonical interleaved PCM filenames sha256-<digest> and version1 index rows {bytes,pins,lastUsedAt}. App uses folder miso-stems-v1 and folder-qualified Web Locks; adapter defaults and lock names differ. Selecting the old folder alone is unsafe during overlapping app tabs.

## Minimum public change

Add setOfflinePin(identity: StemIdentity, pinId: string, pinned: boolean): Promise<void> on VerifiedStemStore/OpfsStemStore. Keep existing read and injectable StemStore interface. No cache metadata registry, migration API or additional store. Preserve existing folderName option; app explicitly selects its old folder in later adoption.

## Frozen ownership/compatibility

- Encode offline:<pinId>; validate nonempty identifiers. Add/remove idempotently under index coordination, preserve other pins and metadata. Missing add uses stem.not_found; missing remove is a no-op. Failed persistence rejects, never acknowledges a lost pin.
- Each openSession gets unique session ownership even when leaseId repeats. Hold its matching lifetime pin lock, release exactly that pin and lock on close/failure/cancel. Closing one lease cannot unpin another. Preserve durable pin sets during successful reverification/repair; corrupt content never bypasses verification due to a pin.
- Preserve historical app cache bytes/index in place. Coordinate with app locks miso:stem-store:v1:<folder>:index, :ingest:<digest>, :pin:<session-pin>. Preserve overlap with prior adapter global miso:engine-web:v1:index/:stem:<digest> using a documented fixed acquisition order; avoid index-to-stem inversion. Lifetime liveness uses the historical folder-qualified pin lock so old app recovery recognizes new live pins.
- Keep unknown/ambiguous session pins conservatively when liveness cannot be established; offline pins are never session-recovery candidates. Do not recreate/reset cache, purge old staging/ directory, or claim unsupported index compatibility. Existing valid version1 rows/final bytes must remain readable. Report a concrete unsupported-version mutation risk before extending parser behavior.
- Storage/backend worker timeout and cancellation corrections already reviewed in#19/#21 stay intact. This issue adds no quota eviction, new backend, codec, playback, arbitrary diagnostics or framework. Quota reclamation is a separate bounded successor required by existing app behavior.

## Allowed paths and dependencies

Begin from combined reviewed control/OPFS31a5039 in isolated codex/dx-cache-pins. Allowed src/stems/store.ts, src/stems/storage.ts only for concrete folder identity/coordination, src/stems/index.ts if exports needed; existing store/opfs-storage/public-types tests; README and this spec. Reuse existing lock/backend fakes. No session/feed/decoder/SDK changes. SDK consumer#24 waits for a coherent checkpoint and does not overlap these paths.

## Gates

Existing focused tests prove shared offline pins survive reopen, removing one preserves another, two same-leaseId sessions remain independent, cancellation/index-write failure never acknowledges ownership loss, historical seeded index/final bytes remain identical, and old/new lock clients serialize mutations under documented lock order. Preserve previous OPFS focused gates. Run npm run check and a fresh packed public type consumer for pin/read. Use existing package/browser fixture only if coordination requires actual Web Locks proof; no broad fault matrix. Astra medium implements, separate Astra medium reviews; root checkpoints coherent green tranches promptly. Report exact unresolved behavior instead of broadening scope silently.

Matching issue misofm/engine-web-adapter#25.

### Unsupported-version preservation correction

Inspection confirms #readIndex currently rebuilds a parseable future-version index and writes version1, losing its pins. Before app adoption, distinguish an explicitly unsupported parsed index version and refuse with existing stem.corrupt before any recovery mutation. Read/check the index before deleting index.pending or staging during recovery. Existing supported malformed/missing-index behavior stays bounded; no new schema support or migration is added. Existing store tests must prove unsupported index and all files remain byte-identical on refusal. This exact store.ts correction is authorized within the cache-preservation slice.

## Implementation evidence — awaiting independent Astra review

Astra medium implemented the bounded cache slice; coherent implementation was
checkpointed at `aa04262` before the final no-op/cancellation checks. No SDK,
session/feed, decoder, backend selection, quota eviction, or metadata registry
changed.

`VerifiedStemStore`/`OpfsStemStore.setOfflinePin` use the existing version-1 row
and `offline:<pinId>` encoding. Existing or missing removals and already-present
adds do not rewrite the index; missing adds refuse with `stem.not_found`.
Persistence errors reject. Each session opening gets a distinct pin, including
repeated caller lease IDs, and holds its corresponding historical lifetime
lock. Failed close persistence retains ownership for retry. Cancellation after
pin persistence or during the ready callback removes only that opening's pin
and releases its lock before rejection. Valid pinned metadata is retained while
corrupt bytes are removed and successfully reingested; pins never skip hashing.

Folder identity comes from the existing OPFS backend. Lock acquisition order is
prior-adapter global resource first, then historical folder resource. Ingest may
acquire index locks; index operations never acquire ingest locks. Recovery checks
both ingest namespaces before touching ambiguous files and leaves historical
`staging/` alone. Ambiguous/unknown session pins remain conservative. The explicit
unsupported-version refusal runs before recovery cleanup, preserving every
seeded file byte-for-byte.

Compatibility was checked against the *current app store's lock semantics* at
app `2af14140ef3534b4bea4133a5273d6b16706b6df`, file
`src/lib/mixer/stem-store/vendor/stem-store/opfs-store.js` (index/ingest/pin names
and lifetime lock behavior only). No source was copied and no legacy engine
architecture was inspected or inherited.

Validation:

- Strict `npm run typecheck`: PASS.
- Focused store/OPFS/public-types tests: **41 PASS**; existing OPFS lifecycle and
  physical-removal unit regressions remain green. Log:
  `/private/tmp/dx25-final-focused.log`.
- Final `npm run check`: **130 PASS**, including decoder, strict types and package
  policy; `/private/tmp/dx25-final-check.log`. This includes the final cancellation
  callback regression added after the earlier focused invocation.
- Fresh extracted packed consumer compiles both concrete store classes under
  strict DOM/NodeNext types with `skipLibCheck: false`, using public `read` and
  `setOfflinePin` return types. PASS: `/private/tmp/dx25-packed-types.log`;
  consumer `/private/tmp/dx25-packed-48fn0qn0`. Reproducer:
  `/private/tmp/dx25-packed-types.py` (uses the same npm-pack/extraction pattern,
  adds no repository framework or dependency).

The existing deterministic WebLock provider proves that both prior-adapter and
historical-app index lock holders block the new mutation and that the old and
new pin sets both survive. It also reports distinct held historical lifetime
locks for same-ID leases and exact release behavior. The historical seeded
index/final read, durable repair, no-write idempotence, persistence rejection,
unsupported-version refusal and cancellation tests are retained in the existing
store suite. No additional browser matrix was needed for this lock-name and
ownership slice; downstream app adoption remains separate.

These are implementation gates, not an independent PASS verdict. Root must
checkpoint/push the final tranche and obtain the requested separate Astra medium
review before closing this issue or claiming app adoption complete.

## Dedicated attempt-1 review and bounded attempt-2 correction

The independent Astra medium review returned **FAIL with one P2 blocker** at
`ad57ef8`: lifetime pin-lock acquisition occurred outside the existing
cancellation-classification boundary. Aborting before the asynchronous lock
grant returned the raw caller reason instead of `stem.cancelled`. The reviewer
found no ownership leak in that window and no other concrete blocker in the
frozen slice; independently rerun focused 41/41 and packed public types passed.
Report: `/private/tmp/dx-25-astra-medium-review.md`; reproducer:
`/private/tmp/dx25-review-cancellation.mjs`.

Attempt 2 makes only the requested correction: acquisition is now inside that
existing error boundary, and cleanup releases the lifetime lock only if it was
acquired. One regression pauses before granting the actual injected lock, aborts
with an arbitrary caller Error, and verifies typed `stem.cancelled` retains that
exact cause, the index stays byte-identical, and no lifetime lock was granted or
remains held. Source/test checkpoint `0ddcae6` is upstream.

- Strict typecheck: PASS.
- Focused existing store/OPFS/public-types suite: **42/42 PASS**;
  `/private/tmp/dx25-attempt2-focused.log`.
- Full existing `npm run check`: **131/131 PASS**, including strict types,
  decoder and package policy; `/private/tmp/dx25-attempt2-check.log`.

No public declaration, lock order, schema, persistence behavior, or additional
scope changed in this revision. The prior packed public-type evidence remains
applicable. This records implementation evidence only; the same independent
reviewer must recheck the exact correction before a PASS/closure claim.
