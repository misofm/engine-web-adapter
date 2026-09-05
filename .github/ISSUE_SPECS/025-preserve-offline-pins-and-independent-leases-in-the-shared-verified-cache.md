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
