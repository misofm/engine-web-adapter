#!/usr/bin/env python3
"""Frozen round-5 pilot/full runner for the fixed FIR-pruning policies."""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parents[2]
R2_PATH = HERE / "iterations" / "round-02" / "round2.py"
spec = importlib.util.spec_from_file_location("round2_readonly_r5", R2_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load frozen round2 runner: {R2_PATH}")
r2 = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r2
spec.loader.exec_module(r2)

DEFAULT_RECORDS = Path("/data/issue-77-lossless/iterations/round-01/full-run3/full")
DEFAULT_CORPUS = Path("/data/issue-77-lossless/run-02")
DEFAULT_R3_WORK = Path("/data/issue-77-lossless/iterations/round-03/full-final")
DEFAULT_R4_WORK = Path("/data/issue-77-lossless/iterations/round-04/full-final3")
ROOT_ORIGINAL_AUDIT = HERE / "iterations/round-03-evidence/root-original-audit.json"
MODES = ("rice", "rans")
POLICIES = (0, 1, 2)
SANITIZED_POLICIES = (1, 2)
PILOT = [
    "sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
    "sha256:8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
    "sha256:fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
    "sha256:68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f",
]
PLAN_HEADER = ["frameOrdinal", "blockSize", "cheapRiceBytes", "temporalRiceBytes",
               "stackedRiceBytes", "selectedRiceBytes", "selectedSelector",
               "coefficientBytes", "predictiveResiduals", "firResiduals", "firUpdates"]
SUMMARY_FIELDS = ("coefficientBytes", "planRows", "cheapFrames", "temporalFrames",
                  "stackedFrames", "spatialFrames", "reference0Frames", "reference1Frames",
                  "firFrames", "predictiveResiduals", "firResiduals", "firUpdates",
                  "firPredictionClamp", "firCoefficientClamp", "firModularWrap",
                  "spatialPredictionClamp", "spatialModularWrap")


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
    require(entry.get("bytes") == Path(entry["path"]).stat().st_size and
            entry.get("sha256") == sha(Path(entry["path"])), f"changed frozen {label}")


def read_json(path: Path) -> dict:
    require(path.is_file(), f"missing JSON: {path}")
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"JSON object required: {path}")
    return value


def passing_gate(path: Path) -> None:
    gate = read_json(path)
    explicit = gate.get("allChecksPassed", gate.get("passed", gate.get("pass")))
    status_pass = (gate.get("format") == "issue77-round5-native-test-receipt-v1" and
                   gate.get("status") == "pass" and gate.get("returnCode") == 0)
    require(explicit is True or status_pass, f"R5 gate receipt is not a clean pass: {path}")


def validate_gate_receipts(paths: list[Path], expected_label: str, expected_helper: Path) -> None:
    require(len(paths) == 2, "R5 requires exactly optimized and sanitizer gate receipts")
    labels = []
    source_paths = {
        "round5.c": HERE / "iterations/round-05/native/round5.c",
        "round5_integer_driver.c": HERE / "iterations/round-05/native/round5_integer_driver.c",
        "test_native.py": HERE / "iterations/round-05/test_native.py",
        "libFLAC.a": Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a"),
    }
    for path in paths:
        passing_gate(path)
        gate = read_json(path)
        require(gate.get("format") == "issue77-round5-native-test-receipt-v1" and
                gate.get("label") in ("optimized", "asan-ubsan"),
                f"R5 gate receipt has an unknown build label: {path}")
        labels.append(gate["label"])
        inputs = gate.get("inputs", {})
        require(isinstance(inputs, dict), f"R5 gate {path} omits input provenance")
        for input_label, entry in inputs.items():
            require(isinstance(entry, dict) and entry.get("path") and entry.get("sha256"),
                    f"R5 gate {path} has malformed {input_label} provenance")
            recorded = Path(entry["path"])
            require(recorded.is_file() and entry["sha256"] == sha(recorded),
                    f"R5 gate {path} has changed {input_label}")
        for label, expected_path in source_paths.items():
            entry = inputs.get(label)
            require(isinstance(entry, dict) and entry.get("path") == str(expected_path) and
                    entry.get("sha256") == sha(expected_path),
                    f"R5 gate {path} has stale {label} provenance")
        helper = inputs.get("helper")
        driver = inputs.get("driver")
        require(isinstance(helper, dict) and isinstance(driver, dict),
                f"R5 gate {path} omits helper/driver provenance")
        for label, entry in (("helper", helper), ("driver", driver)):
            recorded = Path(entry["path"])
            require(recorded.is_file() and entry["sha256"] == sha(recorded),
                    f"R5 gate {path} has changed {label}")
    require(sorted(labels) == ["asan-ubsan", "optimized"],
            "R5 requires one optimized and one sanitizer gate receipt")
    expected = next(read_json(path) for path in paths if read_json(path).get("label") == expected_label)
    helper = expected["inputs"]["helper"]
    require(Path(helper["path"]).resolve() == expected_helper.resolve() and
            helper["sha256"] == sha(expected_helper),
            f"R5 {expected_label} gate helper differs from the requested helper")


def run_timed(command: list[str], receipt: Path) -> dict:
    receipt.parent.mkdir(parents=True, exist_ok=True)
    time_path = receipt.with_suffix(".time")
    stderr_path = receipt.with_suffix(".stderr")
    require(not time_path.exists() and not stderr_path.exists(), f"stale timing receipt: {receipt}")
    started = time.perf_counter()
    with stderr_path.open("wb") as stderr:
        result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(time_path), *command],
                                stdout=subprocess.DEVNULL, stderr=stderr, check=False)
    require(result.returncode == 0, f"command failed ({result.returncode}): {' '.join(command)}")
    require(stderr_path.stat().st_size == 0, f"command wrote stderr: {' '.join(command)}")
    values = time_path.read_text().split()
    require(len(values) == 3, f"bad GNU time receipt: {time_path}")
    return {"wallSeconds": time.perf_counter() - started, "userSeconds": float(values[0]),
            "systemSeconds": float(values[1]), "peakRssKiB": int(values[2]),
            "timedCommand": command, "hashVerificationInsideTimedInterval": False}


def parse_summary(path: Path) -> dict:
    value = read_json(path)
    require(value.get("format") == "issue77-round5-summary-v1", f"bad R5 summary: {path}")
    require(set(SUMMARY_FIELDS) <= set(value), f"R5 summary fields missing: {path}")
    return value


def read_header(path: Path, manifest: bytes, mode: int, policy: int, records: int) -> dict:
    with path.open("rb") as source:
        header = source.read(32)
        require(len(header) == 32 and header[:8] == b"I77MIX05", f"bad R5 header: {path}")
        actual_mode, shape, actual_policy, spatial = header[8:12]
        manifest_length = int.from_bytes(header[12:20], "little")
        record_count = int.from_bytes(header[20:28], "little")
        table_count = int.from_bytes(header[28:32], "little")
        require((actual_mode, shape, actual_policy, spatial) == (mode, 1, policy, 2) and
                record_count == records and manifest_length <= 1024 * 1024 and
                table_count <= 4 * 31 * 5 and (mode or table_count == 0),
                f"invalid R5 header: {path}")
        require(source.read(manifest_length) == manifest, f"R5 manifest differs: {path}")
        previous = None
        for _ in range(table_count):
            key_bytes = source.read(3)
            require(len(key_bytes) == 3, f"truncated R5 table key: {path}")
            key = tuple(key_bytes)
            require(key[0] < 4 and key[1] < 31 and key[2] < 5 and
                    (previous is None or key > previous), f"unordered R5 table key: {path}")
            previous = key
            frequencies = source.read(34)
            require(len(frequencies) == 34 and
                    sum(int.from_bytes(frequencies[i:i + 2], "little")
                        for i in range(0, 34, 2)) == 4096,
                    f"bad R5 table sum: {path}")
    return {"mode": mode, "policy": policy, "spatial": 2,
            "manifestBytes": manifest_length, "recordCount": records,
            "tableCount": table_count, "tableBytes": table_count * 37,
            "dataOffset": 32 + manifest_length + table_count * 37}


def validate_summary(summary: dict, header: dict, file_bytes: int, records: int, encoding: bool) -> None:
    require(summary.get("mode") == header["mode"] and summary.get("policy") == header["policy"] and
            summary.get("recordCount") == records and summary.get("frameCount") == records,
            "R5 summary/header mismatch")
    require(summary.get("manifestBytes") == header["manifestBytes"] and
            summary.get("tableCount") == header["tableCount"] and
            summary.get("tableBytes") == header["tableBytes"], "R5 table accounting mismatch")
    expected_frame = (8 * summary["frameCount"] + summary["sideBytes"] +
                      8 * summary["predictiveSubframes"] + summary["entropyBytes"] +
                      summary["bypassBytes"] + summary["coefficientBytes"])
    require(summary["frameBytes"] == expected_frame and
            summary["fileBytes"] == 32 + summary["manifestBytes"] + summary["tableBytes"] +
            summary["frameBytes"] == file_bytes, "R5 byte accounting mismatch")
    require(summary["planRows"] == (records if encoding else 0), "R5 planRows mismatch")
    require(summary["inputRecordCount"] == records, "R5 input record count mismatch")
    require(summary["cheapFrames"] + summary["temporalFrames"] + summary["stackedFrames"] == records,
            "R5 selector accounting mismatch")
    require(summary["spatialFrames"] <= summary["cheapFrames"] + summary["stackedFrames"] and
            summary["firFrames"] <= summary["temporalFrames"] + summary["stackedFrames"],
            "R5 path counters exceed selector counts")


def equal_after_header(left: Path, right: Path) -> bool:
    with left.open("rb") as a, right.open("rb") as b:
        if len(a.read(32)) != 32 or len(b.read(32)) != 32:
            return False
        while True:
            x, y = a.read(1024 * 1024), b.read(1024 * 1024)
            if x != y:
                return False
            if not x:
                return True


def validate_plan(path: Path, records: int, policy: int) -> str:
    with path.open(newline="") as source:
        rows = list(csv.DictReader(source))
    require(rows and list(rows[0]) == PLAN_HEADER and len(rows) == records,
            f"R5 plan CSV shape mismatch: {path}")
    for ordinal, row in enumerate(rows):
        require(int(row["frameOrdinal"]) == ordinal and int(row["blockSize"]) > 0,
                f"R5 plan ordinal/block mismatch: {path}")
        predictive = int(row["predictiveResiduals"])
        for key in PLAN_HEADER[2:]:
            value = row[key]
            if value == "NA":
                require(key in ("temporalRiceBytes", "stackedRiceBytes") and
                        (policy == 0 or predictive == 0),
                        f"unexpected NA in R5 plan: {path}")
            else:
                parsed = int(value)
                require(parsed >= 0, f"negative R5 plan field: {path}")
        selector = int(row["selectedSelector"])
        require(selector in (0, 1, 2, 4, 5, 6), f"invalid R5 selector in plan: {path}")
        require(int(row["coefficientBytes"]) in (0, 10), f"invalid R5 coefficient bytes: {path}")
        require((selector & 4) == 0 or int(row["firResiduals"]) > 0,
                f"R5 FIR selector has no residuals: {path}")
        if predictive == 0:
            require(row["temporalRiceBytes"] == "NA" and row["stackedRiceBytes"] == "NA",
                    f"R5 no-residual frame must omit T/H costs: {path}")
        if policy == 0:
            require(selector < 4 and row["temporalRiceBytes"] == "NA" and
                    row["stackedRiceBytes"] == "NA", f"policy 0 FIR plan: {path}")
        elif predictive > 0:
            require(row["temporalRiceBytes"] != "NA" and row["stackedRiceBytes"] != "NA",
                    f"R5 predictive frame omitted T/H costs: {path}")
    return sha(path)


def expected_inputs(catalog: dict) -> tuple[dict, dict, dict]:
    root = read_json(HERE / "iterations/round-01-evidence/root-verification.json")
    verification = read_json(HERE / "iterations/round-01-evidence/verification.json")
    by_identity = {x["identity"]: x for x in verification["stems"]}
    expected_rsd = {x["identity"]: {"recordBytes": x["recordBytes"], "recordSha256": x["recordSha256"],
                                      "recordCount": by_identity[x["identity"]]["recordCount"]}
                    for x in root["stems"]}
    baseline_evidence = read_json(HERE / "evidence/results.json")
    baseline = {x["identity"]: next(y for y in x["results"] if y["candidate"] == "flac8e-30s")
                for x in baseline_evidence["stems"]}
    audit = read_json(ROOT_ORIGINAL_AUDIT)
    expected_audit = {x["identity"]: x for x in audit["stems"]}
    require(set(expected_rsd) == set(expected_audit) == {x["identity"] for x in catalog["stems"]},
            "frozen input identity sets differ")
    return expected_rsd, baseline, expected_audit


def prior_receipts(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict, dict]:
    r3_freeze = read_json(args.r3_work / "freeze.json")
    r3_results = read_json(args.r3_work / "results.json")
    r3_root = read_json(args.r3_work / "root-verification.json")
    r4_freeze = read_json(args.r4_work / "freeze.json")
    r4_results = read_json(args.r4_work / "results.json")
    r4_root = read_json(args.r4_work / "root-verification.json")
    require(r3_freeze.get("format") == "issue77-round3-freeze-v1" and
            r3_results.get("format") == "issue77-round3-results-v1" and
            r3_results.get("stemCount") == 30 and r3_results.get("freezeSha256") == sha(args.r3_work / "freeze.json") and
            r3_root.get("allChecksPassed") is True and r3_root.get("artifactCount") == 120 and
            r3_root.get("resultsSha256") == sha(args.r3_work / "results.json"), "R3 prior receipt invalid")
    require(r4_freeze.get("format") == "issue77-round4-freeze-v1" and
            r4_results.get("format") == "issue77-round4-results-v1" and
            r4_results.get("stemCount") == 30 and r4_results.get("freezeSha256") == sha(args.r4_work / "freeze.json") and
            r4_root.get("allChecksPassed") is True and r4_root.get("artifactCount") == 120 and
            r4_root.get("resultsSha256") == sha(args.r4_work / "results.json"), "R4 prior receipt invalid")
    require(r4_root.get("resultsSha256") == "9f4452056a6ac93a4a76f3d2820c5a2c224ad987ea08f01c5a55f4b8412b3056",
            "R4 prior result is not the pinned final-full3 receipt")
    return r3_freeze, r3_results, r3_root, r4_freeze, r4_results, r4_root


def process_stem(row: dict, args: argparse.Namespace, expected_rsd: dict,
                 baseline: dict, expected_audit: dict, r4_rows: dict, work_root: Path) -> dict:
    identity = row["identity"].split(":", 1)[1]
    rsd = args.records_root / identity / "stem.rsd"
    expected = expected_rsd[row["identity"]]
    r2.check_file(rsd, expected["recordBytes"], expected["recordSha256"])
    manifest_path = HERE / row["manifestPath"]
    manifest_bytes = manifest_path.read_bytes()
    require(sha(manifest_path) == row["manifestSha256"], "frozen manifest changed")
    manifest = json.loads(manifest_bytes)
    active_frames = r2.validate_manifest(manifest, row)
    embedded, count = r2.read_rsd_header(rsd, manifest_bytes)
    require(json.loads(embedded) == manifest and count == expected["recordCount"], "RSD manifest/count mismatch")
    r2.validate_rsd_layout(rsd, manifest, count)
    base = baseline[row["identity"]]
    active = args.corpus / identity / "active.raw"
    r2.check_file(active, row["activePcmBytes"], base["packedPcmSha256"])
    root = work_root / identity
    root.mkdir(parents=True, exist_ok=True)
    policies: dict[int, dict] = {}
    for policy in args.policies:
        policies[policy] = {}
        for mode_index, mode in enumerate(MODES):
            stem = root / f"p{policy}-{mode}"
            output, original, coded = stem.with_suffix(".mix"), stem.with_suffix(".original.audit"), stem.with_suffix(".coded.audit")
            enc_summary, plan = stem.with_suffix(".encode.json"), stem.with_suffix(".plan.csv")
            decoded = stem.with_suffix(".raw")
            dec_original, dec_coded, dec_summary = stem.with_suffix(".decode.original.audit"), stem.with_suffix(".decode.coded.audit"), stem.with_suffix(".decode.json")
            enc_time = run_timed([str(args.helper), "encode", str(rsd), str(output), str(original), str(coded),
                                  str(enc_summary), str(mode_index), str(policy), str(plan)], stem.with_suffix(".encode.time"))
            enc = parse_summary(enc_summary)
            header = read_header(output, manifest_bytes, mode_index, policy, count)
            validate_summary(enc, header, output.stat().st_size, count, True)
            plan_sha = validate_plan(plan, count, policy)
            if policy == 0:
                old = args.r4_work / "full" / identity / f"p2-{mode}.xch"
                old_expected = r4_rows[row["identity"]]["profiles"]["2"][mode]
                require(old.is_file() and old.stat().st_size == old_expected["outputBytes"] and
                        sha(old) == old_expected["outputSha256"] and equal_after_header(output, old),
                        f"policy 0 body differs from final R4 P2: {output}")
            dec_time = run_timed([str(args.helper), "decode", str(output), str(decoded), str(dec_original),
                                  str(dec_coded), str(dec_summary)], stem.with_suffix(".decode.time"))
            dec = parse_summary(dec_summary)
            r2.check_file(decoded, row["activePcmBytes"], base["packedPcmSha256"])
            require(r2.canonical_hash(decoded, manifest) == identity and
                    r2.chunk_hashes(decoded, manifest) == [x["pcmSha256"] for x in base["chunks"]],
                    f"R5 PCM verification failed: {identity}/{mode}/{policy}")
            require(sha(original) == sha(dec_original) and original.stat().st_size == expected_audit[row["identity"]]["originalAuditBytes"] and
                    sha(original) == expected_audit[row["identity"]]["originalAuditSha256"] and sha(coded) == sha(dec_coded),
                    f"R5 audit transcript mismatch: {identity}/{mode}/{policy}")
            validate_summary(dec, header, output.stat().st_size, count, False)
            for field in SUMMARY_FIELDS + ("predictiveSubframes", "manifestBytes", "tableCount", "tableBytes", "sideBytes",
                                           "entropyBytes", "bypassBytes", "frameBytes", "fileBytes", "inputRecordCount"):
                require(enc[field] == dec[field] if field != "planRows" else dec[field] == 0,
                        f"R5 encode/decode field mismatch {field}")
            policies[policy][mode] = {"mode": mode, "policy": policy, "outputBytes": output.stat().st_size,
                "outputSha256": sha(output), "originalAuditSha256": sha(original),
                "codedAuditSha256": sha(coded), "auditBytes": coded.stat().st_size,
                "planBytes": plan.stat().st_size, "planSha256": plan_sha,
                "planCsvSha256": plan_sha, "planRows": count, "encodeSummary": enc,
                "decodeSummary": dec, "encode": enc_time, "decode": dec_time}
        require(policies[policy]["rice"]["planCsvSha256"] == policies[policy]["rans"]["planCsvSha256"],
                f"Rice/rANS plan CSV differs: {identity}/p{policy}")
        require(policies[policy]["rice"]["codedAuditSha256"] == policies[policy]["rans"]["codedAuditSha256"],
                f"Rice/rANS coded transcript differs: {identity}/p{policy}")
    return {"identity": row["identity"], "recordingRef": row["recordingRef"], "sourceIDs": row["sourceIDs"],
            "activeFrames": active_frames, "activePcmBytes": row["activePcmBytes"],
            "canonicalPcmSha256": identity, "packedPcmSha256": base["packedPcmSha256"],
            "rsdBytes": expected["recordBytes"], "rsdSha256": expected["recordSha256"],
            "manifestBytes": len(manifest_bytes), "originalAuditBytes": expected_audit[row["identity"]]["originalAuditBytes"],
            "originalAuditSha256": expected_audit[row["identity"]]["originalAuditSha256"], "policies": policies}


def mode_totals(rows: list[dict], policy: int, mode: str) -> dict:
    members = [x["policies"][policy][mode] for x in rows]
    def total(field: str) -> int:
        return sum(x["encodeSummary"][field] for x in members)
    return {"policy": policy, "mode": mode, "stemCount": len(members), "outputBytes": sum(x["outputBytes"] for x in members),
            "recordCount": total("recordCount"), "frameCount": total("frameCount"),
            **{field: total(field) for field in ("predictiveSubframes", "manifestBytes", "tableBytes", "sideBytes", "entropyBytes", "bypassBytes", "frameBytes", *SUMMARY_FIELDS)},
            "auditBytes": sum(x["auditBytes"] for x in members),
            "encodeWallSeconds": sum(x["encode"]["wallSeconds"] for x in members), "decodeWallSeconds": sum(x["decode"]["wallSeconds"] for x in members),
            "encodeUserSeconds": sum(x["encode"]["userSeconds"] for x in members), "decodeUserSeconds": sum(x["decode"]["userSeconds"] for x in members),
            "encodeSystemSeconds": sum(x["encode"]["systemSeconds"] for x in members), "decodeSystemSeconds": sum(x["decode"]["systemSeconds"] for x in members),
            "encodePeakRssKiB": max(x["encode"]["peakRssKiB"] for x in members), "decodePeakRssKiB": max(x["decode"]["peakRssKiB"] for x in members)}


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader(); writer.writerows(rows)


def build_freeze(args: argparse.Namespace, expected_rsd: dict, prior: tuple, pilot_sha: str | None) -> dict:
    r3f, r3res, r3root, r4f, r4res, r4root = prior
    native = HERE / "iterations/round-05/native/round5.c"
    files = {"scope": info(HERE / "iterations/round-05-scope.md"), "runner": info(Path(__file__)),
             "native": info(native), "helper": info(args.helper),
             "round3Native": info(HERE / "iterations/round-03/native/round3.c"),
             "round3Runner": info(HERE / "iterations/round-03/round3.py"),
             "round3Helper": info(Path(r3f["helper"]["path"])), "round3Work": info(args.r3_work / "results.json"),
             "round3Freeze": info(args.r3_work / "freeze.json"),
             "round3Root": info(args.r3_work / "root-verification.json"),
             "round4Native": info(HERE / "iterations/round-04/native/round4.c"),
             "round4Runner": info(HERE / "iterations/round-04/round4.py"),
             "round4Helper": info(Path(r4f["helper"]["path"])), "round4Work": info(args.r4_work / "results.json"),
             "round4Freeze": info(args.r4_work / "freeze.json"),
             "round4Root": info(args.r4_work / "root-verification.json"),
             "round1Native": info(HERE / "iterations/round-01/native/round1.c"),
             "round2Native": info(HERE / "iterations/round-02/native/round2.c"),
             "round2Runner": info(HERE / "iterations/round-02/round2.py"),
             "runPy": info(HERE / "run.py"), "timing": info(HERE / "iterations/round-05/timing.py"),
             "rootAudit": info(HERE / "iterations/round-05/root_audit.py"),
             "testNative": info(HERE / "iterations/round-05/test_native.py"),
             "sources": info(HERE / "sources.json"), "r1Verification": info(HERE / "iterations/round-01-evidence/verification.json"),
             "r1Root": info(HERE / "iterations/round-01-evidence/root-verification.json"),
             "baselineEvidenceFreeze": info(HERE / "evidence/freeze.json"),
             "baselineEvidenceResults": info(HERE / "evidence/results.json"),
             "originalAudit": info(ROOT_ORIGINAL_AUDIT), "libFLAC": info(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")),
             "gcc": info(Path(shutil.which("gcc") or "gcc")),
             "libm": info(Path("/lib/x86_64-linux-gnu/libm.so.6"))}
    if args.pilot_work is not None:
        files["pilotFreeze"] = info(args.pilot_work / "freeze.json")
        files["pilotResults"] = info(args.pilot_work / "pilot-results.json")
        files["pilotRoot"] = info(args.pilot_work / "root-verification.json")
    if args.sanitized_work is not None:
        files["sanitizedFreeze"] = info(args.sanitized_work / "freeze.json")
        files["sanitizedResults"] = info(args.sanitized_work / "results.json")
        files["sanitizedRoot"] = info(args.sanitized_work / "root-verification.json")
        sanitized_freeze = read_json(args.sanitized_work / "freeze.json")
        files["sanitizedHelper"] = info(Path(sanitized_freeze["helper"]["path"]))
    for index, receipt in enumerate(args.gate_receipts):
        files[f"gateReceipt{index}"] = info(receipt)
        gate = read_json(receipt)
        for input_label, entry in gate["inputs"].items():
            files[f"gateReceipt{index}Input:{input_label}"] = info(Path(entry["path"]))
    selected_inputs = ([identity.split(":", 1)[1] for identity in args.pilot]
                       if args.run_kind != "full" else
                       [identity.split(":", 1)[1] for identity in expected_rsd])
    input_files = {}
    for stem in selected_inputs:
        input_files[stem] = {"rsd": info(args.records_root / stem / "stem.rsd"),
                             "active": info(args.corpus / stem / "active.raw"),
                             "manifest": info(HERE / "manifests" / f"{stem}.json")}
    return {"format": "issue77-round5-freeze-v1", "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scopeSha256": sha(HERE / "iterations/round-05-scope.md"), "runnerSha256": sha(Path(__file__)),
            "nativeSha256": sha(native), "helper": info(args.helper), "records": expected_rsd,
            "recordsRoot": str(args.records_root), "corpus": str(args.corpus), "r3Work": str(args.r3_work), "r4Work": str(args.r4_work),
            "pilotWork": str(args.pilot_work) if args.pilot_work is not None else None,
            "sanitizedWork": str(args.sanitized_work) if args.sanitized_work is not None else None,
            "gateReceipts": [str(path) for path in args.gate_receipts],
            "workerConcurrency": args.workers, "policies": args.policies, "modes": {"rice": 0, "rans": 1},
            "pilot": args.pilot_only, "runKind": args.run_kind, "pilotIdentities": args.pilot,
            "pilotResultsSha256": pilot_sha, "thresholds": {"policy0": None, "policy1": 0, "policy2": 32},
            "spatialProfile": 2, "firProfile": {"M": 32, "b": 3, "Q": 20, "cadence": 4},
            "bounds": {"maxBlockFrames": 65535, "maxRecordBytes": 1 << 20, "maxFrameBytes": 4 << 20, "maxManifestBytes": 1 << 20, "maxTables": 4 * 31 * 5},
            "prior": {"round3FreezeSha256": sha(args.r3_work / "freeze.json"), "round3ResultsSha256": sha(args.r3_work / "results.json"),
                      "round4FreezeSha256": sha(args.r4_work / "freeze.json"), "round4ResultsSha256": sha(args.r4_work / "results.json")},
            "inputFiles": input_files, "files": files, "commands": {"encode": "helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE POLICY PLAN_CSV",
                                             "decode": "helper decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY"},
            "compiler": ("gcc -std=c11 -O1 -g -fno-omit-frame-pointer -fno-fast-math -ffp-contract=off "
                          "-fsanitize=address,undefined -Wall -Wextra -Wconversion -Wshadow"
                          if args.run_kind == "sanitized-pilot" else
                          "gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow -fno-fast-math -ffp-contract=off"),
            "sanitized": args.run_kind == "sanitized-pilot",
            "compilerVersion": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
            "platform": platform.platform(), "cpu": subprocess.check_output(["lscpu"], text=True)}


def verify_freeze(frozen: dict, args: argparse.Namespace) -> None:
    require(frozen["runnerSha256"] == sha(Path(__file__)) and frozen["nativeSha256"] == sha(HERE / "iterations/round-05/native/round5.c") and
            frozen["scopeSha256"] == sha(HERE / "iterations/round-05-scope.md") and frozen["helper"]["sha256"] == sha(args.helper),
            "R5 source/helper changed")
    require(frozen["recordsRoot"] == str(args.records_root) and frozen["corpus"] == str(args.corpus) and
            frozen["policies"] == args.policies and frozen["workerConcurrency"] == args.workers,
            "R5 configuration changed")
    for label, entry in frozen["files"].items():
        check_info(entry, label)
    for stem, entries in frozen["inputFiles"].items():
        for label, entry in entries.items():
            check_info(entry, f"input {stem}/{label}")


def validate_sanitized_binding(args: argparse.Namespace) -> str:
    require(args.sanitized_work is not None,
            "optimized R5 pilot/full requires the completed sanitizer pilot")
    work = args.sanitized_work
    frozen = read_json(work / "freeze.json")
    result = read_json(work / "results.json")
    root = read_json(work / "root-verification.json")
    require(frozen.get("format") == "issue77-round5-freeze-v1" and
            frozen.get("runKind") == "sanitized-pilot" and frozen.get("sanitized") is True and
            frozen.get("policies") == list(SANITIZED_POLICIES) and frozen.get("workerConcurrency") == 4 and
            result.get("format") == "issue77-round5-results-v1" and
            result.get("runKind") == "sanitized-pilot" and result.get("stemCount") == 4 and
            result.get("policies") == list(SANITIZED_POLICIES) and
            result.get("freezeSha256") == sha(work / "freeze.json") and
            root.get("allChecksPassed") is True and root.get("artifactCount") == 16 and
            root.get("resultsSha256") == sha(work / "results.json"),
            "R5 sanitizer pilot is not a verified 16-file grid")
    identities = {row["identity"] for row in result.get("stems", [])}
    require(identities == set(PILOT), "R5 sanitizer pilot identities differ from the exact four pilots")
    for row in result["stems"]:
        require(set(row.get("policies", {})) == {"1", "2"} and
                all(set(row["policies"][str(policy)]) == set(MODES) for policy in SANITIZED_POLICIES),
                "R5 sanitizer row does not contain both policy/mode artifacts")
    sanitizer_args = argparse.Namespace(**vars(args))
    sanitizer_args.helper = Path(frozen["helper"]["path"]).resolve()
    sanitizer_args.policies = list(SANITIZED_POLICIES)
    sanitizer_args.workers = 4
    verify_freeze(frozen, sanitizer_args)
    require(frozen.get("gateReceipts") == [str(path) for path in args.gate_receipts],
            "R5 sanitizer gate receipt set differs from current run")
    return sha(work / "results.json")


def validate_pilot_binding(args: argparse.Namespace) -> str:
    require(args.pilot_work is not None, "full R5 run requires pilot work")
    pilot_freeze = read_json(args.pilot_work / "freeze.json")
    pilot_path = args.pilot_work / "pilot-results.json"
    pilot = read_json(pilot_path)
    root = read_json(args.pilot_work / "root-verification.json")
    require(pilot_freeze.get("format") == "issue77-round5-freeze-v1" and
            pilot_freeze.get("runKind") == "pilot" and pilot_freeze.get("pilot") is True and
            pilot_freeze.get("policies") == list(POLICIES) and pilot_freeze.get("workerConcurrency") == 4 and
            pilot.get("format") == "issue77-round5-results-v1" and pilot.get("runKind") == "pilot" and
            pilot.get("pilot") is True and pilot.get("stemCount") == 4 and
            pilot.get("policies") == list(POLICIES) and pilot.get("freezeSha256") == sha(args.pilot_work / "freeze.json") and
            root.get("allChecksPassed") is True and root.get("artifactCount") == 24 and
            root.get("resultsSha256") == sha(pilot_path), "R5 pilot receipt is not a verified 24-file grid")
    require(pilot_freeze.get("gateReceipts") == [str(path) for path in args.gate_receipts],
            "R5 pilot gate receipt set differs from full-run inputs")
    require(pilot_freeze.get("sanitizedWork") == str(args.sanitized_work),
            "R5 pilot is not bound to the completed sanitizer pilot")
    identities = {row["identity"] for row in pilot.get("stems", [])}
    require(identities == set(PILOT), "R5 pilot identities differ from the exact four pilots")
    for row in pilot["stems"]:
        require(set(row.get("policies", {})) == {"0", "1", "2"} and
                all(set(row["policies"][str(p)]) == set(MODES) for p in POLICIES),
                "R5 pilot row does not contain all six policy/mode artifacts")
    require(pilot_freeze.get("runnerSha256") == sha(Path(__file__)) and
            pilot_freeze.get("nativeSha256") == sha(HERE / "iterations/round-05/native/round5.c") and
            pilot_freeze.get("helper", {}).get("sha256") == sha(args.helper),
            "R5 pilot source/helper differs from current full-run inputs")
    verify_freeze(pilot_freeze, args)
    return sha(pilot_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--records-root", type=Path, default=DEFAULT_RECORDS)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--r3-work", type=Path, default=DEFAULT_R3_WORK)
    parser.add_argument("--r4-work", type=Path, default=DEFAULT_R4_WORK)
    parser.add_argument("--pilot-work", type=Path)
    parser.add_argument("--sanitized-work", type=Path)
    parser.add_argument("--gate-receipt", dest="gate_receipts", action="append", type=Path, default=[])
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 5))
    parser.add_argument("--pilot", nargs="*", default=PILOT)
    parser.add_argument("--pilot-only", action="store_true")
    parser.add_argument("--sanitized-pilot", action="store_true")
    parser.add_argument("--policies", nargs="+", type=int, choices=POLICIES)
    args = parser.parse_args()
    require(not (args.pilot_only and args.sanitized_pilot), "choose one R5 run kind")
    args.run_kind = "pilot" if args.pilot_only else "sanitized-pilot" if args.sanitized_pilot else "full"
    for name in ("work", "helper", "records_root", "corpus", "r3_work", "r4_work"):
        setattr(args, name, getattr(args, name).resolve())
    if args.sanitized_work is not None:
        args.sanitized_work = args.sanitized_work.resolve()
    args.gate_receipts = [path.resolve() for path in args.gate_receipts]
    require(args.workers == 4, "R5 fixes worker concurrency at four")
    validate_gate_receipts(args.gate_receipts,
                           "asan-ubsan" if args.run_kind == "sanitized-pilot" else "optimized",
                           args.helper)
    for receipt in args.gate_receipts:
        require(receipt.is_file(), f"missing R5 gate receipt: {receipt}")
    require(args.helper.is_file(), "R5 helper is missing")
    require(set(args.pilot) == set(PILOT) and len(args.pilot) == 4, "R5 requires the exact four pilots")
    args.policies = list(args.policies or (POLICIES if args.run_kind != "sanitized-pilot" else SANITIZED_POLICIES))
    require(tuple(args.policies) == (POLICIES if args.run_kind != "sanitized-pilot" else SANITIZED_POLICIES),
            "R5 policy grid is fixed")
    if args.run_kind == "sanitized-pilot":
        require(args.sanitized_work is None, "sanitizer pilot cannot depend on another sanitizer work directory")
    else:
        validate_sanitized_binding(args)
    if args.run_kind == "full":
        require(args.pilot_work is not None, "full R5 run requires pilot work")
        args.pilot_work = args.pilot_work.resolve()
        pilot_sha = validate_pilot_binding(args)
    else:
        pilot_sha = None
    require(not args.work.exists() or not any(args.work.iterdir()), "R5 work directory must be fresh")
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = read_json(HERE / "sources.json")
    expected_rsd, baseline, expected_audit = expected_inputs(catalog)
    prior = prior_receipts(args)
    r4_rows = {x["identity"]: x for x in prior[4]["stems"]}
    require({x["identity"] for x in catalog["stems"]} == set(r4_rows), "R5 catalog differs from R4 final identities")
    stems = [x for x in catalog["stems"] if x["identity"] in args.pilot] if args.run_kind != "full" else catalog["stems"]
    require(len(stems) == (4 if args.run_kind != "full" else 30), "R5 stem count mismatch")
    freeze = build_freeze(args, expected_rsd, prior, pilot_sha)
    freeze_path = args.work / "freeze.json"
    freeze_path.write_text(json.dumps(freeze, indent=2) + "\n")
    frozen_sha = sha(freeze_path)
    verify_freeze(freeze, args)
    root = args.work / ("pilot" if args.run_kind == "pilot" else "sanitized-pilot" if args.run_kind == "sanitized-pilot" else "full")
    root.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process_stem, row, args, expected_rsd, baseline, expected_audit, r4_rows, root) for row in stems]
        for future in futures:
            row = future.result(); rows.append(row); print(f"{row['recordingRef']}/{row['sourceIDs'][0]} complete", flush=True)
    rows.sort(key=lambda x: x["identity"])
    totals = {f"p{p}-{m}": mode_totals(rows, p, m) for p in args.policies for m in MODES}
    sessions = []
    for session in sorted({x["recordingRef"] for x in rows}):
        members = [x for x in rows if x["recordingRef"] == session]
        item = {"recordingRef": session, "stemCount": len(members), "controlBytes": sum(baseline[x["identity"]]["totalBytes"] for x in members)}
        for p in args.policies:
            for m in MODES:
                item[f"p{p}{m}Bytes"] = sum(x["policies"][p][m]["outputBytes"] for x in members)
        sessions.append(item)
    result = {"format": "issue77-round5-results-v1", "freezeSha256": frozen_sha, "runKind": args.run_kind,
              "pilot": args.pilot_only, "stemCount": len(rows), "elapsedSeconds": time.perf_counter() - started,
              "policies": args.policies, "modes": MODES, "controlBytes": sum(baseline[x["identity"]]["totalBytes"] for x in rows),
              "totals": totals, "sessions": sessions, "stems": rows}
    result_path = args.work / ("pilot-results.json" if args.run_kind == "pilot" else "results.json")
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    stem_csv = []
    for row in rows:
        item = {"identity": row["identity"], "recordingRef": row["recordingRef"], "source": "/".join(row["sourceIDs"]),
                "controlBytes": baseline[row["identity"]]["totalBytes"]}
        for p in args.policies:
            for m in MODES:
                item[f"p{p}{m}Bytes"] = row["policies"][p][m]["outputBytes"]
                item[f"p{p}{m}Sha256"] = row["policies"][p][m]["outputSha256"]
        stem_csv.append(item)
    write_csv(args.work / ("pilot-per-stem.csv" if args.run_kind == "pilot" else "sanitized-per-stem.csv" if args.run_kind == "sanitized-pilot" else "per-stem.csv"), stem_csv)
    write_csv(args.work / ("pilot-per-session.csv" if args.run_kind == "pilot" else "sanitized-per-session.csv" if args.run_kind == "sanitized-pilot" else "per-session.csv"), sessions)
    require(sha(freeze_path) == frozen_sha, "R5 freeze changed during run")
    verify_freeze(freeze, args)
    print(json.dumps({"format": result["format"], "stemCount": len(rows), "policies": args.policies,
                      "totals": {k: v["outputBytes"] for k, v in totals.items()}}, indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"round5: FAIL: {error}", flush=True)
        raise SystemExit(1)
