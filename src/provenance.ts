export const ADAPTER_PROVENANCE = Object.freeze({
  engine: Object.freeze({
    package: "@misofm/engine@0.2.6",
    repository: "misofm/engine",
    archiveSha256: "8219178d591c76d820d7ad2e2f7b894fe7f39185f89667f59c675fad603b81eb",
    commit: "cdf629d6bfd0224b3532dd0abd04b9581240da56",
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
