export const ADAPTER_PROVENANCE = Object.freeze({
  engine: Object.freeze({
    package: "@misofm/engine@0.1.0",
    repository: "misofm/engine",
    commit: "5360874854f47e3dbfa2279ec6c57174e5ca018e",
  }),
  safeBaselines: Object.freeze({
    stemStore: "bd7f330a9773ce43bb077f0e6d5c8fc30fe9e27c",
    browserComposition: "7485693e9bbcf2f65a91a4e5950e22d678d99062",
  }),
  copiedSources: Object.freeze([
    "hosts/host-web/web/stem-store/incremental-sha256.js (adapted to TypeScript)",
    "hosts/host-web/web/stem-store/opfs-store.js (store invariants independently adapted behind an injectable backend)",
    "hosts/host-web/web/stem-store/session-gate.js (adapted to the adapter lease vocabulary)",
    "hosts/host-web/web/stem-store/pcm-pump.js (adapted to TypeScript with fair scheduling and bounded windows)",
    "misofm/app src/lib/mixer/engine/sab-ring.ts at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (MSB1 reader/allocation contract adapted)",
    "misofm/app public/wasm/engine-feed/miso-sab-feed-prelude.js at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (packaged worklet prelude)",
    "misofm/app src/lib/mixer/engine/sab-feed.ts at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (attach-port and suspended-context handshake adapted)",
  ] as const),
});
