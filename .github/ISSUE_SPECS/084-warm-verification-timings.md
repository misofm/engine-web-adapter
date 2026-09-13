# Warm verification read and hash timings

Measure the existing warm sparse PCM verification path without changing storage, concurrency, hash algorithms, or readiness semantics. The app needs per-stem elapsed verification time, payload read wait time/count/bytes, and synchronous SHA update/finalization time including canonical zero gaps. Read waits include browser scheduling and overlap across sources; they are not physical disk timings. Emit one bounded optional progress snapshot after a successful digest check. Preserve cancellation and observer isolation.

Validation: byte/count coverage for sparse zero gaps, existing corruption/cancellation tests, package checks and packed browser warm open. Integrate the published patch into the app's existing load console report. No UI or OPFS optimization in this change.

Implementation: `StemProgress.verificationTiming` carries one completed snapshot per verified identity. `elapsedMs` starts at payload metadata admission (marker discovery precedes it); `metadataMs` covers that admission; `readWaitMs` brackets bounded payload reads; `hashMs` brackets SHA updates/finalization. Counters exclude marker reads and include canonical zero hashing. No per-buffer logging or retained PCM is added.

Validation: `npm run check` passed, including 329 tests and packed package policy. Packed indexed browser and macOS OPFS qualification are required before publication.
