# Five custom lossless coding design iterations

On 2026-09-12 the requester authorized five rounds of design iteration, with
**Astra xhigh scoping** and **Luna xhigh implementation**. This extends issue
#77's initial server report and supersedes its earlier decision to defer a
custom prototype. The experiments remain research; production format changes
are not authorized. The requester considers exact musical repetition a weak
candidate for microphone recordings, so the work focuses on residual entropy
models and stronger prediction.

Each round gets an Astra scope informed by available measurements, a Luna
implementation, a frozen experiment configuration, and a root verification
checkpoint before its findings inform the next round. Failed hypotheses count
as useful results. There is no promised compression improvement.

The frozen 30-stem corpus, canonical PCM identities, and active interval maps
from [the initial experiment](../README.md) remain the common comparison.
The main reference is libFLAC 1.5.0 `-8 -e` with the published 30-second chunk
boundaries: **425,415,665 bytes**, including per-stem headers and manifests.
An additional 25% reduction would require at most 319,061,748 bytes; a 50%
reduction would require at most 212,707,832 bytes (integer byte ceilings rounded
down). Per-stem and per-session results must accompany release totals.

Predictions stay identical when comparing entropy coders. Predictor changes
get separate comparisons. Every materialized codec candidate must reconstruct
the original canonical PCM exactly, including zero gaps and channel ordering.
All transmitted models, coefficients, indexes, headers, and manifests count.
Model estimates are labeled as estimates, not encoded byte totals or universal
entropy bounds. Cross-stem dictionaries/dependencies, lossy changes, silence
thresholds, production runtime edits, and engine/app source copying are excluded.

Scratch PCM, codec binaries, and generated encoded blobs live outside the
repository under `/data/issue-77-lossless/iterations/`; only reviewed code,
scopes, reproducible metadata, and measurement receipts are checkpointed here.
Existing initial-run scripts and evidence remain immutable. Server-only timing
and native memory evidence do not stand in for mobile/browser measurements.

| Round | Astra scope | Luna implementation and measurement | Verification |
| --- | --- | --- | --- |
| 1 | [Exact residual accounting](round-01-scope.md) | [Complete report](round-01-report.md): context model estimates 0.617% lower delivery bytes | All 30 reconstructions and exact accounting pass; optimized/sanitizer suites and four-stem sanitizer pilot pass |
| 2 | [Actual Rice vs context-rANS artifacts](round-02-scope.md) | [Complete report](round-02-report.md): 423,304,009 bytes, 0.496% below tuned FLAC | All 60 files, PCM/transcripts/accounting and 10,204 tables independently verified; optimized/sanitizer tests and pilot pass |
| 3 | [Adaptive residual FIR prediction](round-03-scope.md) | Implementation in progress | Pending |
| 4 | Pending round 3 findings | Pending | Pending |
| 5 | Pending round 4 findings | Pending | Pending |
