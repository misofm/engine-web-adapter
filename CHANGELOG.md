# Changelog

All notable changes to `@misofm/engine-web-adapter`, newest first.

## 0.6.0

Moves the package from Effect `4.0.0-rc.112` to stable Effect `4.0.x` (developed and
tested on `4.0.4`, peer floor `4.0.3`) and from `@misofm/codec@0.1.1` to `0.2.0`.
The runtime API is unchanged: no export was added, removed or re-typed, the session,
resolver, delivery, store and error contracts are untouched, and the only difference
in the built `.d.ts` files is that `stems/sparse-response.d.ts` imports `HttpClient`
from `effect/http` instead of `effect/unstable/http` (Effect removed the `unstable`
path in rc.118).

### Why this release exists

`0.5.13` depended on `effect@4.0.0-rc.112` directly, so it always ran its own rc.112
Effect copy. The failure appears whenever the codec resolves the application's Effect
4.x copy while the adapter keeps that nested rc.112 copy: with `@misofm/codec@0.2.0`
(whose peer is satisfied by the application's 4.0.x), and also with `@misofm/codec@0.1.1`
under package managers that accept an out-of-range peer, such as bun's loose peer
resolution or `npm --legacy-peer-deps` (npm's strict peer check refuses that tree).
The adapter's rc.112 runtime then runs a `Layer` built by the codec's 4.0.x copy
(`Effect.runPromise(Effect.scoped(Layer.build(makeFlacDecoderLayer(bytes))))` while
loading the decoder module) and fails with `TypeError: Cannot read properties of
undefined (reading 'scheduler')`, so FLAC decoding never starts. The adapter's unit tests
did not catch this because they resolve a single Effect copy.

### Changed (breaking)

- **`effect` is now a peer dependency, `>=4.0.3 <4.1`** (was a hard dependency on exactly
  `4.0.0-rc.112`). The adapter, `@misofm/codec` and your application now share the one
  Effect copy you install. Release candidates are no longer supported; stay on 0.5.x for
  `effect@4.0.0-rc.112`.
- **`@misofm/codec` is pinned to exactly `0.2.0`** (was `0.1.1`), whose own peer is
  `effect >=4.0.3 <4.1`.
- The `fast-check`, `pure-rand` and `msgpackr` packages that Effect rc.112 pulled in are
  no longer installed: Effect 4.0.x has no runtime dependencies.

### Behaviour changes

- **Sparse full GET no longer sends trace-propagation headers.** `openSparseResponse`
  now provides `HttpClient.TracerPropagationEnabled = false`, as the FLAC range lane
  already did. The request always runs under the `SparseResponse.open` span, and with
  propagation enabled Effect adds `b3` and `traceparent` headers, which turn a
  cross-origin GET into a CORS preflight. A regression test captures the headers (they
  were sent before this change). If you relied on those headers reaching your stem host,
  that no longer happens.
- **Unknown properties on a sparse expectation or span are still rejected, including
  non-enumerable ones.** Effect 4.0.x (#8423) silently strips a non-enumerable extra key
  under `onExcessProperty: "error"`, where rc.112 rejected it. `preflightExpected` and
  `preflightSpan` now check `Reflect.ownKeys`, so `installSource`/`openSource`
  expectations and resolver spans behave as in 0.5.13 (tests added).
- **Cause shape on cancelled FLAC range reads.** The download-admission acquire in
  `flac-delivery.ts` (`Effect.acquireRelease`, uninterruptible) is the one region where an
  interruption can meet a failure. From Effect 4.0.1 (#8652) an interrupt that arrives
  while it is failing is kept in the cause: the cause is `Fail, Interrupt` where rc.112
  produced `Fail` only (checked on both versions). The public error is unchanged
  (`stem.cancelled` for an aborted operation, otherwise the same typed delivery error);
  only the nested `cause` aggregate may now list one extra `AbortError` entry.

### Audited without a behaviour change

The package uses `Effect.timeout`/`timeoutOrElse`/`raceFirst`, `Effect.acquireUseRelease`,
`Effect.uninterruptible`, `Scope.make`/`close`, `Effect.callback`,
`Stream.fromPull`/`transformPull`/`paginate`/`timeoutOrElse`, `Channel.toPullScoped`,
`Queue.bounded`, `Layer.build`, `HttpClient.withScope`, `FetchHttpClient`, `Cause.*`,
`Exit.*`, `Schema.TaggedError` and Schema decoding, and no `partition`, `Schedule`,
`Effect.retry` or Effect `Worker` module.

- `Scope.close` finalizers run uninterruptibly (Effect rc.118). None of the adapter's
  scope closes (sparse acquisition scope, async-iterator bridge scope, response scopes)
  is reached by interrupting the closer, so nothing changes here.
- Finalizer order (reverse of registration) and the one concurrent `Effect.forEach`
  (sparse source preparation, #8585 keeps sibling cleanup failures alongside an
  interruption) were checked; the cancellation, cleanup-failure and ordering tests pass
  unchanged.
- `Effect.acquireUseRelease` releases when the use callback throws synchronously
  (rc.113) and `Effect.race*` interrupts losers that are still starting (4.0.0). In the
  abort helper (`abortEffect`), a loser's `Effect.callback` cleanup removes the `abort`
  listener from the operation signal, and a winner's listener fires once (`{ once: true }`).
- The `store.openSession` call inside `Effect.uninterruptible` (sparse acquisition)
  already awaited the store's own cancellation and is unchanged.
- `Effect.timeout` still fails with a `TimeoutError` whose `_tag` the adapter matches with
  `catchTag`; no adapter code reads the message text.
- A `SchemaError` is serialized as a compact `{ _tag, message }` object in JSON and Node
  inspection (4.0.3). The adapter never serializes one; its errors are
  `EngineWebAdapterError` values.
- The `internal/*.js` Worker bundles embed Effect `4.0.4` and `@misofm/codec@0.2.0` at
  build time, whatever Effect version your application installs inside the peer range.
  The main-thread modules import your Effect copy.

Checks run for this release are listed in the pull request: the full `npm run check`
(383 tests), the packed Chromium consumer with real OPFS and a Worker FLAC decode, the
indexed sparse packed lane, and the macOS OPFS qualification workflow.

### Migrating from 0.5.x

1. Install Effect yourself and move the whole Effect release train to stable together,
   pinned to one `4.0.x` version, for example `"effect": "4.0.4"` plus every `@effect/*`
   package you use at `4.0.4`. A mixed release-candidate and stable install fails to
   resolve `effect/*` module paths, and two copies of `effect` fail at runtime with the
   `reading 'scheduler'` error above. Do not rely on the peer range alone: it admits
   `>=4.0.3 <4.1`, but each `@effect/*` package peers on its own `effect` floor.
2. Upgrade `@misofm/codec` to `0.2.0` if you import it directly, and move every other
   `@misofm/*` package that depends on `effect` to a stable-Effect release in the same
   change.
3. Nothing to change in code that imports from `@misofm/engine-web-adapter`.
