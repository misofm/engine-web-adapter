export const ADAPTER_PROVENANCE = Object.freeze({
  engine: Object.freeze({
    package: "@misofm/engine@0.3.0",
    repository: "misofm/engine",
    archiveSha256: "0da5f34d6d5e021f543acf21053b6176931548f3bbc584301c42c2f278f5b804",
    commit: "51e03cfdde61802fc8456872a6637a265fae5979",
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
    "hosts/host-web/web/stem-store/pcm-pump-worker.js at bd7f330a9773ce43bb077f0e6d5c8fc30fe9e27c (serialized self-drive/control queue adapted)",
  ] as const),
});
