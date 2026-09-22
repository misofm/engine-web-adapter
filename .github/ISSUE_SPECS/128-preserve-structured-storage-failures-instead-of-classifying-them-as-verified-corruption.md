# Preserve structured storage failures instead of classifying them as verified corruption

## Problem

The app investigation in `misofm/app#294` found that adapter 0.5.13 maps sparse
storage-open failures to `stem.corrupt`, before any download. UnknownError,
InvalidStateError, NotAllowedError, and NoModificationAllowedError injected at
root/open must not be reported as verified audio corruption. The original
device exception was not captured; injection does not establish that device's
root cause.

Base: upstream main `602b7c7b77d6228a73a0b9932a8809a8933ba692`, package
`@misofm/engine-web-adapter@0.5.13`, Engine `0.4.3`, Effect `4.0.0-rc.112`.

## Bounded T2 implementation

This issue owns only the upstream adapter's public storage-error contract and
the sparse-store/worker boundaries that implement it. It does not change app
code, the sparse format, shutdown ownership, or close retry policy.

- Introduce the documented public `storage.io` code for storage failures with
  additive operation/resource/granular-phase details.
- Preserve unknown browser exception names and causes without guessing from
  message text.
- Keep `stem.invalid_declaration` and `session.declaration_mismatch` for
  declaration/metadata failures, and reserve `stem.corrupt` for actual digest
  or byte-length verification evidence (`kind`, `expected`, `observed`, and
  `algorithm` where applicable).
- Preserve typed failures, Effect interruptions, defects, and every finalizer
  reason through the public edge and relevant Worker transports.
- Document supported close/cancellation semantics, add regression tests and an
  unreleased changelog/evidence entry, and qualify public exports on a packed
  artifact.

## Acceptance

- Inject root/open/read/write/close failures, including UnknownError,
  InvalidStateError, NotAllowedError, and NoModificationAllowedError; none is
  reported as verified integrity.
- Root-open refusal happens before resolver/network work and produces zero stem
  fetches.
- Genuine wrong digest and wrong length remain `stem.corrupt` with structured
  verification evidence.
- Invalid metadata/declaration remains distinct from storage and integrity
  failures.
- Worker round trips preserve nested causes, interruption/defect distinctions,
  and finalizer failures rather than flattening to the first reason.
- Public exports and package tests pass against a fresh packed artifact.

## Workflow and boundaries

Implementation is Luna reasoning=max followed by a fresh independent Astra
reasoning=medium verification. No spawning, push, PR creation, merge, or
publication is authorized here; coordinator owns reviewed integration.

The release metadata remains at version 0.5.13. Do not copy app sources,
patch `node_modules`, rewrite the sparse format, force shutdown, or invent a
retry of a failed physical close. Record exact commands, results, candidate
SHA, package provenance, fixture shape, close/cancellation semantics, and
browser capability limitations below.

## Implementation evidence

Reviewed implementation: `27795844c2ebaed2061eb0b6cdde0d15a2550973`
(parent `93cf2f790ea2ecba5428e8a32ac3bbc40c05b605`).
Fresh independent Astra medium review approved this exact clean candidate;
this subsequent evidence-only commit changes no source or test code.

Verification completed:

- `npm exec -- tsc -p tsconfig.test.json` — test compilation passed.
- `node --test .test-dist/tests/error-contract.test.js .test-dist/tests/sparse-store.test.js .test-dist/tests/opfs-storage.test.js` — 104/104 focused tests passed.
- Recursive reservation coverage — 1,026 nested pad cases (cause and causes, every pad length 0..512) plus the bounded Unicode/escape depth-width table passed serialization, repeat serialization, and revival; every serialized result stayed at or below 16,384 UTF-8 bytes and retained cause summaries were nonempty and valid.
- `npm run check` — passed, including format, wasm verification, lint, decoder checks, the full 396/396 test suite, and package policy (`248 files, 507013 bytes`).
- `CHROME_EXECUTABLE=/home/bl/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome npm run test:browser` — passed against the fresh packed consumer on Chromium 151.0.7922.34, 15 assets, no request failures or console errors. Artifact: `/tmp/engine-web-adapter-browser-TvwzzD`.

The real storage-root `installSource` boundary keeps foreign/nested
`stem.corrupt` payloads and invalid proof shapes under primary `storage.io`
evidence; only adapter-performed verification with a meaningful differing
canonical digest/byte-length proof can promote integrity corruption. The
public legacy constructor/API remains compatible. Native interruption,
physical write/body settlement, and cleanup failures retain explicit
`interruption`/`body`/`finalizer` roles; physical settlement and ownership stay
authoritative, and cached-close policy is unchanged.

Publication and app adoption remain outside this adapter change. Known
candidate OPFS Chromium-pass/Linux-WebKit capability evidence is retained;
the Linux WebKit `FileSystemFileHandle` capability failure was not rerun, and
WebKit OPFS and real iPhone qualification remain unconfirmed. The app release
gate remains open until its final combined candidate is qualified; fault
injection does not establish the original device trigger. No physical worker
code was changed to justify repeating that baseline capability run. The
fixed SDK is not published and app adoption awaits the normal reviewed release
workflow; neither merge nor publication is authorized by this work.

The committed public fixture `tests/fixtures/storage-error-contract.json`
records `storage.io`, coarse phase `store`, details
`{ operation: "open", resource: "sparse-root", phase: "root-open", failureKind: "io" }`,
and the retained `UnknownError` cause. Independent review of this exact candidate approved the recursive global
reservation invariant and retained all prior taxonomy, cancellation, physical
settlement, and integrity-proof closures. The reviewer independently ran
104 focused tests, the full 396-test check, and a fresh packed Chromium
consumer (artifact `/tmp/engine-web-adapter-browser-MHXdK5`, 15 assets, no
request failures or console errors). Generated verification covered 1,835
cases / 14,680 serialization checks with a maximum of 16,337 UTF-8 bytes;
full padding sweeps, deep/wide/mixed trees, Unicode, JSON escapes, six
reserializations, and revival retained useful mandatory summaries.
The coordinator synchronizes this evidence to the matching issue before PR
creation. Browser CI will separately qualify the exact PR candidate; no
unobserved WebKit or device result is claimed here.
