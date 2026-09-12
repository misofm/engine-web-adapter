#!/usr/bin/env python3
"""Three serial, warm-input timing trials for the fixed round-5 candidates."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import time

HERE = Path(__file__).resolve().parents[2]
PILOTS = [
    "ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
    "8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
    "fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
    "68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f",
]
TRIALS = 3
STEM_SEED = 0x77050000
MODE_SEED = 0x7705A000
CANDIDATES = ("flac", "wavpack", "r3-p3-rans", "r5-p0-rans", "r5-p1-rans", "r5-p2-rans")
DEFAULT_CORPUS = Path("/data/issue-77-lossless/run-02")
DEFAULT_R3_WORK = Path("/data/issue-77-lossless/iterations/round-03/full-final")
DEFAULT_R4_WORK = Path("/data/issue-77-lossless/iterations/round-04/full-final3")
FLAC_DEFAULT = Path("/data/issue-77-lossless/tooling/flac-build/src/flac/flac")
WVU_DEFAULT = Path("/data/issue-77-lossless/tooling/wavpack-build/wvunpack")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    require(path.is_file(), f"missing file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def info(path: Path) -> dict:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha(path)}


def check_info(entry: dict, label: str) -> None:
    path = Path(entry["path"])
    require(path.stat().st_size == entry["bytes"] and sha(path) == entry["sha256"], f"changed frozen {label}")


def read_json(path: Path) -> dict:
    require(path.is_file(), f"missing JSON: {path}")
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"JSON object required: {path}")
    return value


def warm(path: Path) -> None:
    with path.open("rb") as source:
        while source.read(1024 * 1024):
            pass


def timed(command: list[str], receipt: Path, stdout=None) -> dict:
    receipt.parent.mkdir(parents=True, exist_ok=True)
    time_path, stderr_path = receipt.with_suffix(".time"), receipt.with_suffix(".stderr")
    require(not time_path.exists() and not stderr_path.exists(), f"stale timing receipt: {receipt}")
    started = time.perf_counter()
    with stderr_path.open("wb") as stderr:
        result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(time_path), *command],
                                stdout=stdout, stderr=stderr, check=False)
    wall_seconds = time.perf_counter() - started
    require(result.returncode == 0, f"timed command failed ({result.returncode}): {' '.join(command)}")
    require(stderr_path.stat().st_size == 0, f"timed command wrote stderr: {' '.join(command)}")
    values = time_path.read_text().split()
    require(len(values) == 3, f"bad GNU time receipt: {time_path}")
    return {"wallSeconds": wall_seconds, "userSeconds": float(values[0]),
            "systemSeconds": float(values[1]), "peakRssKiB": int(values[2]),
            "timedCommand": command, "hashVerificationInsideTimedInterval": False,
            "pcmWriteInsideTimedInterval": True}


def decode_flac(flac: Path, chunks: list[Path], output: Path, root: Path) -> dict:
    for chunk in chunks:
        warm(chunk)
    parts = []
    started = time.perf_counter()
    for index, chunk in enumerate(chunks):
        with output.open("ab") as target:
            parts.append(timed([str(flac), "--decode", "--totally-silent", "--force", "--stdout",
                                "--force-raw-format", "--endian=little", "--sign=signed", str(chunk)],
                               root / f"chunk-{index}", stdout=target))
    return {"wallSeconds": time.perf_counter() - started,
            "userSeconds": sum(x["userSeconds"] for x in parts),
            "systemSeconds": sum(x["systemSeconds"] for x in parts),
            "peakRssKiB": max(x["peakRssKiB"] for x in parts), "chunkCount": len(parts),
            "chunks": parts,
            "timedCommand": "serial flac decode per manifest chunk",
            "hashVerificationInsideTimedInterval": False, "pcmWriteInsideTimedInterval": True}


def decode_wavpack(wvunpack: Path, compressed: Path, output: Path, receipt: Path) -> dict:
    warm(compressed)
    return timed([str(wvunpack), "-q", "--no-threads", "--raw", str(compressed), "-o", str(output)], receipt)


def verify_pcm(output: Path, expected: dict, manifest: dict) -> None:
    require(output.stat().st_size == expected["activePcmBytes"] and sha(output) == expected["packedPcmSha256"],
            f"timed PCM mismatch: {output}")
    r2_path = HERE / "iterations/round-02/round2.py"
    spec = importlib.util.spec_from_file_location("round2_timing_r5", r2_path)
    require(spec is not None and spec.loader is not None, "cannot load PCM verifier")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    require(module.canonical_hash(output, manifest) == expected["identity"].split(":", 1)[1],
            f"canonical PCM mismatch: {output}")
    require(module.chunk_hashes(output, manifest) == [x["pcmSha256"] for x in manifest["chunks"]],
            f"chunk PCM mismatch: {output}")


def validate_custom_summary(summary: dict, candidate: str, compressed: Path,
                            expected_records: int) -> None:
    if candidate == "r3-p3-rans":
        require(summary.get("format") == "issue77-round3-summary-v1" and
                summary.get("mode") == 1 and summary.get("predictorProfile") == 3,
                f"bad R3 timing summary: {compressed}")
    else:
        policy = int(candidate[4])
        require(summary.get("format") == "issue77-round5-summary-v1" and
                summary.get("mode") == 1 and summary.get("policy") == policy,
                f"bad R5 timing summary: {compressed}")
    require(summary.get("recordCount") == expected_records and
            summary.get("frameCount") == expected_records and
            summary.get("inputRecordCount") == expected_records and
            summary.get("fileBytes") == compressed.stat().st_size and
            summary.get("auditBytes") == 0 and summary.get("originalAuditBytes") == 0,
            f"custom timing summary mismatch: {compressed}")


def validate_prior(work: Path, kind: str, expected_result_sha: str | None = None) -> tuple[dict, dict]:
    freeze = read_json(work / "freeze.json")
    result_path = work / "results.json"
    result = read_json(result_path)
    root = read_json(work / "root-verification.json")
    require(freeze.get("format") == f"issue77-round{3 if kind == 'r3' else 4}-freeze-v1" and
            result.get("stemCount") == 30 and result.get("freezeSha256") == sha(work / "freeze.json") and
            root.get("allChecksPassed") is True and root.get("artifactCount") == 120 and
            root.get("resultsSha256") == sha(result_path), f"invalid {kind} prior receipt")
    if expected_result_sha is not None:
        require(sha(result_path) == expected_result_sha, f"unexpected {kind} result SHA")
    return freeze, result


def validate_r5(work: Path, helper: Path) -> tuple[dict, dict]:
    freeze = read_json(work / "freeze.json")
    result = read_json(work / "results.json")
    root = read_json(work / "root-verification.json")
    require(freeze.get("format") == "issue77-round5-freeze-v1" and freeze.get("runKind") == "full" and
            freeze.get("policies") == [0, 1, 2] and freeze.get("workerConcurrency") == 4 and
            result.get("format") == "issue77-round5-results-v1" and result.get("stemCount") == 30 and
            result.get("policies") == [0, 1, 2] and result.get("freezeSha256") == sha(work / "freeze.json") and
            root.get("allChecksPassed") is True and root.get("artifactCount") == 180 and
            root.get("resultsSha256") == sha(work / "results.json"), "invalid R5 full receipt")
    require(Path(freeze["helper"]["path"]).resolve() == helper and freeze["helper"]["sha256"] == sha(helper),
            "R5 helper differs from full freeze")
    require(freeze.get("runnerSha256") == sha(HERE / "iterations/round-05/round5.py") and
            freeze.get("nativeSha256") == sha(HERE / "iterations/round-05/native/round5.c"),
            "R5 source differs from full freeze")
    for label, entry in freeze.get("files", {}).items():
        check_info(entry, f"R5 full dependency {label}")
    for stem, entries in freeze.get("inputFiles", {}).items():
        for label, entry in entries.items():
            check_info(entry, f"R5 full input {stem}/{label}")
    return freeze, result


def validate_baseline_recipe(args: argparse.Namespace, evidence_results: dict,
                             evidence_freeze: dict) -> dict:
    require(evidence_results.get("format") == "issue77-server-results-v1" and
            evidence_results.get("freezeSha256") == sha(HERE / "evidence/freeze.json"),
            "baseline evidence is not bound to its frozen recipe")
    require(evidence_freeze.get("sourcesSha256") == sha(HERE / "sources.json") and
            evidence_freeze.get("runnerSha256") == sha(HERE / "run.py") and
            evidence_freeze.get("workerConcurrency") == 4 and
            evidence_freeze.get("codecThreads") == "WavPack explicitly 1; libFLAC default 1; FFmpeg publication defaults",
            "baseline source/runner/thread recipe differs from the frozen evidence")
    manifest_hashes = evidence_freeze.get("manifestSha256", {})
    require(len(manifest_hashes) == 30, "baseline manifest recipe does not cover all stems")
    for relative, expected_hash in manifest_hashes.items():
        manifest_path = HERE / relative
        require(manifest_path.is_file() and sha(manifest_path) == expected_hash,
                f"baseline manifest changed: {relative}")
    candidates = {row.get("id"): row for row in evidence_freeze.get("candidates", [])}
    require(candidates.get("flac8e-30s", {}).get("codec") == "flac" and
            candidates.get("flac8e-30s", {}).get("options") == ["-8", "-e"] and
            candidates.get("flac8e-30s", {}).get("layout") == "30s" and
            candidates.get("wavpackhhx6-concat", {}).get("codec") == "wavpack" and
            candidates.get("wavpackhhx6-concat", {}).get("options") == ["-hh", "-x6"] and
            candidates.get("wavpackhhx6-concat", {}).get("layout") == "concat",
            "baseline codec recipe differs from the frozen evidence")
    tool_receipts = evidence_freeze.get("tools", {})
    require(Path(tool_receipts.get("flac", {}).get("executable", "")).resolve() == args.flac and
            Path(tool_receipts.get("wvunpack", {}).get("executable", "")).resolve() == args.wvunpack and
            tool_receipts.get("flac", {}).get("sha256") == sha(args.flac) and
            tool_receipts.get("wvunpack", {}).get("sha256") == sha(args.wvunpack),
            "FLAC/WavPack decoder differs from frozen tooling receipt")
    return {"format": "issue77-round5-timing-baseline-recipe-v1", "allChecksPassed": True,
            "manifestCount": len(manifest_hashes), "flacSha256": sha(args.flac),
            "wvunpackSha256": sha(args.wvunpack)}


def validate_baseline_inputs(args: argparse.Namespace, r3_result: dict, r4_result: dict,
                             evidence_results: dict, evidence_freeze: dict) -> dict:
    """Validate all fixed non-R5 timing inputs before a custom full run exists."""
    r3_rows = {x["identity"].split(":", 1)[1]: x for x in r3_result["stems"]}
    r4_rows = {x["identity"].split(":", 1)[1]: x for x in r4_result["stems"]}
    evidence_rows = {x["identity"].split(":", 1)[1]: x for x in evidence_results["stems"]}
    require(set(evidence_rows) == set(r3_rows) == set(r4_rows) and len(evidence_rows) == 30,
            "baseline identity set is not the fixed 30-stem corpus")
    manifest_hashes = evidence_freeze.get("manifestSha256", {})
    require(len(manifest_hashes) == 30, "baseline manifest recipe does not cover all stems")
    counts = {"manifests": 0, "r3P3Rice": 0, "r3P3Rans": 0,
              "r4P2Rice": 0, "r4P2Rans": 0, "flacChunks": 0, "wavpack": 0}
    for stem in sorted(evidence_rows):
        manifest_path = HERE / "manifests" / f"{stem}.json"
        require(manifest_hashes.get(f"manifests/{stem}.json") == sha(manifest_path),
                f"baseline manifest changed: {stem}")
        manifest = read_json(manifest_path)
        counts["manifests"] += 1
        baseline = evidence_rows[stem]
        flac_baseline = next(item for item in baseline["results"] if item["candidate"] == "flac8e-30s")
        wv_baseline = next(item for item in baseline["results"] if item["candidate"] == "wavpackhhx6-concat")
        require(flac_baseline["canonicalPcmSha256"] == stem and
                wv_baseline["canonicalPcmSha256"] == stem and
                flac_baseline["packedPcmSha256"] == r4_rows[stem]["packedPcmSha256"] and
                wv_baseline["packedPcmSha256"] == r4_rows[stem]["packedPcmSha256"],
                f"baseline PCM identity differs: {stem}")
        for version, work, row, profile, suffix in (
                (3, args.r3_work, r3_rows[stem], 3, "fir"),
                (4, args.r4_work, r4_rows[stem], 2, "xch")):
            for mode in ("rice", "rans"):
                expected = row["profiles"][str(profile)][mode]
                path = work / "full" / stem / f"p{profile}-{mode}.{suffix}"
                require(path.is_file() and path.stat().st_size == expected["outputBytes"] and
                        sha(path) == expected["outputSha256"],
                        f"baseline round-{version} artifact differs: {path}")
                counts[(f"r3P3{mode.title()}" if version == 3 else
                        f"r4P2{mode.title()}")] += 1
        for index, expected_chunk in enumerate(flac_baseline["chunks"]):
            chunk = args.corpus / stem / "flac8e-30s" / f"{index}.flac"
            actual = info(chunk)
            require(actual["bytes"] == expected_chunk["bytes"] and
                    actual["sha256"] == expected_chunk["flacSha256"],
                    f"baseline FLAC chunk differs: {chunk}")
            counts["flacChunks"] += 1
        wv = args.corpus / stem / "wavpackhhx6-concat" / "0.wv"
        actual_wv = info(wv)
        expected_wv = wv_baseline["chunks"][0]
        require(actual_wv["bytes"] == expected_wv["bytes"] and
                actual_wv["sha256"] == expected_wv["wavpackSha256"],
                f"baseline WavPack artifact differs: {wv}")
        counts["wavpack"] += 1
    return {"format": "issue77-round5-timing-baseline-preflight-v1", "stemCount": 30,
            "counts": counts, "allChecksPassed": True}


def validate_inputs(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict]:
    r5_freeze, r5_result = validate_r5(args.r5_work, args.helper)
    r3_freeze, r3_result = validate_prior(args.r3_work, "r3")
    r4_freeze, r4_result = validate_prior(args.r4_work, "r4", "9f4452056a6ac93a4a76f3d2820c5a2c224ad987ea08f01c5a55f4b8412b3056")
    evidence_results = read_json(HERE / "evidence/results.json")
    evidence_freeze = read_json(HERE / "evidence/freeze.json")
    validate_baseline_recipe(args, evidence_results, evidence_freeze)
    evidence_rows = {row["identity"].split(":", 1)[1]: row for row in evidence_results["stems"]}
    baseline_preflight = validate_baseline_inputs(args, r3_result, r4_result,
                                                  evidence_results, evidence_freeze)
    rows = {x["identity"].split(":", 1)[1]: x for x in r5_result["stems"]}
    r3_rows = {x["identity"].split(":", 1)[1]: x for x in r3_result["stems"]}
    r4_rows = {x["identity"].split(":", 1)[1]: x for x in r4_result["stems"]}
    require(set(rows) == set(r3_rows) == set(r4_rows), "prior/R5 identity sets differ")
    manifests, artifacts = {}, {}
    for stem in sorted(rows):
        manifest_path = HERE / "manifests" / f"{stem}.json"
        manifest = read_json(manifest_path)
        manifests[stem] = info(manifest_path)
        expected = rows[stem]
        baseline = evidence_rows[stem]
        flac_baseline = next(item for item in baseline["results"] if item["candidate"] == "flac8e-30s")
        wv_baseline = next(item for item in baseline["results"] if item["candidate"] == "wavpackhhx6-concat")
        canonical_identity = expected["identity"].split(":", 1)[1]
        require(flac_baseline["canonicalPcmSha256"] == canonical_identity and
                flac_baseline["packedPcmSha256"] == expected["packedPcmSha256"] and
                wv_baseline["canonicalPcmSha256"] == canonical_identity and
                wv_baseline["packedPcmSha256"] == expected["packedPcmSha256"],
                f"baseline PCM identity differs: {stem}")
        require(expected["activePcmBytes"] == r4_rows[stem]["activePcmBytes"] and expected["packedPcmSha256"] == r4_rows[stem]["packedPcmSha256"],
                f"R5 expected PCM differs: {stem}")
        artifacts[stem] = {}
        for policy in (0, 1, 2):
            path = args.r5_work / "full" / stem / f"p{policy}-rans.mix"
            expected_art = expected["policies"][str(policy)]["rans"]
            require(path.is_file() and path.stat().st_size == expected_art["outputBytes"] and sha(path) == expected_art["outputSha256"],
                    f"R5 artifact differs from result: {path}")
            artifacts[stem][f"r5-p{policy}-rans"] = info(path)
        r3_path = args.r3_work / "full" / stem / "p3-rans.fir"
        expected_r3 = r3_rows[stem]["profiles"]["3"]["rans"]
        require(r3_path.is_file() and r3_path.stat().st_size == expected_r3["outputBytes"] and sha(r3_path) == expected_r3["outputSha256"],
                f"R3 artifact differs from result: {r3_path}")
        artifacts[stem]["r3-p3-rans"] = info(r3_path)
        chunks = []
        for index, _ in enumerate(manifest["chunks"]):
            chunk = args.corpus / stem / "flac8e-30s" / f"{index}.flac"
            require(chunk.is_file(), f"missing FLAC chunk: {chunk}")
            expected_chunk = flac_baseline["chunks"][index]
            actual_chunk = info(chunk)
            require(actual_chunk["bytes"] == expected_chunk["bytes"] and actual_chunk["sha256"] == expected_chunk["flacSha256"],
                    f"FLAC chunk differs from frozen evidence: {chunk}")
            chunks.append(actual_chunk)
        artifacts[stem]["flac"] = chunks
        wv = args.corpus / stem / "wavpackhhx6-concat" / "0.wv"
        require(wv.is_file(), f"missing WavPack artifact: {wv}")
        actual_wv = info(wv); expected_wv = wv_baseline["chunks"][0]
        require(actual_wv["bytes"] == expected_wv["bytes"] and actual_wv["sha256"] == expected_wv["wavpackSha256"],
                f"WavPack artifact differs from frozen evidence: {wv}")
        artifacts[stem]["wavpack"] = actual_wv
    dependencies = {"timing": info(Path(__file__)), "r5Runner": info(HERE / "iterations/round-05/round5.py"),
                    "r5Native": info(HERE / "iterations/round-05/native/round5.c"), "r5Helper": info(args.helper),
                    "r5Freeze": info(args.r5_work / "freeze.json"), "r5Results": info(args.r5_work / "results.json"),
                    "r5Root": info(args.r5_work / "root-verification.json"), "r3Freeze": info(args.r3_work / "freeze.json"),
                    "r3Results": info(args.r3_work / "results.json"), "r3Root": info(args.r3_work / "root-verification.json"),
                    "r3Helper": info(Path(r3_freeze["helper"]["path"])), "r4Freeze": info(args.r4_work / "freeze.json"),
                    "r4Results": info(args.r4_work / "results.json"), "r4Root": info(args.r4_work / "root-verification.json"),
                    "r4Helper": info(Path(r4_freeze["helper"]["path"])), "sources": info(HERE / "sources.json"),
                    "runPy": info(HERE / "run.py"),
                    "r1Verification": info(HERE / "iterations/round-01-evidence/verification.json"),
                    "r1Root": info(HERE / "iterations/round-01-evidence/root-verification.json"),
                    "originalAudit": info(HERE / "iterations/round-03-evidence/root-original-audit.json"),
                    "evidenceFreeze": info(HERE / "evidence/freeze.json"), "evidenceResults": info(HERE / "evidence/results.json"),
                    "libFLAC": info(args.flac), "wvunpack": info(args.wvunpack)}
    for label, entry in r5_freeze.get("files", {}).items():
        dependencies[f"r5FreezeFile:{label}"] = entry
    for stem, entries in r5_freeze.get("inputFiles", {}).items():
        for label, entry in entries.items():
            dependencies[f"r5Input:{stem}:{label}"] = entry
    return {"r5Freeze": r5_freeze, "r5Result": r5_result, "r3Freeze": r3_freeze, "r3Result": r3_result,
            "r4Freeze": r4_freeze, "r4Result": r4_result, "rows": rows, "r3Rows": r3_rows,
            "r4Rows": r4_rows, "manifests": manifests, "artifacts": artifacts, "dependencies": dependencies}


def freeze_config(args: argparse.Namespace, data: dict) -> dict:
    return {"format": "issue77-round5-timing-freeze-v1", "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "timingSha256": sha(Path(__file__)), "r5Helper": info(args.helper), "flac": info(args.flac), "wvunpack": info(args.wvunpack),
            "r5Work": str(args.r5_work), "r3Work": str(args.r3_work), "r4Work": str(args.r4_work), "corpus": str(args.corpus),
            "pilots": PILOTS, "trialCount": TRIALS, "stemSeed": STEM_SEED, "modeSeed": MODE_SEED,
            "candidates": list(CANDIDATES), "manifests": data["manifests"], "compressedArtifacts": data["artifacts"],
            "dependencies": data["dependencies"], "auditArguments": {"r5": ["-", "-"], "r3": ["-", "-"]},
            "hashVerificationInsideTimedInterval": False, "pcmWriteInsideTimedInterval": True,
            "warmCompressedInputOutsideTimedInterval": True, "auditSerializationInsideTimedInterval": False,
            "rssScope": "maximum native child RSS from GNU time, KiB"}


def verify_frozen(freeze_path: Path, frozen_sha: str, freeze: dict) -> None:
    require(sha(freeze_path) == frozen_sha and freeze["timingSha256"] == sha(Path(__file__)), "timing freeze/source changed")
    for label, entry in freeze["dependencies"].items(): check_info(entry, f"dependency {label}")
    check_info(freeze["r5Helper"], "R5 helper"); check_info(freeze["flac"], "FLAC"); check_info(freeze["wvunpack"], "WavPack")
    for stem, entry in freeze["manifests"].items(): check_info(entry, f"manifest {stem}")
    for stem, modes in freeze["compressedArtifacts"].items():
        for mode, entries in modes.items():
            if isinstance(entries, list):
                for i, entry in enumerate(entries): check_info(entry, f"{stem}/{mode}/{i}")
            else: check_info(entries, f"{stem}/{mode}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True); parser.add_argument("--r5-work", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True); parser.add_argument("--r3-work", type=Path, default=DEFAULT_R3_WORK)
    parser.add_argument("--r4-work", type=Path, default=DEFAULT_R4_WORK); parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--flac", type=Path, default=FLAC_DEFAULT); parser.add_argument("--wvunpack", type=Path, default=WVU_DEFAULT)
    parser.add_argument("--trials", type=int, default=TRIALS)
    args = parser.parse_args()
    require(args.trials == TRIALS, "R5 timing freezes exactly three trials")
    for name in ("work", "r5_work", "helper", "r3_work", "r4_work", "corpus", "flac", "wvunpack"):
        setattr(args, name, getattr(args, name).resolve())
    require(args.helper.is_file() and args.flac.is_file() and args.wvunpack.is_file(), "timing tool missing")
    args.work.mkdir(parents=True, exist_ok=True); require(not any(args.work.iterdir()), "timing work must be fresh")
    data = validate_inputs(args)
    freeze = freeze_config(args, data); freeze_path = args.work / "timing-freeze.json"
    freeze_path.write_text(json.dumps(freeze, indent=2) + "\n"); frozen_sha = sha(freeze_path)
    trials = []
    for trial in range(TRIALS):
        trial_started = time.perf_counter()
        order = list(data["rows"]); random.Random(STEM_SEED + trial).shuffle(order)
        mode_order = list(CANDIDATES); random.Random(MODE_SEED + trial).shuffle(mode_order)
        trial_root = args.work / f"trial-{trial + 1}"; trial_root.mkdir(parents=True, exist_ok=True); modes = {}
        for candidate in mode_order:
            mode_root = trial_root / candidate; mode_root.mkdir(parents=True, exist_ok=True); stems = []
            for stem in order:
                expected = data["rows"][stem]; manifest = read_json(HERE / "manifests" / f"{stem}.json")
                output = mode_root / f"{stem}.raw"; require(not output.exists(), f"stale output: {output}")
                if candidate == "flac":
                    chunks = [args.corpus / stem / "flac8e-30s" / f"{i}.flac" for i, _ in enumerate(manifest["chunks"])]
                    measurement = decode_flac(args.flac, chunks, output, mode_root / f"{stem}.time")
                elif candidate == "wavpack":
                    measurement = decode_wavpack(args.wvunpack, args.corpus / stem / "wavpackhhx6-concat/0.wv", output, mode_root / f"{stem}.time")
                else:
                    if candidate == "r3-p3-rans":
                        compressed, helper = args.r3_work / "full" / stem / "p3-rans.fir", Path(data["r3Freeze"]["helper"]["path"])
                        summary = mode_root / f"{stem}.summary.json"
                    else:
                        policy = int(candidate[4]); compressed, helper = args.r5_work / "full" / stem / f"p{policy}-rans.mix", args.helper
                        summary = mode_root / f"{stem}.summary.json"
                    warm(compressed)
                    measurement = timed([str(helper), "decode", str(compressed), str(output), "-", "-", str(summary)], mode_root / f"{stem}.time")
                    decoded = read_json(summary)
                    if candidate == "r3-p3-rans":
                        expected_records = data["r3Rows"][stem]["profiles"]["3"]["rans"]["encodeSummary"]["recordCount"]
                    else:
                        expected_records = data["rows"][stem]["policies"][str(policy)]["rans"]["encodeSummary"]["recordCount"]
                    validate_custom_summary(decoded, candidate, compressed, expected_records)
                verify_pcm(output, expected, manifest)
                stems.append({"identity": "sha256:" + stem, "bytes": output.stat().st_size,
                              "sha256": expected["packedPcmSha256"], "measurement": measurement})
                output.unlink()
            modes[candidate] = {"order": order, "stems": stems,
                                "wallSeconds": sum(x["measurement"]["wallSeconds"] for x in stems),
                                "userSeconds": sum(x["measurement"]["userSeconds"] for x in stems),
                                "systemSeconds": sum(x["measurement"]["systemSeconds"] for x in stems),
                                "peakRssKiB": max(x["measurement"]["peakRssKiB"] for x in stems)}
        trials.append({"trial": trial + 1, "order": order, "candidateOrder": mode_order, "candidates": modes,
                       "wholeTrialWallSeconds": time.perf_counter() - trial_started,
                       "hashVerificationInsideTimedInterval": False})
        print(json.dumps({"trial": trial + 1, "seconds": {x: modes[x]["wallSeconds"] for x in mode_order}}, sort_keys=True), flush=True)
    verify_frozen(freeze_path, frozen_sha, freeze)
    result = {"format": "issue77-round5-timing-v1", "timingFreezeSha256": frozen_sha, "trials": trials,
              "candidates": list(CANDIDATES), "r5Work": str(args.r5_work), "r3Work": str(args.r3_work),
              "corpus": str(args.corpus), "flac": str(args.flac), "wvunpack": str(args.wvunpack),
              "warmCompressedInputOutsideTimedInterval": True, "auditArguments": {"r5": ["-", "-"], "r3": ["-", "-"]},
              "hashVerificationInsideTimedInterval": False, "pcmWriteInsideTimedInterval": True,
              "auditSerializationInsideTimedInterval": False, "rssScope": "maximum native child RSS from GNU time, KiB"}
    result_path = args.work / "timing.json"; result_path.write_text(json.dumps(result, indent=2) + "\n")
    require(read_json(result_path).get("timingFreezeSha256") == sha(freeze_path), "timing result/freeze mismatch")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"round5 timing: FAIL: {error}", flush=True); raise SystemExit(1)
