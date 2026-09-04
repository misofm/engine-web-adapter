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
  denseFlacEvidence: Object.freeze({
    appRepository: "misofm/app",
    appCommit: "7485693e9bbcf2f65a91a4e5950e22d678d99062",
    cliRepository: "misofm/cli",
    cliCommit: "94d94be1e858d01453ad4242e061ef2984502a00",
    note: "The adapter independently corrects the app parser's final-SEEKTABLE restriction.",
  }),
  copiedSources: Object.freeze([
    "hosts/host-web/web/stem-store/incremental-sha256.js (adapted to TypeScript)",
    "hosts/host-web/web/stem-store/opfs-store.js (store invariants independently adapted behind an injectable backend)",
    "hosts/host-web/web/stem-store/session-gate.js (adapted to the adapter lease vocabulary)",
    "hosts/host-web/web/stem-store/pcm-pump.js (adapted to TypeScript with fair scheduling and bounded windows)",
    "hosts/host-web/web/stem-store/pcm-pump-worker.js at bd7f330a9773ce43bb077f0e6d5c8fc30fe9e27c (serialized self-drive/control queue adapted)",
    "misofm/app src/lib/mixer/engine/sab-ring.ts at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (MSB1 reader/allocation contract adapted)",
    "misofm/app public/wasm/engine-feed/miso-sab-feed-prelude.js at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (packaged worklet prelude)",
    "misofm/app src/lib/mixer/engine/sab-feed.ts at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (attach-port and suspended-context handshake adapted)",
    "misofm/app dense FLAC metadata, packetizer, WebCodecs PCM and Worker-pool sources at 7485693e9bbcf2f65a91a4e5950e22d678d99062 (used as evidence and independently adapted; legal intervening/final metadata handling corrected)",
  ] as const),
});
