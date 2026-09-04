/* Adapted verbatim from misofm/app 7485693e9bbcf2f65a91a4e5950e22d678d99062; see NOTICE. */
/**
 * The B3 shared-memory feed, worklet side — app-owned, not vendored.
 *
 * This module is added to the `AudioWorkletGlobalScope` *before* the engine's
 * own worklet module. It does two things and nothing else:
 *
 *  1. wraps the engine processor at the moment it registers itself, adding a
 *     `SharedArrayBuffer` drain at the top of `process()`;
 *  2. registers a second, tiny processor whose only job is to own a port the
 *     engine's strict message schema never sees, so the rings can be handed in
 *     without ever posting an unknown tag at the engine.
 *
 * ## Why a `registerProcessor` wrapper
 *
 * `public/wasm/engine-v1/miso-engine-v1-audio-worklet.js` is pinned engine
 * bytes and must not be edited, and it exports nothing — it declares a class
 * and calls `registerProcessor` at top level. A worklet module cannot import a
 * binding out of it. What it *can* do is share the global scope: every module
 * added to one `AudioWorklet` runs in the same `AudioWorkletGlobalScope`, so a
 * module that runs first can replace `registerProcessor` and receive the class
 * as an argument when the engine registers it. The engine's own bytes are
 * fetched, parsed and evaluated exactly as they are today; the only difference
 * is which function they hand their class to.
 *
 * Registration is total: whatever happens while wrapping, exactly one class is
 * registered under the engine's name, and if wrapping fails it is the engine's
 * own unmodified class. A broken prelude therefore degrades to the shipping
 * `postMessage` feed rather than to a context with no processor in it.
 *
 * ## Why the attach node, and why the rings arrive by port
 *
 * The engine processor's `receive()` turns any message it does not recognise
 * into a sticky `RESULT_INVALID_ARGUMENT` — a silent, permanent failure. So the
 * rings are not posted to it. They ride a separate node registered here, and
 * `new AudioWorkletNode(context, "miso-sab-feed-attach")` throwing is the main
 * thread's proof that this module is loaded and wrapping: the feature
 * detection is a constructor call, not a hopeful message. The caller
 * constructs it with no inputs and one output — Web Audio refuses a node with
 * neither — and never connects it, because construction alone is what builds
 * the processor that owns the port.
 *
 * They arrive on that node's **port**, and only on its port. Real Chromium
 * silently drops a `SharedArrayBuffer` passed through
 * `AudioWorkletNodeOptions.processorOptions`: the node constructs, the
 * processor is built, and the buffer is simply not in the options object it
 * receives. There is no error to catch on either side. A port message carries
 * it correctly, so there is exactly one route in and no second one to be
 * tempted by.
 *
 * ## What the drain does per block
 *
 * For each attached ring, once, at the top of `process()`, with no allocation
 * on the steady path and no `Atomics.wait` ever:
 *
 *   - apply a pending seek (a generation and a frame published through the
 *     ring, so a seek can never overtake or trail the planes around it);
 *   - drain published chunks, dropping any whose generation tag is stale;
 *   - copy each chunk's planes into the engine's existing PCM staging buffer
 *     and call the existing `miso_engine_web_v1_source_submit` export — the
 *     same copy, the same call and the same arguments the `postMessage` path
 *     makes, which is why the two render bit-identically;
 *   - stop, leaving the chunk in the ring, when the engine answers
 *     `RESULT_BACKPRESSURE`;
 *   - maintain the engine ring's depth and count a block that found it empty
 *     as an underrun.
 *
 * The engine never sees the shared buffer and never runs an atomic. Every
 * index, generation and counter in this file is JS, and its layout is pinned
 * against `src/lib/mixer/engine/sab-ring.ts` by `sab-ring-layout.test.ts`.
 */

const ENGINE_PROCESSOR_NAME = "miso-engine-v1-audio-worklet"
const ATTACH_PROCESSOR_NAME = "miso-sab-feed-attach"

const SAB_WRAP = 1 << 30
const SAB_WRAP_MASK = SAB_WRAP - 1
const SAB_MAGIC = 0x4d534231
const SAB_VERSION = 1

const CONTROL_MAGIC = 0
const CONTROL_VERSION = 1
const CONTROL_CAPACITY = 2
const CONTROL_CHANNELS = 3
const CONTROL_FRAME_CAPACITY = 4
const CONTROL_HEADER_OFFSET = 5
const CONTROL_PCM_OFFSET = 6
const CONTROL_ID_LENGTH = 7
const CONTROL_WRITE_INDEX = 8
const CONTROL_READ_INDEX = 9
const CONTROL_GENERATION_TAG = 10
const CONTROL_SEEK_EPOCH = 11
const CONTROL_WRITER_STATE = 12
const CONTROL_ATTACHED = 13
const CONTROL_WROTE = 14
const CONTROL_OVERFLOW = 15
const CONTROL_SUBMITTED = 16
const CONTROL_STALE = 17
const CONTROL_REFUSED = 18
const CONTROL_LAST_RESULT = 19
const CONTROL_UNDERRUNS = 20
const CONTROL_DRAIN_BLOCKS = 21
const CONTROL_SEEKS_APPLIED = 22
const CONTROL_DEPTH = 23
const CONTROL_TORN = 24
const CONTROL_FINISHED = 25
const CONTROL_ERRORS = 26
const CONTROL_SUBMITTED_GENERATION_TAG = 27

const CONTROL_BYTES = 128
const CONTROL_I64_OFFSET = 112
const CONTROL_I64_SEEK_GENERATION = 0
const CONTROL_I64_SEEK_FRAME = 1

const ID_OFFSET = 128

const SLOT_HEADER_BYTES = 32
const SLOT_SEQUENCE = 0
const SLOT_GENERATION_TAG = 1
const SLOT_FRAMES = 2
const SLOT_FLAGS = 3
// Two and three: the i64 pair sits after the four i32 words, and both views
// address the same 32 bytes.
const SLOT_I64_GENERATION = 2
const SLOT_I64_START_FRAME = 3
const FLAG_END_OF_REGION = 1

const RESULT_OK = 0
const RESULT_BACKPRESSURE = 6

/** The one engine processor in this scope, and any rings that arrived before
 *  it existed. Both nodes are constructed by the same main thread in a fixed
 *  order, but the queue costs one field and removes the ordering assumption. */
const registry = { engine: null, pending: null }

function deliver(rings) {
  if (registry.engine === null) {
    registry.pending = rings
    return
  }
  registry.engine.attachSharedRings(rings)
}

function withdraw(rings) {
  if (registry.engine === null) {
    registry.pending = null
    return
  }
  registry.engine.detachSharedRings(rings)
}

/** One bound ring: every view cut once, so the drain allocates nothing. */
function bindRing(shared, quantumFrames, maximumChannels) {
  if (
    typeof SharedArrayBuffer === "undefined" ||
    !(shared instanceof SharedArrayBuffer)
  ) {
    return null
  }
  if (shared.byteLength < CONTROL_BYTES) return null
  const control = new Int32Array(shared, 0, CONTROL_BYTES / 4)
  if (
    Atomics.load(control, CONTROL_MAGIC) !== SAB_MAGIC ||
    control[CONTROL_VERSION] !== SAB_VERSION
  ) {
    return null
  }
  const capacity = control[CONTROL_CAPACITY]
  const channels = control[CONTROL_CHANNELS]
  const frameCapacity = control[CONTROL_FRAME_CAPACITY]
  const headerOffset = control[CONTROL_HEADER_OFFSET]
  const pcmOffset = control[CONTROL_PCM_OFFSET]
  const idLength = control[CONTROL_ID_LENGTH]
  // A ring the engine could not accept a chunk from is worse than no ring: it
  // would refuse every block forever. Refuse it here instead, once.
  if (
    capacity <= 0 ||
    (capacity & (capacity - 1)) !== 0 ||
    channels <= 0 ||
    channels > maximumChannels ||
    frameCapacity !== quantumFrames ||
    idLength <= 0 ||
    headerOffset + capacity * SLOT_HEADER_BYTES !== pcmOffset ||
    pcmOffset + capacity * channels * frameCapacity * 4 > shared.byteLength
  ) {
    return null
  }
  const planes = []
  for (let slot = 0; slot < capacity; slot += 1) {
    const slotPlanes = []
    for (let channel = 0; channel < channels; channel += 1) {
      slotPlanes.push(
        new Float32Array(
          shared,
          pcmOffset + (slot * channels + channel) * frameCapacity * 4,
          frameCapacity
        )
      )
    }
    planes.push(slotPlanes)
  }
  return {
    shared,
    control,
    controlI64: new BigInt64Array(shared, CONTROL_I64_OFFSET, 2),
    headers: new Int32Array(
      shared,
      headerOffset,
      (capacity * SLOT_HEADER_BYTES) / 4
    ),
    headersI64: new BigInt64Array(
      shared,
      headerOffset,
      (capacity * SLOT_HEADER_BYTES) / 8
    ),
    idBytes: new Uint8Array(shared, ID_OFFSET, idLength),
    idLength,
    planes,
    capacity,
    channels,
    frameCapacity,
    /** The seek epoch this ring has already applied. */
    seenEpoch: Atomics.load(control, CONTROL_SEEK_EPOCH),
    /** Chunks the engine holds for this source but has not yet rendered. */
    depth: 0,
    finished: false,
    /** The staging-buffer id view, cut against the Wasm memory it was cut
     *  from; a memory that grew invalidates it and the drain re-cuts it. */
    idTarget: null,
    idTargetBuffer: null,
  }
}

/**
 * Add the drain to the engine processor.
 *
 * Only three methods exist here, and none of them changes anything the engine
 * does with a chunk: `process` runs the drain and then calls the engine's own
 * `process`, unmodified, for the same block.
 */
function wrapEngineProcessor(Base) {
  return class MisoSabFeedProcessor extends Base {
    constructor(options) {
      super(options)
      this.sabRings = []
      registry.engine = this
      if (registry.pending !== null) {
        const pending = registry.pending
        registry.pending = null
        this.attachSharedRings(pending)
      }
    }

    /**
     * Bind a set of rings. Called off the audio path, from an attach node's
     * construction.
     *
     * Additive and idempotent: a buffer already bound is rebound rather than
     * bound twice, and rings from an earlier attach are left alone. One
     * session per context is the only shape this app builds, but "the second
     * session silently unbinds the first" is not a failure worth leaving
     * available for the cost of a filter.
     */
    attachSharedRings(rings) {
      if (!Array.isArray(rings)) return
      const bound = []
      const incoming = []
      for (let index = 0; index < rings.length; index += 1) {
        const ring = bindRing(
          rings[index],
          this.quantumFrames,
          this.maximumSourceChannels
        )
        if (ring === null) continue
        incoming.push(ring.shared)
        bound.push(ring)
      }
      const kept = this.sabRings.filter(
        (ring) => incoming.indexOf(ring.shared) < 0
      )
      for (let index = 0; index < bound.length; index += 1) {
        // Cut the first-drain id view here, on the attach/control path. The
        // steady process path must never allocate a typed-array view.
        bound[index].idTarget = new Uint8Array(
          this.memoryBuffer,
          this.sourceIdPointer,
          Math.min(bound[index].idLength, this.sourceIdCapacity)
        )
        bound[index].idTargetBuffer = this.memoryBuffer
        Atomics.store(bound[index].control, CONTROL_ATTACHED, 1)
      }
      this.sabRings = kept.concat(bound)
    }

    /** Unbind exactly the rings an attach node brought, and nothing else. */
    detachSharedRings(rings) {
      if (!Array.isArray(rings)) return
      this.sabRings = this.sabRings.filter((ring) => {
        if (rings.indexOf(ring.shared) < 0) return true
        Atomics.store(ring.control, CONTROL_ATTACHED, 0)
        return false
      })
    }

    process(inputs, outputs) {
      const rings = this.sabRings
      if (
        rings !== undefined &&
        rings.length !== 0 &&
        this.ready === true &&
        this.disposed !== true &&
        this.stickyResult === RESULT_OK &&
        this.exports.memory.buffer === this.memoryBuffer
      ) {
        for (let index = 0; index < rings.length; index += 1) {
          const ring = rings[index]
          try {
            this.drainSharedRing(ring)
          } catch (_) {
            // A feed that throws must not take the render with it: the block
            // still renders from whatever the engine already holds, and the
            // counter says the feed is the reason it may run dry.
            ring.control[CONTROL_ERRORS] += 1
          }
        }
      }
      return super.process(inputs, outputs)
    }

    /** One ring, one block. Reads are `Atomics.load` on the writer's words and
     *  plain loads on its own; the single `Atomics.store` of the read index at
     *  the end is what releases the slots back to the writer. */
    drainSharedRing(ring) {
      const control = ring.control
      // Memory growth after attach invalidates the pre-cut view. Refuse this
      // drain rather than allocating a replacement inside process().
      if (ring.idTargetBuffer !== this.memoryBuffer) return
      if (ring.idTarget.length !== ring.idLength) return

      const epoch = Atomics.load(control, CONTROL_SEEK_EPOCH)
      if (epoch !== ring.seenEpoch) {
        ring.idTarget.set(ring.idBytes)
        const result = this.exports.miso_engine_web_v1_source_seek(
          this.handle,
          ring.idLength,
          ring.controlI64[CONTROL_I64_SEEK_GENERATION],
          ring.controlI64[CONTROL_I64_SEEK_FRAME]
        )
        if (result === RESULT_BACKPRESSURE) {
          // Ordinary flow control. Leave the epoch unseen and retry the same
          // seek before touching any slots on the next process call.
          return
        }
        if (result !== RESULT_OK) {
          control[CONTROL_REFUSED] += 1
          control[CONTROL_LAST_RESULT] = result
          return
        }
        ring.seenEpoch = epoch
        control[CONTROL_SEEKS_APPLIED] += 1
        // The engine dropped everything it held for this source.
        ring.depth = 0
        ring.finished = false
        control[CONTROL_FINISHED] = 0
      }

      const generationTag = Atomics.load(control, CONTROL_GENERATION_TAG)
      const write = Atomics.load(control, CONTROL_WRITE_INDEX)
      const capacityMask = ring.capacity - 1
      const staging = this.sourcePcm
      const quantumFrames = this.quantumFrames
      let read = control[CONTROL_READ_INDEX]

      while (read !== write) {
        const slot = read & capacityMask
        const word = slot * (SLOT_HEADER_BYTES / 4)
        if (ring.headers[word + SLOT_SEQUENCE] !== read) {
          // The slot the index points at is not the chunk the index names.
          // Only a second writer can do that; stop rather than submit it.
          control[CONTROL_TORN] += 1
          break
        }
        if (ring.headers[word + SLOT_GENERATION_TAG] !== generationTag) {
          read = (read + 1) & SAB_WRAP_MASK
          control[CONTROL_STALE] += 1
          continue
        }
        const frames = ring.headers[word + SLOT_FRAMES]
        const flags = ring.headers[word + SLOT_FLAGS]
        if (frames <= 0 || frames > ring.frameCapacity) {
          read = (read + 1) & SAB_WRAP_MASK
          control[CONTROL_ERRORS] += 1
          continue
        }
        const slotPlanes = ring.planes[slot]
        for (let channel = 0; channel < ring.channels; channel += 1) {
          const plane = slotPlanes[channel]
          // A full quantum is the steady case and copies the view as it is;
          // only a region's last chunk is short, and only it cuts a subview.
          // Every slot plane is pre-zeroed by the writer. Copy its full fixed
          // quantum even for the legal tail, avoiding a tail subview allocation.
          staging.set(plane, channel * quantumFrames)
        }
        ring.idTarget.set(ring.idBytes)
        const word64 = slot * (SLOT_HEADER_BYTES / 8)
        const result = this.exports.miso_engine_web_v1_source_submit(
          this.handle,
          ring.idLength,
          ring.headersI64[word64 + SLOT_I64_GENERATION],
          ring.headersI64[word64 + SLOT_I64_START_FRAME],
          ring.channels,
          frames,
          (flags & FLAG_END_OF_REGION) !== 0 ? 1 : 0
        )
        if (result === RESULT_BACKPRESSURE) {
          // The engine's ring is full. Leave the chunk where it is — this is
          // the backpressure that keeps the feeder from running ahead.
          break
        }
        read = (read + 1) & SAB_WRAP_MASK
        if (result === RESULT_OK) {
          // Publish the generation only after the engine accepted its PCM.
          // The main-thread start gate compares this with GENERATION_TAG, so
          // lifetime-cumulative SUBMITTED can never validate a later seek.
          Atomics.store(
            control,
            CONTROL_SUBMITTED_GENERATION_TAG,
            ring.headers[word + SLOT_GENERATION_TAG]
          )
          control[CONTROL_SUBMITTED] += 1
          ring.depth += 1
          if ((flags & FLAG_END_OF_REGION) !== 0) {
            ring.finished = true
            control[CONTROL_FINISHED] = 1
          }
        } else {
          control[CONTROL_REFUSED] += 1
          control[CONTROL_LAST_RESULT] = result
        }
      }

      Atomics.store(control, CONTROL_READ_INDEX, read)
      control[CONTROL_DRAIN_BLOCKS] += 1
      // The block about to be rendered consumes one quantum of this source.
      // Reaching zero with a live feeder and audio still to come is exactly
      // what an underrun is, and it is counted here because it is the only
      // place that knows it.
      if (ring.depth > 0) {
        ring.depth -= 1
      } else if (
        !ring.finished &&
        Atomics.load(control, CONTROL_WRITER_STATE) === 1
      ) {
        control[CONTROL_UNDERRUNS] += 1
      }
      control[CONTROL_DEPTH] = ring.depth
    }
  }
}

/** The rings' way in. Owns a port the engine's schema never reads, so nothing
 *  here can put the engine into a sticky state. */
class MisoSabFeedAttachProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // What this node brought, so a detach can withdraw exactly that and not
    // another session's rings. It starts empty: nothing is delivered at
    // construction, because `processorOptions` cannot carry a ring.
    this.delivered = []
    this.port.onmessage = (event) => {
      const data = event.data
      if (data === null || typeof data !== "object") return
      if (data.op === "attach" && Array.isArray(data.rings)) {
        this.delivered = data.rings
        deliver(data.rings)
      } else if (data.op === "detach") {
        withdraw(this.delivered)
        this.delivered = []
      }
    }
  }

  process() {
    return true
  }
}

const originalRegister = globalThis.registerProcessor
if (typeof originalRegister !== "function") {
  throw new TypeError("miso-sab-feed: no registerProcessor in this scope")
}

function interceptingRegister(name, constructor) {
  if (name !== ENGINE_PROCESSOR_NAME) {
    originalRegister.call(globalThis, name, constructor)
    return
  }
  globalThis.registerProcessor = originalRegister
  let Registered = constructor
  try {
    Registered = wrapEngineProcessor(constructor)
  } catch (_) {
    // Wrapping failed. The engine's own class is registered unchanged and the
    // attach node is simply never told about any rings, which is the shipping
    // `postMessage` feed — not a context with nothing registered in it.
    Registered = constructor
  }
  originalRegister.call(globalThis, name, Registered)
}

globalThis.registerProcessor = interceptingRegister
// A scope that will not take the patch must fail here, while the main thread
// is still awaiting `addModule` and can still choose the message path — never
// later, when the engine has already registered itself unwrapped.
if (globalThis.registerProcessor !== interceptingRegister) {
  throw new TypeError("miso-sab-feed: registerProcessor is not patchable")
}

originalRegister.call(
  globalThis,
  ATTACH_PROCESSOR_NAME,
  MisoSabFeedAttachProcessor
)
