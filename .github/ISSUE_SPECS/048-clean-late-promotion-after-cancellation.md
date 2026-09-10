# Clean late OPFS promotion after cancellation

Independent review of adapter main 2c0d7928395db82744733d3dd5c045545eb366e9 and issue47 processing work reproduced a pre-existing cancellation race. A backend.move can remain in flight after the store's deadline/abort rejects. Store cleanup removes staging, releases the stem lock and rejects the opening; a delayed move can then finish and leave a verified but unindexed final PCM file.

No incorrect PCM was accepted, no source/session ready event was emitted, and the late bytes had already passed canonical verification. This is cleanup/transaction ownership debt, not introduced by the new concurrency policy. Root explicitly leaves it outside issue47 to avoid expanding that release into a storage transaction redesign.

Acceptance: deterministic delayed move and cancelled session, never-settling move deadlines, concurrent replacement opener, quota failure and restart cleanup. Late mutation must not corrupt another owner's final/index/pins or expose readiness; do not solve by awaiting an indefinitely stuck move or by deleting a new owner's final. Preserve bounded streaming, lock ordering and prompt cancellation. Implement from a separate numbered spec with focused and packed browser verification.
