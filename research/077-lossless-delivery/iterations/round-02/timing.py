#!/usr/bin/env python3
"""Serial warm-input decode trials for the frozen round-2 pilot artifacts.

The timed commands include native decode and output writes.  Hash and byte
verification runs after each command and is recorded separately.  Audit output
is disabled for both experimental helpers with an explicit ``-`` argument.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import time


COPY_BYTES = 1024 * 1024
PILOTS = [
    "ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
    "8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
    "fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
    "68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f",
]
HERE = Path(__file__).resolve().parents[2]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(COPY_BYTES):
            digest.update(block)
    return digest.hexdigest()


def warm(path: Path) -> None:
    with path.open("rb") as source:
        while source.read(COPY_BYTES):
            pass


def timed(command: list[str], receipt: Path, stdout=None) -> dict:
    receipt.parent.mkdir(parents=True, exist_ok=True)
    time_path = receipt.with_suffix(".time")
    stderr_path = receipt.with_suffix(".stderr")
    started = time.perf_counter()
    with stderr_path.open("wb") as stderr:
        result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(time_path), *command],
                                stdout=stdout, stderr=stderr, check=False)
    require(result.returncode == 0, f"timed command failed: {' '.join(command)}")
    values = time_path.read_text().split()
    require(len(values) == 3, "invalid /usr/bin/time receipt")
    return {"wallSeconds": time.perf_counter() - started,
            "userSeconds": float(values[0]), "systemSeconds": float(values[1]),
            "peakRssKiB": int(values[2]), "timedCommand": command,
            "hashVerificationInsideTimedInterval": False}


def decode_custom(helper: Path, compressed: Path, output: Path, summary: Path,
                  receipt: Path) -> dict:
    warm(compressed)
    return timed([str(helper), "decode", str(compressed), str(output), "-", str(summary)], receipt)


def decode_flac(flac: Path, chunks: list[Path], output: Path, receipt_root: Path) -> dict:
    for chunk in chunks:
        warm(chunk)
    started = time.perf_counter()
    parts = []
    for index, chunk in enumerate(chunks):
        receipt = receipt_root / f"chunk-{index}"
        with output.open("ab") as target:
            parts.append(timed([str(flac), "--decode", "--totally-silent", "--force", "--stdout",
                                "--force-raw-format", "--endian=little", "--sign=signed",
                                str(chunk)],
                               receipt, stdout=target))
    return {"wallSeconds": time.perf_counter() - started,
            "userSeconds": sum(item["userSeconds"] for item in parts),
            "systemSeconds": sum(item["systemSeconds"] for item in parts),
            "peakRssKiB": max(item["peakRssKiB"] for item in parts),
            "chunkCount": len(parts),
            "timedCommand": "serial flac decode per manifest chunk",
            "hashVerificationInsideTimedInterval": False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--pilot-work", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--flac", type=Path,
                        default=Path("/data/issue-77-lossless/tooling/flac-build/src/flac/flac"))
    parser.add_argument("--corpus", type=Path, default=Path("/data/issue-77-lossless/run-02"))
    parser.add_argument("--trials", type=int, default=3)
    args = parser.parse_args()
    args.work = args.work.resolve()
    args.pilot_work = args.pilot_work.resolve()
    args.helper = args.helper.resolve()
    args.flac = args.flac.resolve()
    args.corpus = args.corpus.resolve()
    require(args.trials == 3, "scope freezes exactly three timing trials")
    args.work.mkdir(parents=True, exist_ok=True)
    pilot_results = json.loads((args.pilot_work / "pilot-results.json").read_text())
    rows = {row["identity"].split(":", 1)[1]: row for row in pilot_results["stems"]}
    require(set(rows) == set(PILOTS), "pilot result set differs from timing set")
    manifests = {}
    verification = json.loads((HERE / "iterations" / "round-01-evidence" / "verification.json").read_text())
    for stem in PILOTS:
        v = next(item for item in verification["stems"] if item["identity"].endswith(stem))
        manifest = json.loads((HERE / "manifests" / f"{stem}.json").read_text())
        manifests[stem] = {"bytes": v["activePcmBytes"], "sha": v["packedPcmSha256"],
                           "manifest": manifest}
    freeze = {
        "format": "issue77-round2-timing-freeze-v1",
        "timingSha256": sha(Path(__file__)),
        "helper": {"path": str(args.helper), "sha256": sha(args.helper)},
        "flac": {"path": str(args.flac), "sha256": sha(args.flac)},
        "pilotWork": str(args.pilot_work),
        "pilotFreezeSha256": sha(args.pilot_work / "freeze.json"),
        "pilotResultsSha256": sha(args.pilot_work / "pilot-results.json"),
        "verificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "verification.json"),
        "corpus": str(args.corpus),
        "pilots": PILOTS,
        "trialCount": args.trials,
        "stemSeed": 0x77020000,
        "modeSeed": 0x7702A000,
        "modes": ["rice", "rans", "flac"],
        "compressedArtifacts": {
            stem: {mode: sha(args.pilot_work / "pilot" / stem / f"{mode}.ent")
                   for mode in ("rice", "rans")}
            for stem in PILOTS
        },
        "manifestSha256": {stem: sha(HERE / "manifests" / f"{stem}.json") for stem in PILOTS},
    }
    freeze_path = args.work / "timing-freeze.json"
    require(not freeze_path.exists(), "timing work directory is already frozen")
    freeze_path.write_text(json.dumps(freeze, indent=2) + "\n")
    trials = []
    for trial in range(args.trials):
        order = list(PILOTS)
        random.Random(0x77020000 + trial).shuffle(order)
        trial_root = args.work / f"trial-{trial + 1}"
        trial_root.mkdir(parents=True, exist_ok=True)
        modes = {}
        mode_order = ["rice", "rans", "flac"]
        random.Random(0x7702A000 + trial).shuffle(mode_order)
        for mode in mode_order:
            mode_root = trial_root / mode
            mode_root.mkdir(parents=True, exist_ok=True)
            stem_results = []
            for stem in order:
                row = rows[stem]
                expected = manifests[stem]
                output = mode_root / f"{stem}.raw"
                output.unlink(missing_ok=True)
                if mode == "flac":
                    chunks = [args.corpus / stem / "flac8e-30s" / f"{index}.flac"
                              for index, _ in enumerate(expected["manifest"]["chunks"])]
                    for chunk in chunks:
                        require(chunk.is_file(), f"missing FLAC chunk {chunk}")
                    measurement = decode_flac(args.flac, chunks, output, mode_root / f"{stem}.time")
                else:
                    compressed = args.pilot_work / "pilot" / stem / f"{mode}.ent"
                    summary = mode_root / f"{stem}.json"
                    measurement = decode_custom(args.helper, compressed, output, summary,
                                                mode_root / f"{stem}.time")
                    decoded_summary = json.loads(summary.read_text())
                    require(decoded_summary["auditBytes"] == 0, "audit-disabled trial wrote audit bytes")
                require(output.stat().st_size == expected["bytes"], f"{mode} output byte mismatch {stem}")
                require(sha(output) == expected["sha"], f"{mode} output hash mismatch {stem}")
                stem_results.append({"identity": "sha256:" + stem, "bytes": output.stat().st_size,
                                     "sha256": expected["sha"], "measurement": measurement})
                output.unlink()
            modes[mode] = {"order": order, "stems": stem_results,
                           "wallSeconds": sum(x["measurement"]["wallSeconds"] for x in stem_results),
                           "userSeconds": sum(x["measurement"]["userSeconds"] for x in stem_results),
                           "systemSeconds": sum(x["measurement"]["systemSeconds"] for x in stem_results),
                           "peakRssKiB": max(x["measurement"]["peakRssKiB"] for x in stem_results)}
        trials.append({"trial": trial + 1, "order": order, "modeOrder": mode_order, "modes": modes,
                       "hashVerificationInsideTimedInterval": False})
        print(json.dumps({"trial": trial + 1,
                          "seconds": {mode: modes[mode]["wallSeconds"] for mode in modes}}, sort_keys=True),
              flush=True)
    result = {"format": "issue77-round2-timing-v1", "trials": trials,
              "helper": str(args.helper), "flac": str(args.flac),
              "pilotWork": str(args.pilot_work), "corpus": str(args.corpus),
              "warmCompressedInput": True, "auditDisabledForCustom": True,
              "hashVerificationInsideTimedInterval": False}
    (args.work / "timing.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
