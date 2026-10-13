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

`0.5.13` depended on `effect@4.0.0-rc.112` directly and `@misofm/codec@0.1.1` peered on
the release candidates. An application on Effect 4.0.x therefore ended up with two
Effect copies. The adapter's rc.112 runtime then ran a `Layer` built by the codec's
4.0.x copy (`Effect.runPromise(Effect.scoped(Layer.build(makeFlacDecoderLayer(bytes))))`
while loading the decoder module) and failed with `TypeError: Cannot read properties of
undefined (reading 'scheduler')`, so FLAC decoding never started. The adapter's unit
tests did not catch this because they resolve a single Effect copy.

### Changed (breaking)

- **`effect` is now a peer dependency, `>=4.0.3 <4.1`** (was a hard dependency on exactly
  `4.0.0-rc.112`). The adapter, `@misofm/codec` and your application now share the one
  Effect copy you install. Release candidates are no longer supported; stay on 0.5.x for
  `effect@4.0.0-rc.112`.
- **`@misofm/codec` is pinned to exactly `0.2.0`** (was `0.1.1`), whose own peer is
  `effect >=4.0.3 <4.1`.
- The `fast-check`, `pure-rand` and `msgpackr` packages that Effect rc.112 pulled in are
  no longer installed: Effect 4.0.x has no runtime dependencies.

### Behaviour notes from Effect 4.0.x

Audit of this package (it uses `Effect.timeout`/`timeoutOrElse`/`raceFirst`,
`Effect.acquireUseRelease`, `Effect.uninterruptible`, `Scope.make`/`Scope.close`,
`Effect.callback`, `Stream.fromPull`/`transformPull`/`paginate`/`timeoutOrElse`,
`Channel.toPullScoped`, `Queue.bounded`, `Layer.build`, `HttpClient.withScope`,
`FetchHttpClient`, `Cause.*`, `Exit.*`, `Schema.TaggedError` and Schema decoding, and no
`partition`, `Schedule`, `Effect.retry` or `Worker` module of Effect):

- `Scope.close` finalizers run uninterruptibly (Effect rc.118). Every scope the adapter
  closes (the sparse acquisition scope, the async-iterator bridge scope, response scopes)
  now always runs all of its finalizers, even when the closing fiber is interrupted, so a
  finalizer that never settles holds that close instead of being abandoned. The finalizers
  here include `store.close()`, `lease.close()`, `backend.close()` and response disposal.
- `Effect.acquireUseRelease` now releases the resource when the use callback throws
  synchronously (rc.113), and `Effect.race*` interrupts losers that are still starting
  (4.0.0). The adapter's abort helper (`abortEffect`) removes its `abort` listener in the
  `Effect.callback` cleanup, which runs whether it wins or is interrupted as a loser.
- A pending interruption is preserved when an uninterruptible effect fails (4.0.1). The
  one `Effect.uninterruptible` region (`store.openSession` during sparse acquisition)
  already awaited the store's own cancellation and is unchanged.
- `Effect.timeout` still fails with a `TimeoutError` whose `_tag` the adapter matches with
  `catchTag`; no adapter code reads the message text.
- A `SchemaError` is now serialized as a compact `{ _tag, message }` object in JSON and
  Node inspection (4.0.3). The adapter never serializes one; its errors are
  `EngineWebAdapterError` values.
- The `internal/*.js` Worker bundles embed Effect `4.0.4` and `@misofm/codec@0.2.0` at
  build time, whatever Effect version your application installs inside the peer range.
  The main-thread modules import your Effect copy.

Checks run for this release are listed in the pull request: the full `npm run check`
(380 tests), the packed Chromium consumer with real OPFS and a Worker FLAC decode, the
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
