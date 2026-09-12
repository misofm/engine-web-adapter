#!/usr/bin/env python3
"""Validate complete issue #77 receipts and export portable tables/evidence."""

import argparse
import csv
import json
from pathlib import Path
import shutil
import statistics

import run


def csv_write(path, rows):
    with path.open("w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    data = json.loads((args.work / "results.json").read_text())
    frozen = json.loads((args.work / "freeze.json").read_text())
    catalog = json.loads((run.HERE / "sources.json").read_text())
    run.require(data["freezeSha256"] == run.sha(args.work / "freeze.json"), "Freeze mismatch")
    run.require(frozen["sourcesSha256"] == run.sha(run.HERE / "sources.json"), "Source catalog mismatch")
    run.require(frozen["runnerSha256"] == run.sha(run.__file__), "Runner differs from measured version")
    expected = {r["identity"]: r for r in catalog["stems"]}
    candidates = ["original", *[c["id"] for c in frozen["candidates"]]]
    run.require(len(data["stems"]) == len(expected) and
                {r["identity"] for r in data["stems"]} == set(expected), "Missing/duplicate stems")
    rows = []
    for stem in data["stems"]:
        source = expected[stem["identity"]]
        run.require(len(stem["results"]) == len(candidates) and
                    {r["candidate"] for r in stem["results"]} == set(candidates), "Missing/duplicate candidate")
        for result in stem["results"]:
            run.require("sha256:" + result["canonicalPcmSha256"] == stem["identity"], "Unverified candidate")
            run.require(result["totalBytes"] == sum(result[k] for k in ["payloadBytes", "manifestBytes", "headerBytes"]),
                        "Unaccounted delivery bytes")
            cid = result["candidate"]
            if cid in ("published", "ffmpeg5-30s"):
                run.require(result["blobSha256"] == source["sha256"] and result["totalBytes"] == source["bytes"],
                            "Published replay mismatch")
            if cid != "original":
                directory = args.work / stem["identity"].split(":")[1] / cid
                blob = directory / "stem.blob"
                run.check_file(blob, result["totalBytes"], result["blobSha256"])
                manifest = json.loads((directory / "manifest.json").read_text())
                original = json.loads((run.HERE / source["manifestPath"]).read_text())
                run.require(manifest["intervals"] == original["intervals"], "Changed interval map")
                run.require(manifest["chunks"] == result["chunks"], "Chunk receipt mismatch")
            rows.append({"recordingRef": stem["recordingRef"], "source": "+".join(stem["sourceIDs"]),
                         "identity": stem["identity"], "candidate": cid,
                         **{k: result[k] for k in ["totalBytes", "payloadBytes", "manifestBytes", "headerBytes", "chunkCount",
                                                    "canonicalPcmSha256", "blobSha256"]},
                         "encodeSeconds": result["encode"]["wallSeconds"] if result["encode"] else None,
                         "decodeSeconds": result["decode"]["wallSeconds"],
                         "encodePeakRssKiB": result["encode"]["peakRssKiB"] if result["encode"] else None,
                         "decodePeakRssKiB": result["decode"]["peakRssKiB"],
                         "flacMetadataBytes": result["flacMetadataBytes"]})
    csv_write(args.output / "per-stem.csv", rows)
    sessions = []
    totals = []
    for cid in candidates:
        selected = [r for r in rows if r["candidate"] == cid]
        for ref in sorted({r["recordingRef"] for r in selected}):
            subset = [r for r in selected if r["recordingRef"] == ref]
            sessions.append({"recordingRef": ref, "candidate": cid,
                             **{k: sum(r[k] for r in subset) for k in
                                ["totalBytes", "payloadBytes", "manifestBytes", "headerBytes", "chunkCount"]}})
        total = {"candidate": cid, **{k: sum(r[k] for r in selected) for k in
                                     ["totalBytes", "payloadBytes", "manifestBytes", "headerBytes", "chunkCount"]}}
        total.update({"savingVsPublishedBytes": catalog["totals"]["bytes"] - total["totalBytes"],
                      "savingVsPublishedPercent": 100 * (1 - total["totalBytes"] / catalog["totals"]["bytes"]),
                      "encodeSeconds": sum(r["encodeSeconds"] for r in selected) if selected[0]["encodeSeconds"] is not None else None,
                      "decodeSeconds": sum(r["decodeSeconds"] for r in selected),
                      "encodePeakRssKiB": max(r["encodePeakRssKiB"] for r in selected) if selected[0]["encodePeakRssKiB"] is not None else None,
                      "decodePeakRssKiB": max(r["decodePeakRssKiB"] for r in selected),
                      "flacMetadataBytes": sum(r["flacMetadataBytes"] for r in selected) if selected[0]["flacMetadataBytes"] is not None else None})
        totals.append(total)
    csv_write(args.output / "per-session.csv", sessions)
    csv_write(args.output / "totals.csv", totals)
    plan = json.loads((args.work / "prepare-plan.json").read_text())
    trials = json.loads((args.work / "prepare-results.json").read_text())
    run.require(trials["planSha256"] == run.sha(args.work / "prepare-plan.json"), "Preparation plan mismatch")
    run.require(plan["resultsSha256"] == run.sha(args.work / "results.json"), "Preparation used different candidates")
    preparations = []
    for cid in plan["candidates"]:
        sums = []
        memories = []
        for trial in range(plan["trials"]):
            subset = [r for r in trials["rows"] if r["candidate"] == cid and r["trial"] == trial]
            run.require(len(subset) == len(expected) and {r["identity"] for r in subset} == set(expected),
                        "Missing/duplicate preparation result")
            for row in subset:
                run.require("sha256:" + row["canonicalPcmSha256"] == row["identity"], "Unverified preparation")
                run.require(row["sparseCacheBytes"] == expected[row["identity"]]["activePcmBytes"], "Wrong cache size")
            sums.append(sum(r["prepareSeconds"] for r in subset))
            memories.append(max(r["decoderProcesses"]["peakRssKiB"] for r in subset))
        preparations.append({"candidate": cid, "minimumSeconds": min(sums), "medianSeconds": statistics.median(sums),
                             "maximumSeconds": max(sums), "nativeDecoderPeakRssKiB": max(memories),
                             "trialSeconds": sums})
    run.write_json(args.output / "summary.json", {"totals": totals, "serverPreparation": preparations,
                   "verifiedCandidateCount": len(rows), "verifiedPreparationCount": len(trials["rows"]),
                   "screeningWallSeconds": data["wallSeconds"]})
    for name in ["freeze.json", "results.json", "prepare-plan.json", "prepare-results.json"]:
        shutil.copyfile(args.work / name, args.output / name)
    run.write_json(args.output / "evidence-hashes.json", {
        "files": {p.name: run.sha(p) for p in sorted(args.output.iterdir()) if p.name != "evidence-hashes.json" and p.is_file()}})
    print(json.dumps({"totals": totals, "serverPreparation": preparations}, indent=2))


if __name__ == "__main__":
    main()
