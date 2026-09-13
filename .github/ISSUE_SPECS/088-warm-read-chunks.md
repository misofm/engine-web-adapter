# Warm verification read chunk benchmark

User requested 512KiB, 1/2/4/8MiB versus128KiB to identify the best speed/memory compromise. App00f777135146c509486ea5248e66140420ba1e15, engine0.2.4, adapter0.5.0 from0564511db3c581b278dadc8440d3e4eb4880d83d. Sol scoped the experiment; fresh Sol independently reviewed the exact patch and all raw rows. No production change or package release.

Only the private published adapter copy's verifyMarker read step/end were parameterized. Ingest span limits, decoding, hashing, silence handling and concurrency were unchanged. Chromium145.0.7632.6/Linux, reported hardwareConcurrency32, app preference8. Every memory run observed8 overlapping page-realm Blob.arrayBuffer calls.

Five uninstrumented timing runs per size, in preselected rotated/reversed orders (partially counterbalanced), followed separate priming. Three additional memory runs per size sampled CDP main-isolate heap plus backing stores every25ms. All55rawrows completed; each warm row verified8stems,249323400readbytes and297980304hashedbytes.

| Chunk | Median ready ms | Median sampled peak main-isolate MiB | Read calls |
|---|---:|---:|---:|
|128KiB|2332.8|58.9|2238|
|512KiB|1916.4|60.0|845|
|1MiB|1920.6|67.4|622|
|2MiB|1950.7|69.8|516|
|4MiB|1912.1|69.6|461|
|8MiB|1845.1|81.4|439|

Recommendation:512KiB. About17.85% lower median ready time than128KiB; 8MiB saves only another71.3ms while substantially increasing memory exposure. The1/2/4MiB timing differences do not establish repeatable extra gain. Small single-machine/song sample; no cross-device guarantee. Memory values are medians of per-run maxima of simultaneous usedSize+backingStorageSize samples, not sums of independently peaked categories. They exclude worker/worklet and browser/OPFS internals, may miss brief peaks, and include GC variability; they are not total browser RSS.

Harness artifact defect disclosed: an init-script localStorage access on deliberate about:blank housekeeping navigations caused the final empty-errors assertion to fail after all55rows were saved. Independently reproduced on about:blank; timed app-origin runs reached all readiness/identity/byte assertions. Fresh review accepted the complete raw journal as directional evidence; no measurements rerun or discarded. Full report, exact executed and separate future origin-guarded harness, raw journal, samples and provenance are preserved at /tmp/miso-chunk-study/. No artist audio/session payloads are in this repository.
