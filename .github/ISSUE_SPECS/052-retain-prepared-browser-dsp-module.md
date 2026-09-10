# Retain prepared browser DSP module through verified session opening

Base: adapter 6dbc3c8f9f0f9241780799d744c42ebecadb0b7c (unpublished 0.3.5). Upstream capability is specified in misofm/engine#719 on engine base 0df770b0f1f002b563246db70b71a3991fe8a8c7. The user authorizes continued Astra xhigh scalable 64-track work and cold-start iteration. No engine source is copied into adapter runtime.

## Problem and behavior

Shape-only scratch boot releases its compiled module before live engine creation, allowing first-use DSP compilation on the audio thread. The upstream engine adds a bounded worker preparation API returning validated shape plus WebAssembly.Module and an optional preparedModule host handoff. The adapter default must retain that exact result through complete canonical source verification and use it in live creation. No real source becomes ready during synthetic preparation; download concurrency, storage verification, shared runway, bounded pump memory and realtime PCM-only behavior remain unchanged.

Default opening calls prepareBrowserSessionWithWorker once with the owned document and policy snapshot, retains its module while storage ingests/verifies every source, then supplies preparedModule to createEngine and its default/custom host. Existing explicitly supplied scratchBoot remains a shape-only compatible escape hatch and omits preparedModule. Preserve deployment URL/worker factory overrides, abort causes, typed deadline/capability errors and exactly-once worker termination before storage begins. Do not add a user-visible preparation stage.

## Objective gates

Session tests prove default preparation once, physical worker termination before storage, no context/live host before verified lease, local module identity through delayed verification and host handoff, matching owned document/policy snapshots despite caller mutation, and continued custom scratch compatibility. Worker wrapper tests retain URL/factory forwarding, deadline translation, abort and clone failures. Run full adapter check and fresh packed healthy/terminal worker gates against the reviewed exact upstream engine archive. Final actual 64-track app graph qualification uses current unbatched writes, cold/warm sustained EOF crossing and repeated seeks, full independent source digests, HTTP concurrency four, and high-resolution full callback traces as specified by engine719.

Root owns reviewed engine-to-adapter-to-app version pins, main merge, publication and integration. No publication in this implementation tranche. Preserve all earlier immutable research and archives, including failed rehearsal variants and the 2.679ms instrumented warm trace residual.

## Status

Spec created before implementation. Engine719 feed cap checkpoint b69a01ab passes13 focused PCM tests; additive prepared-module API is being implemented and independently reviewed. Adapter191 tests and prior packed healthy/terminal gates pass at the base revision. New default consumption and exact packed qualification remain pending.

