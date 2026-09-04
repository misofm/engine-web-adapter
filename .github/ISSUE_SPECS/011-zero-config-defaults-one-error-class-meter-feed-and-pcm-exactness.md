# Input to #8: zero-config defaults, one error class, meter feed, and the PCM exactness trap

GitHub: https://github.com/misofm/engine-web-adapter/issues/11

## Context

This pre-existing issue collects follow-up API findings from the first app
integration. It is not part of the universal-Wasm decoder correction and must
not expand that launch-critical slice. Issue #8 already moved caller-owned
float-to-integer conversion out of the default path.

## Proposed product decisions

1. Make the documented zero-configuration path deliberate: default the Engine
   console from published Engine ABI constants, generate `leaseId`, derive
   source declarations from the canonical session, and retain explicit
   overrides. If no-console remains supported, expose an explicit opt-out.
2. Add subscription-oriented meter and telemetry feeds while preserving host,
   context, and output escape hatches. Callers must not coordinate private
   request identifiers.
3. Normalize every adapter-boundary failure into one typed error carrying a
   stable code, phase, remedy, details, transience, and cause. Console
   backpressure should be absorbed/coalesced while semantic refusal stays
   visible.
4. Keep Effect internal; no Effect type enters the public API. Record the
   measured bundle cost.
5. Preserve the exact PCM rule for any advanced float input: multiplying by
   `2^(depth - 1)` must produce an in-range integer. Never round. Include both
   positive and negative full-scale samples in the corpus.
6. A narrow declarative strip-state facade may follow once the common error and
   console-writer boundary exists; it is optional and must not broaden the
   decoder issue.

## Objective gates

1. A packed consumer can open the documented minimal session and use its first
   console command and meter subscription in either order without retry.
2. An explicit no-console session reports `console.not_attached` at first
   console access with a useful remedy.
3. Every thrown/rejected consumer error is the single public error class with a
   nonempty remedy; raw Engine host objects never leak.
4. Semantic console refusal throws accurately; transient backpressure is
   coalesced and the final staged value lands.
5. Full-scale PCM fixtures prove exact conversion and reject a non-integral
   sample.
6. Caller-supplied policy, identifiers, declarations, assets, host/context,
   store, pump, output, scratch, and capability overrides remain supported.
7. README, public types, package checks, and packed-consumer tests agree.

## Dependencies and non-goals

Coordinate with the Engine request-id/error work tracked in
`misofm/engine#379`. Do not change the Rust ABI, implement a new meter queue,
alter FLAC preparation/delivery, or fold this API redesign into the universal
Wasm decoder successor issue.

## What was implemented

Points 1-4 are implemented. Point 5 is unchanged and already held before this
slice; point 6 remains deliberately deferred.

1. **Zero configuration.** `leaseId` and `sources` are optional.
   `leaseId` is generated per open with `crypto.randomUUID()`; the store pin is
   per-session and warm reuse is keyed by content identity, so a generated pin
   costs nothing. Declarations are derived from the canonical Session V1
   document, which already states every source's id, digest, channels, bit depth
   and frame count -- the same five fields the adapter was already parsing to
   cross-check a caller's copy. Explicit `sources` and `leaseId` remain
   supported and are still cross-checked against the document and the compiled
   shape. The console default is issue #9's decision.

2. **Subscriptions, and no caller-visible identifiers.** `session.meters(fn)`
   and `session.telemetry(fn)` resolve to an unsubscribe function. One lease is
   shared: the first listener takes it, the last one out releases it. Meter
   updates arrive keyed by track id (`update.tracks: ReadonlyMap<string,
   TrackMeter>`) with the master fold separated (`update.master`), replacing the
   flat `[t0L, t0R, .., masterL, masterR]` array a caller had to index by
   ordinal. `host`, `context` and `output` remain exposed.

   The adapter owns one request-identifier ledger per session, seeded from the
   identifier the host consumed answering `sessionMap()` and allocated inside a
   serialized chain. This is the actual cause of the "first host call always
   rejects `invalidArgument`" workaround: the Engine's own console counter and
   an app's hand-written meter-lease counter both start from one and collide on
   the host's monotonic ledger. With one allocator the collision cannot occur,
   and a first console command and a first meter subscription succeed in either
   order with no retry.

3. **One error class.** `EngineWebAdapterError` carries `code`, `phase`,
   `remedy`, `transient`, frozen `details` and `cause`. Phase, remedy and
   transience come from one `Record<EngineWebAdapterErrorCode, ...>` table, so a
   code added to the union without a remedy does not compile; a delivery layer's
   own `details.retryable` verdict outranks the table's transience.

   Console backpressure is absorbed by binding the Engine's own `ConsoleWriter`
   -- latest-wins coalescing, adaptive batch splitting, serialized flushes --
   to the shipped worklet host. The writer speaks 48-byte records and the host
   speaks command objects, so the adapter decodes the block back through the
   same generated `ABI_LAYOUT.commandRecord` table the encoder reads; the
   round trip is pinned by test. A queue that stays full past one drain's
   attempt budget is handed to a background flusher rather than blocking the
   caller, because a full queue with a paused transport is a legitimate steady
   state. Semantic refusal is not absorbed: it rejects as `console.refused`.

   `session.console` is `{ edit: ConsoleEdits; submit(...edits): Promise<void> }`
   rather than the Engine's `EngineConsole`, because `EngineConsole.submit`
   enforces `admitted === edits.length` for one transaction, which a coalescing
   writer structurally cannot honour. `edit` is still the Engine's own
   catalog-derived builder, unwrapped: duplicating it would be the "third
   hand-written copy" the Engine SDK explicitly warns against.

4. **Effect is internal.** `FlacDeliveryOptions.httpClient` and
   `.httpClientLayer` are replaced by `fetch?: typeof globalThis.fetch`, which
   overrides only the platform fetch reference the package's own client uses.
   `FlacHttpOptions` loses the same two fields. No Effect type is reachable from
   `@misofm/engine-web-adapter` or `@misofm/engine-web-adapter/stems`.

   Bundle cost is not separately measured in this slice: `effect` remains a
   runtime dependency for the delivery pipeline, which the mission statement
   requires, and this change moves no code across that boundary. Recording the
   measurement is a remaining item on this issue.

### Point 5, restated for this package

The adapter has no float-to-integer conversion path to protect. A `32f` source
is refused at two boundaries -- document-derived declarations
(`declaredSourcesFrom`) and canonical byte accounting (`canonicalPcmBytes`) --
both as `stem.invalid_declaration`, and web launch bit depths are integer-only
by the Engine's own `WEB_LAUNCH_BIT_DEPTHS`. The exact-conversion rule therefore
binds whoever produces canonical PCM, not this package, and this slice adds no
corpus here because there is no conversion to cover.

### Surface prune

`./stems` exported 38 names, most of them package mechanics. It now exports what
a caller can legitimately supply or replace -- the resolver seam, the verified
store and storage backends, the FLAC resolver, the pump, the admission handle
`FlacDeliveryOptions` names, and `MSB1_CONTROL`, which a `createPump` override
needs to read the rings it is handed. Ring arithmetic, `IncrementalSha256`,
admission-width constants, the decoder pool, `readExactFlacRange`, the session
gate and the Worker wire protocols are no longer exported. This is gate 7's
"public types agree", taken at the only moment it is free: npm still carries
0.1.0, so nothing published depends on the removed names.

## Evidence

- `npm run check` (format, lint/typecheck, decoder, 93 unit tests, package
  policy) passes.
- `npm run test:browser` passes against the packed tarball in Chromium with the
  real Engine worklet: a zero-configuration open (no `leaseId`, no `sources`, no
  `policy`), console transactions and meter subscriptions in both orders with no
  retry, meters keyed by track id with a master fold, and
  `console.not_attached` on a `console: false` session. Warm reuse still makes
  zero additional locator, Worker or network calls across three further opens
  under generated lease ids.
- `tests/console.test.ts` covers the console words, the opt-out, either-order
  first control call, request-id distinctness and monotonicity, meter keying and
  lease release, backpressure coalescing, the background flusher, semantic
  refusal, a refused lease, derived declarations and generated lease ids, the
  record round trip for every builtin lane kind, and the remedy/phase totality
  of the error table.
- Integration check: `src/lib/mixer-engine.ts` in `misofm/website` was rewritten
  against this surface and measures 80 code lines against a 188-line baseline
  (same counting method). Every block the baseline named a workaround is gone;
  what remains is the site's own dB/peak formatting, its rAF meter decay, its
  DOM mask wiring, and the try/catch fallback to the visual mock.

## Remaining on this issue

- Point 4's measured bundle cost is not recorded.
- Point 6's declarative strip-state facade is not started, as specified.
- The Engine-side request-id/error work in `misofm/engine#379` is untouched;
  the adapter now hides the collision rather than fixing the host's diagnostic.

## Status

Points 1-4 implemented on `feat/zero-config-console-and-feeds`; points 5-6 as
noted above.
