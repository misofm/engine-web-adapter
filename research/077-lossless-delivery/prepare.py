#!/usr/bin/env python3
"""Issue #77 serial server preparation trials over already-downloaded candidates.

Native decode -> bounded pipe -> canonical SHA-256 -> sparse cache -> fsync/rename.
This does not implement or simulate a browser, HTTP, Wasm, or OPFS.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import time

import run

FINALISTS = ["published", "flac8-30s", "flac8e-30s", "flac8e-concat", "wavpackhhx6-concat"]


class DecodedReader:
    """One native process at a time; retain neither full chunks nor stems in RAM."""
    def __init__(self, paths, codec, tools, log_directory):
        self.paths = iter(paths)
        self.codec, self.tools, self.directory = codec, tools, log_directory
        self.process = None
        self.index = 0
        self.metrics = []

    def read(self, count):
        while True:
            if self.process is None:
                path = next(self.paths, None)
                if path is None:
                    return b""
                self.log = self.directory / f"{self.index}.time"
                self.stderr = self.log.with_suffix(".stderr").open("wb")
                self.process = subprocess.Popen(
                    ["/usr/bin/time", "-f", "%U %S %M", "-o", str(self.log),
                     *run.decoder(self.codec, self.tools, path)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.stderr)
                self.started = time.perf_counter()
                self.index += 1
            data = self.process.stdout.read(count)
            if data:
                return data
            self.process.stdout.close()
            code = self.process.wait()
            self.stderr.close()
            self.process = None
            run.require(code == 0, "Native decoder failed during preparation")
            user, system, rss = self.log.read_text().split()
            self.metrics.append({"wallSeconds": time.perf_counter() - self.started,
                                 "userSeconds": float(user), "systemSeconds": float(system),
                                 "peakRssKiB": int(rss)})

    def close(self):
        if self.process is not None:
            self.process.kill()
            self.process.wait()
            self.process.stdout.close()
            self.stderr.close()
            self.process = None


def prepare(row, candidate, args, tools, trial):
    identity = row["identity"].split(":")[1]
    manifest = json.loads((run.HERE / row["manifestPath"]).read_bytes())
    run.validate_manifest(manifest)
    source = args.work / identity / candidate
    packaged = json.loads((source / "manifest.json").read_bytes())
    run.require(packaged["intervals"] == manifest["intervals"], "Candidate interval map changed")
    codec = "wavpack" if candidate.startswith("wavpack") else "flac"
    paths = [source / f"{index}.{'wv' if codec == 'wavpack' else 'flac'}"
             for index in range(len(packaged["chunks"]))]
    # Validate all compressed identities outside the timed PCM preparation.
    for chunk, path in zip(packaged["chunks"], paths):
        run.check_file(path, chunk["bytes"], chunk["wavpackSha256" if codec == "wavpack" else "flacSha256"])
    directory = args.work / "prepare-trials" / str(trial) / candidate / identity
    directory.mkdir(parents=True)
    staging = directory / "staging.raw"
    digest = hashlib.sha256()
    reader = DecodedReader(paths, codec, tools, directory)
    started = time.perf_counter()
    end = 0
    written = 0
    try:
        with staging.open("wb") as dst:
            for interval in manifest["intervals"]:
                run.hash_zeros(digest, (interval["startFrame"] - end) * 6)
                count = interval["frames"] * 6
                run.transfer(reader, count, target=dst, digest=digest)
                written += count
                end = interval["startFrame"] + interval["frames"]
            run.hash_zeros(digest, (manifest["frames"] - end) * 6)
            run.require(not reader.read(1), "Trailing decoded data")
            run.require(written == row["activePcmBytes"], "Cache byte count mismatch")
            canonical = digest.hexdigest()
            run.require(canonical == identity, "Cache canonical PCM mismatch")
            dst.flush()
            os.fsync(dst.fileno())
        staging.rename(directory / "verified.raw")
        elapsed = time.perf_counter() - started
        (directory / "verified.raw").unlink()
        return {"identity": row["identity"], "recordingRef": row["recordingRef"],
                "candidate": candidate, "trial": trial, "prepareSeconds": elapsed,
                "sparseCacheBytes": written, "canonicalPcmSha256": canonical,
                "decoderProcesses": run.combine_metrics(reader.metrics)}
    finally:
        reader.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=3, choices=range(1, 6))
    args = parser.parse_args()
    args.work = args.work.resolve()
    frozen = json.loads((args.work / "freeze.json").read_text())
    results = json.loads((args.work / "results.json").read_text())
    run.require(results["freezeSha256"] == run.sha(args.work / "freeze.json"), "Result/freeze mismatch")
    tools = {name: metadata["executable"] for name, metadata in frozen["tools"].items()}
    for name, path in tools.items():
        run.require(run.sha(path) == frozen["tools"][name]["sha256"], "Codec binary changed")
    catalog = json.loads((run.HERE / "sources.json").read_text())
    run.require(run.sha(run.HERE / "sources.json") == frozen["sourcesSha256"], "Catalog changed")
    plan_path = args.work / "prepare-plan.json"
    run.require(not plan_path.exists(), "Trials already frozen; use a separate experiment directory")
    plan = {"format": "issue77-server-prepare-plan-v1", "scriptSha256": run.sha(__file__),
            "runnerSha256": run.sha(run.__file__), "resultsSha256": run.sha(args.work / "results.json"),
            "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "candidates": FINALISTS, "trials": args.trials, "workerConcurrency": 1,
            "orderSeed": 77, "order": [],
            "cacheState": "Warm compressed-file page cache from preflight SHA-256; fresh output each trial; fsync before rename",
            "scope": "Native preparation wall time includes decoder startup, pipe IO, canonical SHA-256 including synthesized gaps, sparse cache writes and fsync/rename. No network, browser or OPFS.",
            "memoryScope": "Maximum native decoder process RSS only; excludes Python and filesystem cache"}
    rng = random.Random(77)
    for trial in range(args.trials):
        order = list(FINALISTS)
        rng.shuffle(order)
        plan["order"].append(order)
    run.write_json(plan_path, plan)
    rows = []
    for trial, order in enumerate(plan["order"]):
        for candidate in order:
            before = len(rows)
            for row in catalog["stems"]:
                rows.append(prepare(row, candidate, args, tools, trial))
            elapsed = sum(row["prepareSeconds"] for row in rows[before:])
            print(f"trial {trial + 1} {candidate}: {elapsed:.3f}s serial verified sparse cache", flush=True)
    run.write_json(args.work / "prepare-results.json", {
        "format": "issue77-server-prepare-results-v1", "planSha256": run.sha(plan_path), "rows": rows})


if __name__ == "__main__":
    main()
