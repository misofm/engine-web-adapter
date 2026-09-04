# Safari 17/18 cannot open a session: OPFS store requires createWritable(), capability gate only checks getDirectory

GitHub: https://github.com/misofm/engine-web-adapter/issues/13

## Problem

`OpfsStorageBackend` wrote staging exclusively through
`FileSystemFileHandle.createWritable()`. Per MDN BCD that method is Safari 26+
on OPFS handles. `createSyncAccessHandle()`, shipped by WebKit since Safari
15.2, appeared nowhere in `src/`.

The capability gate did not catch this. It probed
`navigator.storage.getDirectory`, which Safari 15.2+ satisfies, so Safari 17
and 18 passed the gate, booted, and then failed inside `openSession` with an
untyped `TypeError` on the missing method: no clean capability refusal and no
working session.

The packed browser gate ran Chromium only and no test referenced WebKit, so no
gate as written could observe the failure.

## Product decision

The supported OPFS write floor is **Safari 15.2+**: staging is written through
`createSyncAccessHandle()` inside a Worker.

## Verified support data

Read from `@mdn/browser-compat-data@8.1.0` rather than from memory:

| Feature | Safari | Safari iOS |
| --- | --- | --- |
| `FileSystemFileHandle.createWritable` | 26 | 26 |
| `FileSystemFileHandle.createSyncAccessHandle` | 15.2 | 15.2 |
| `FileSystemSyncAccessHandle.write` / `.flush` | 15.2 | 15.2 |
| `StorageManager.getDirectory` | 15.2 | 15.2 |
| `SharedArrayBuffer`, `crossOriginIsolated` | 15.2 | 15.2 |
| `LockManager.request` / `.query` | 15.4 | 15.4 |
| WebAssembly fixed-width SIMD | 16.4 | 16.4 |

The OPFS write floor is therefore 15.2, but the **session** floor is the
maximum of every gate in `assertEngineWebCapabilities`, which is **Safari
16.4** because the Engine's `simd128` backend requires WebAssembly SIMD. The
session floor and the OPFS write floor are distinct numbers and the README must
say so. Raising the SIMD floor is an Engine question and is out of scope here.

## Decisions taken

1. **One write path, not two.** `createSyncAccessHandle()` covers every target
   engine (Chrome 102+, Firefox 111+, Safari 15.2+). `createWritable()` is
   removed rather than kept as a non-Safari fast path: it would be a second
   code path with no result it alone can deliver, and the standing instruction
   is to converge on the simplest design that does not sacrifice results.
2. **A dedicated OPFS Worker, because no existing Worker can carry the write.**
   `createSyncAccessHandle()` must run off the main thread. The FLAC Worker is
   created and terminated per `resolve()` inside `FlacWorkerPool`, speaks a
   decode-only protocol, and does not exist at all on the already-decoded
   `resolver` escape hatch or during `index.json` writes. The pump Worker only
   exists after a lease is granted, which is after every write. The scratch
   Worker is closed before stem I/O begins. The new Worker is created lazily on
   the first open writer and terminated when the last writer settles, so an
   idle session holds no OPFS thread.
3. **The gate probes as close to the real method as the platform allows.**
   The issue asked for a synchronous gate on the method the store calls. That
   is not possible: `createSyncAccessHandle()` is `[Exposed=DedicatedWorker]`,
   verified empirically in both engines — on the window it reads `undefined`
   in Chromium 152 and WebKit 26.5, while `createWritable` reads `function`.
   So the gate is split:
   - `assertEngineWebCapabilities` synchronously requires
     `navigator.storage.getDirectory` **and** the `FileSystemFileHandle`
     interface, the strongest window-visible signals.
   - `OpfsStorageBackend.open()` awaits the OPFS Worker handshake, which
     carries the Worker scope's own `createSyncAccessHandle` probe, and refuses
     there. That is still before any resolver, network, or decode work, and
     before any directory is created.

   Both refusals are `EngineWebAdapterError` with code `capability.opfs` and
   `details.missing` / `details.remedy`. Nothing in the store surfaces an
   untyped `TypeError`.

## Objective gates

1. On Safari 17 and 18, `openEngineWebSession` either opens a working session
   or fails at the capability boundary with a typed error naming OPFS write
   support — never an untyped `TypeError` from inside the store.
2. A test exercises the OPFS write path under WebKit, not Chromium only.
3. README states the Safari floor for the *session*, distinct from the decoder.
4. No change to the decoder, the FLAC delivery path, or the Rust ABI.

## Evidence

- `npm run check` — format, source policy, typecheck, decoder policy, 88 Node
  tests (6 new, covering the previously untested `OpfsStorageBackend` against
  the real Worker module), packed package policy.
- `npm run test:browser` — packed fresh consumer, Chromium, unchanged.
- `npm run test:browser:opfs` — packed fresh consumer in **both** Chromium 152
  and WebKit 26.5, asserting a real `createSyncAccessHandle` ingest verified
  into OPFS (65_536 bytes), the same ingest with
  `FileSystemFileHandle.prototype.createWritable` deleted (the Safari 17/18
  shape), zero `createWritable` calls, a warm reopen that never re-resolves,
  and a typed `capability.opfs` refusal carrying a remedy.
- Sensitivity check: with `createWriter` temporarily reverted to
  `handle.createWritable()`, `test:browser:opfs` fails in the deleted-method
  phase with `TypeError: (intermediate value).createWritable is not a function`
  — the exact untyped failure this issue describes. The gate is not a false
  positive.
- OPFS in WebKit requires a real profile directory: `getDirectory()` returns
  `UnknownError` in an ephemeral Playwright context, so the gate launches both
  engines with `launchPersistentContext`.

## Verification limits

Playwright WebKit is a WebKit 26.x build, not Safari 17 or 18. It proves the
sync-access-handle path on the real WebKit engine and, with `createWritable`
deleted, proves the store never depends on the method Safari 17/18 lacks. It
does not prove behaviour on the shipped Safari 17/18 binaries; a device matrix
run remains outstanding, as `.github/ISSUE_SPECS/012` also records.

## Correction to the issue's framing

The issue says "the capability gate must test the method the store actually
calls". A synchronous main-thread gate cannot: the method is Worker-only in
every engine. The gate therefore refuses in two places, and the store's own
refusal is still ahead of all resolver and network work. The issue also implies
a Safari 15.2 session floor once OPFS is fixed; the SIMD128 gate makes the real
session floor 16.4. Both Safari majors named in the issue, 17 and 18, are above
that floor.

## Non-goals

The decoder, FLAC delivery, the Rust ABI, and the API-shape work in #9/#11.
The `remedy` field belongs on the single error class in #11; this issue puts
the remedy in `details` so the two do not collide.
