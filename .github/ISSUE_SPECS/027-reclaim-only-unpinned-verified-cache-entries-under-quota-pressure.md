# Reclaim only unpinned verified cache entries under quota pressure

## Existing product behavior

The current app reclaims unpinned PCM cache entries when space is needed. Adapter adoption must preserve that behavior; current adapter preflight only refuses quota. Build on reviewed#25 pin/lease/compatibility ownership, without a second cache implementation or a new public API. This is the bounded cache-policy successor already separated from#25 and required by app#101.

## Frozen contract

- When the existing storage estimate demonstrates insufficient capacity, choose verified indexed unpinned victims by oldest lastUsedAt then identity. Reclaim only enough for current need; if no eligible capacity remains, return existing typed stem.quota. Unknown/unavailable estimates keep existing behavior, and actual write quota failures stay typed.
- Protect durable offline pins, every live independent lease, and every source already verified for an in-progress multi-source open. Install provisional ownership before releasing a successfully verified source lock; rollback only that open's pins on failure/cancel, and promote/retain exact ownership for returned lease. No acknowledged lease may lose bytes through eviction.
- Recheck victim existence and pin ownership while holding its compatible stem/index coordination before removal. A second-tab pin racing victim selection must win protection if admitted before eviction's protected mutation. Never hold the index lock while acquiring a stem lock, and never wait for another victim stem while holding the current ingest stem. Move preflight/admission outside the target stem critical section and recheck on reacquisition if needed; do not add ad-hoc try-lock protocols or alter public lock-provider contracts.
- Use current recognized session-pin liveness and reliable lock-query evidence if stale session pins need pruning; preserve ambiguous pins and all offline pins. Do not invent new cache schemas, reset data or treat unavailable liveness as proof of death. Report any concrete compatibility ambiguity before broader recovery changes.
- Preserve source verification, bounded I/O, store timeout/cancel cleanup and historical folder/lock semantics. No new backend, decoder, playback, telemetry, benchmark or general recovery framework.

## Paths and gates

Allowed src/stems/store.ts, existing tests/store.test.ts, README only for exact existing quota behavior, this spec. A necessary additional path requires a concrete report before edit. Start isolated codex/dx-cache-quota from reviewed cache0d4e2db. SDK/adapter consumer changes remain separate and are merged only after review.

Existing lock/backend fixtures prove deterministic eligible victims, multiple offline/live pins protected, first verified stem of an unfinished open protected, pin-versus-eviction race, partial-open rollback, insufficient reclaimable quota and finite failure with no false lease ACK. Assert no nested stem-lock deadlock with two concurrent cold opens using existing fixture. Run focused types/store then pause for rootcheckpoint; full npm run check/package after. No broad browser matrix or timing benchmark. Astra medium implements; dedicated independent Astra medium reviewer checks completed evidence.

Matching issue misofm/engine-web-adapter#27.
