export const ADAPTER_PROVENANCE = Object.freeze({
  engine: Object.freeze({
    package: "@misofm/engine@0.2.2",
    repository: "misofm/engine",
    archiveSha256: "30639cf1f0f9707534020d584736339da3ef08981af5b6c5148f3ac310261e58",
    commit: "f991f8a4130e1c1a3f1476203afe88ea23903a92",
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
