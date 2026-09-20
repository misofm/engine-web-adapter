#!/usr/bin/env python3
"""Bounded round-03 pilot/full runner over frozen round-1 records."""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import sys
import time


HERE = Path(__file__).resolve().parents[2]
ROUND2_RUNNER = HERE / "iterations" / "round-02" / "round2.py"
spec = importlib.util.spec_from_file_location("round2_runner_readonly", ROUND2_RUNNER)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load frozen round2 runner: {ROUND2_RUNNER}")
r2 = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r2
spec.loader.exec_module(r2)

DEFAULT_RECORDS = Path("/data/issue-77-lossless/iterations/round-01/full-run3/full")
DEFAULT_CORPUS = Path("/data/issue-77-lossless/run-02")
MODES = ("rice", "rans")
PROFILES = (0, 1, 2, 3, 4)
PILOT = [
    "sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
    "sha256:8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
    "sha256:fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
    "sha256:68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f",
]
ROOT_ORIGINAL_AUDIT = Path("/data/issue-77-lossless/iterations/round-03/root-original-audit.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def parse_summary(path: Path) -> dict:
    value = json.loads(path.read_text())
    require(value["format"] == "issue77-round3-summary-v1", f"bad round3 summary {path}")
    return value


def read_fir_header(path: Path, expected_manifest: bytes, expected_mode: int,
                    expected_profile: int, expected_records: int) -> dict:
    with path.open("rb") as source:
        header = source.read(32)
        require(len(header) == 32 and header[:8] == b"I77FIR03", f"bad FIR header {path}")
        mode, shape, profile, reserved = header[8:12]
        manifest_length = int.from_bytes(header[12:20], "little")
        record_count = int.from_bytes(header[20:28], "little")
        table_count = int.from_bytes(header[28:32], "little")
        require(mode == expected_mode and shape == 1 and profile == expected_profile and
                reserved == 0 and manifest_length <= 1024 * 1024 and
                record_count == expected_records and table_count <= 4 * 31 * 5 and
                (mode != 0 or table_count == 0), "invalid FIR header")
        embedded = source.read(manifest_length)
        require(embedded == expected_manifest, "FIR manifest differs from frozen manifest")
        previous = None
        for _ in range(table_count):
            key_bytes = source.read(3)
            require(len(key_bytes) == 3, "truncated FIR table key")
            key = tuple(key_bytes)
            require(key[0] < 4 and key[1] < 31 and key[2] < 5 and
                    (previous is None or key > previous), "unordered FIR table key")
            previous = key
            frequencies = source.read(34)
            require(len(frequencies) == 34 and
                    sum(int.from_bytes(frequencies[i:i + 2], "little")
                        for i in range(0, 34, 2)) == 4096, "bad FIR table sum")
        return {"mode": mode, "profile": profile, "manifestBytes": manifest_length,
                "recordCount": record_count, "tableCount": table_count,
                "tableBytes": table_count * 37,
                "dataOffset": 32 + manifest_length + table_count * 37}


def validate_summary(summary: dict, header: dict, file_bytes: int, records: int) -> None:
    require(summary["mode"] == header["mode"] and summary["predictorProfile"] == header["profile"],
            "summary/header profile mismatch")
    require(summary["recordCount"] == records and summary["frameCount"] == records,
            "summary record count mismatch")
    require(summary["manifestBytes"] == header["manifestBytes"] and
            summary["tableCount"] == header["tableCount"] and
            summary["tableBytes"] == header["tableBytes"], "summary table mismatch")
    expected_frames = (8 * summary["frameCount"] + summary["sideBytes"] +
                       8 * summary["predictiveSubframes"] + summary["entropyBytes"] +
                       summary["bypassBytes"])
    require(summary["frameBytes"] == expected_frames, "FIR frame accounting mismatch")
    require(summary["fileBytes"] == 32 + summary["manifestBytes"] + summary["tableBytes"] +
            summary["frameBytes"] == file_bytes, "FIR file accounting mismatch")


def expected_inputs(catalog: dict) -> tuple[dict, dict, dict, dict]:
    root_receipt = json.loads((HERE / "iterations" / "round-01-evidence" /
                               "root-verification.json").read_text())
    verification = json.loads((HERE / "iterations" / "round-01-evidence" /
                               "verification.json").read_text())
    verification_by_identity = {row["identity"]: row for row in verification["stems"]}
    expected_rsd = {
        item["identity"]: {"recordBytes": item["recordBytes"],
                            "recordSha256": item["recordSha256"],
                            "recordCount": verification_by_identity[item["identity"]]["recordCount"]}
        for item in root_receipt["stems"]
    }
    baseline_evidence = json.loads((HERE / "evidence" / "results.json").read_text())
    baseline = {item["identity"]: next(result for result in item["results"]
                                       if result["candidate"] == "flac8e-30s")
                for item in baseline_evidence["stems"]}
    require(ROOT_ORIGINAL_AUDIT.is_file(), f"missing independent original-audit receipt: {ROOT_ORIGINAL_AUDIT}")
    root_audit = json.loads(ROOT_ORIGINAL_AUDIT.read_text())
    require(root_audit["format"] == "issue77-round3-independent-original-audit-v1",
            "bad independent original-audit receipt")
    expected_audit = {item["identity"]: item for item in root_audit["stems"]}
    require(set(expected_audit) == set(expected_rsd), "original-audit receipt stem set mismatch")
    return expected_rsd, baseline, verification_by_identity, expected_audit


def process_stem(row: dict, args: argparse.Namespace, expected_rsd: dict,
                 baseline: dict, expected_audit: dict, work_root: Path) -> dict:
    identity = row["identity"].split(":", 1)[1]
    rsd = args.records_root / identity / "stem.rsd"
    expected = expected_rsd[row["identity"]]
    r2.check_file(rsd, expected["recordBytes"], expected["recordSha256"])
    manifest_path = HERE / row["manifestPath"]
    manifest_bytes = manifest_path.read_bytes()
    require(sha(manifest_path) == row["manifestSha256"], "frozen manifest changed")
    manifest = json.loads(manifest_bytes)
    active_frames = r2.validate_manifest(manifest, row)
    embedded, record_count = r2.read_rsd_header(rsd, manifest_bytes)
    require(json.loads(embedded) == manifest and record_count == expected["recordCount"],
            "RSD manifest/count mismatch")
    r2.validate_rsd_layout(rsd, manifest, record_count)
    baseline_row = baseline[row["identity"]]
    active = args.corpus / identity / "active.raw"
    r2.check_file(active, row["activePcmBytes"], baseline_row["packedPcmSha256"])
    stem_work = work_root / identity
    stem_work.mkdir(parents=True, exist_ok=True)
    results: dict[int, dict[str, dict]] = {}
    for profile in args.profiles:
        results[profile] = {}
        for mode_index, mode in enumerate(MODES):
            stem = stem_work / f"p{profile}-{mode}"
            output, original_audit, coded_audit, enc_summary = (stem.with_suffix(suffix)
                for suffix in (".fir", ".original.audit", ".coded.audit", ".encode.json"))
            decoded, dec_original, dec_coded, dec_summary = (stem.with_suffix(suffix)
                for suffix in (".raw", ".decode.original.audit", ".decode.coded.audit", ".decode.json"))
            enc_time = r2.run_timed([str(args.helper), "encode", str(rsd), str(output),
                                     str(original_audit), str(coded_audit), str(enc_summary),
                                     str(mode_index), str(profile)], stem.with_suffix(".encode.receipt"))
            enc_info = parse_summary(enc_summary)
            header = read_fir_header(output, manifest_bytes, mode_index, profile, record_count)
            validate_summary(enc_info, header, output.stat().st_size, record_count)
            dec_time = r2.run_timed([str(args.helper), "decode", str(output), str(decoded),
                                     str(dec_original), str(dec_coded), str(dec_summary)],
                                    stem.with_suffix(".decode.receipt"))
            dec_info = parse_summary(dec_summary)
            r2.check_file(decoded, row["activePcmBytes"], baseline_row["packedPcmSha256"])
            require(r2.canonical_hash(decoded, manifest) == identity, "canonical hash mismatch")
            require(r2.chunk_hashes(decoded, manifest) ==
                    [chunk["pcmSha256"] for chunk in baseline_row["chunks"]], "chunk hash mismatch")
            require(sha(original_audit) == sha(dec_original), "original residual audit mismatch")
            require(original_audit.stat().st_size == expected_audit[row["identity"]]["originalAuditBytes"] and
                    sha(original_audit) == expected_audit[row["identity"]]["originalAuditSha256"],
                    "independent original residual audit mismatch")
            require(sha(coded_audit) == sha(dec_coded), "coded residual audit mismatch")
            validate_summary(dec_info, header, output.stat().st_size, record_count)
            for field in ("predictiveSubframes", "manifestBytes", "tableCount", "tableBytes",
                          "sideBytes", "entropyBytes", "bypassBytes", "frameBytes",
                          "predictionClamp", "coefficientClamp", "modularWrap", "updates"):
                require(enc_info[field] == dec_info[field], f"encode/decode mismatch {field}")
            results[profile][mode] = {
                "mode": mode, "profile": profile, "outputBytes": output.stat().st_size,
                "outputSha256": sha(output), "originalAuditSha256": sha(original_audit),
                "codedAuditSha256": sha(coded_audit), "auditBytes": coded_audit.stat().st_size,
                "encodeSummary": enc_info, "decodeSummary": dec_info,
                "encode": enc_time, "decode": dec_time,
            }
    for profile in args.profiles:
        require(results[profile]["rice"]["codedAuditSha256"] ==
                results[profile]["rans"]["codedAuditSha256"],
                f"Rice/rANS coded audit differs profile {profile}")
    return {"identity": row["identity"], "recordingRef": row["recordingRef"],
            "sourceIDs": row["sourceIDs"], "activeFrames": active_frames,
            "activePcmBytes": row["activePcmBytes"], "canonicalPcmSha256": identity,
            "packedPcmSha256": baseline_row["packedPcmSha256"], "rsdBytes": expected["recordBytes"],
            "rsdSha256": expected["recordSha256"], "manifestBytes": len(manifest_bytes),
            "originalAuditBytes": expected_audit[row["identity"]]["originalAuditBytes"],
            "originalAuditSha256": expected_audit[row["identity"]]["originalAuditSha256"],
            "profiles": results}


def mode_totals(rows: list[dict], profile: int, mode: str) -> dict:
    members = [row["profiles"][profile][mode] for row in rows]
    return {"profile": profile, "mode": mode, "stemCount": len(members),
            "outputBytes": sum(item["outputBytes"] for item in members),
            "recordCount": sum(item["encodeSummary"]["recordCount"] for item in members),
            "frameCount": sum(item["encodeSummary"]["frameCount"] for item in members),
            "predictiveSubframes": sum(item["encodeSummary"]["predictiveSubframes"] for item in members),
            "manifestBytes": sum(item["encodeSummary"]["manifestBytes"] for item in members),
            "tableBytes": sum(item["encodeSummary"]["tableBytes"] for item in members),
            "sideBytes": sum(item["encodeSummary"]["sideBytes"] for item in members),
            "entropyBytes": sum(item["encodeSummary"]["entropyBytes"] for item in members),
            "bypassBytes": sum(item["encodeSummary"]["bypassBytes"] for item in members),
            "frameBytes": sum(item["encodeSummary"]["frameBytes"] for item in members),
            "auditBytes": sum(item["auditBytes"] for item in members),
            "encodeWallSeconds": sum(item["encode"]["wallSeconds"] for item in members),
            "encodeUserSeconds": sum(item["encode"]["userSeconds"] for item in members),
            "encodeSystemSeconds": sum(item["encode"]["systemSeconds"] for item in members),
            "encodePeakRssKiB": max(item["encode"]["peakRssKiB"] for item in members),
            "decodeWallSeconds": sum(item["decode"]["wallSeconds"] for item in members),
            "decodeUserSeconds": sum(item["decode"]["userSeconds"] for item in members),
            "decodeSystemSeconds": sum(item["decode"]["systemSeconds"] for item in members),
            "decodePeakRssKiB": max(item["decode"]["peakRssKiB"] for item in members),
            "predictionClamp": sum(item["encodeSummary"]["predictionClamp"] for item in members),
            "coefficientClamp": sum(item["encodeSummary"]["coefficientClamp"] for item in members),
            "modularWrap": sum(item["encodeSummary"]["modularWrap"] for item in members),
            "updates": sum(item["encodeSummary"]["updates"] for item in members)}


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def freeze_config(args: argparse.Namespace, catalog: dict, expected_rsd: dict,
                  selected_profile: int | None, pilot_results_sha: str | None,
                  selection_sha: str | None) -> dict:
    native = HERE / "iterations" / "round-03" / "native" / "round3.c"
    return {"format": "issue77-round3-freeze-v1", "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scopeSha256": sha(HERE / "iterations" / "round-03-scope.md"),
            "runnerSha256": sha(Path(__file__)), "nativeSha256": sha(native),
            "round2EvidenceSha256": sha(HERE / "iterations" / "round-02-evidence" / "results.json"),
            "round2FreezeSha256": sha(HERE / "iterations" / "round-02-evidence" / "freeze.json"),
            "round2NativeSha256": sha(HERE / "iterations" / "round-02" / "native" / "round2.c"),
            "round2RunnerSha256": sha(HERE / "iterations" / "round-02" / "round2.py"),
            "round1NativeSha256": sha(HERE / "iterations" / "round-01" / "native" / "round1.c"),
            "sourcesSha256": sha(HERE / "sources.json"),
            "libFLACSha256": sha(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")),
            "round1VerificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "verification.json"),
            "round1RootVerificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "root-verification.json"),
            "independentOriginalAuditSha256": sha(ROOT_ORIGINAL_AUDIT),
            "records": expected_rsd, "helper": {"path": str(args.helper), "sha256": sha(args.helper)},
            "recordsRoot": str(args.records_root), "corpus": str(args.corpus),
            "workerConcurrency": args.workers, "profiles": args.profiles, "pilot": args.pilot_only,
            "selectedProfile": selected_profile, "pilotResultsSha256": pilot_results_sha,
            "pilotSelectionSha256": selection_sha,
            "compiler": "gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow",
            "compilerVersion": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
            "platform": platform.platform(), "cpu": subprocess.check_output(["lscpu"], text=True),
            "maxFrameBodyBytes": 4 * 1024 * 1024, "maxManifestBytes": 1024 * 1024,
            "maxTables": 4 * 31 * 5, "modes": {"rice": 0, "rans": 1},
            "commands": {"encode": "helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE PROFILE",
                         "decode": "helper decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY"},
            "pilotIdentities": PILOT, "catalogStemCount": len(catalog["stems"])}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--records-root", type=Path, default=DEFAULT_RECORDS)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 5))
    parser.add_argument("--pilot", nargs="*", default=PILOT)
    parser.add_argument("--pilot-only", action="store_true")
    parser.add_argument("--selected-profile", type=int)
    parser.add_argument("--profiles", nargs="+", type=int)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--pilot-work", type=Path)
    parser.add_argument("--resume-frozen", action="store_true")
    args = parser.parse_args()
    args.work = args.work.resolve(); args.helper = args.helper.resolve()
    args.records_root = args.records_root.resolve(); args.corpus = args.corpus.resolve()
    selection = None
    pilot_results_sha = None
    selection_sha = None
    if args.pilot_only:
        args.profiles = list(args.profiles or PROFILES)
        require(all(profile in PROFILES for profile in args.profiles), "invalid pilot profile")
    else:
        require(args.selection is not None and args.pilot_work is not None,
                "full run requires --selection and --pilot-work")
        args.selection = args.selection.resolve(); args.pilot_work = args.pilot_work.resolve()
        selection = json.loads(args.selection.read_text())
        pilot_results_path = args.pilot_work / "pilot-results.json"
        require(selection["format"] == "issue77-round3-selection-v1" and
                pilot_results_path.is_file(), "invalid pilot selection receipt")
        pilot_result = json.loads(pilot_results_path.read_text())
        require(pilot_result["format"] == "issue77-round3-results-v1" and
                pilot_result["pilot"] and pilot_result["stemCount"] == 4 and
                {row["identity"] for row in pilot_result["stems"]} == set(args.pilot),
                "pilot results do not match scoped selection stems")
        pilot_results_sha = sha(pilot_results_path)
        require(selection["pilotResultsSha256"] == pilot_results_sha and
                len(selection["profiles"]) == 4, "pilot result hash mismatch")
        candidates = sorted(selection["profiles"], key=lambda item: (item["ransBytes"], item["profile"]))
        require(selection["selectedProfile"] == candidates[0]["profile"],
                "selection receipt does not select the minimum pilot rANS profile")
        require(args.selected_profile == selection["selectedProfile"],
                "selected profile differs from selection receipt")
        selection_sha = sha(args.selection)
        args.profiles = [0, args.selected_profile]
    require(args.pilot_only or args.selected_profile in PROFILES[1:],
            "full run requires selected enabled profile")
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((HERE / "sources.json").read_text())
    expected_rsd, baseline, _, expected_audit = expected_inputs(catalog)
    stems = [row for row in catalog["stems"] if row["identity"] in args.pilot] if args.pilot_only else catalog["stems"]
    require(len(stems) == (4 if args.pilot_only else 30), "unexpected stem set")
    freeze_path = args.work / "freeze.json"
    pilot_results_path = args.work / "pilot-results.json"
    selected = args.selected_profile
    pilot_hash = None
    if args.resume_frozen:
        frozen = json.loads(freeze_path.read_text())
        require(frozen["scopeSha256"] == sha(HERE / "iterations" / "round-03-scope.md") and
                frozen["runnerSha256"] == sha(Path(__file__)) and frozen["nativeSha256"] == sha(HERE / "iterations" / "round-03" / "native" / "round3.c") and
                frozen["round2NativeSha256"] == sha(HERE / "iterations" / "round-02" / "native" / "round2.c") and
                frozen["round2RunnerSha256"] == sha(HERE / "iterations" / "round-02" / "round2.py") and
                frozen["independentOriginalAuditSha256"] == sha(ROOT_ORIGINAL_AUDIT) and
                frozen["sourcesSha256"] == sha(HERE / "sources.json") and
                frozen["recordsRoot"] == str(args.records_root) and frozen["corpus"] == str(args.corpus) and
                frozen["workerConcurrency"] == args.workers and frozen["records"] == expected_rsd and
                frozen["profiles"] == args.profiles and frozen["pilot"] == args.pilot_only and
                frozen["selectedProfile"] == selected and frozen["pilotResultsSha256"] == pilot_results_sha and
                frozen["pilotSelectionSha256"] == selection_sha,
                "round3 source/input changed after freeze")
        require(frozen["helper"]["sha256"] == sha(args.helper), "round3 helper changed after freeze")
        selected = frozen["selectedProfile"]
        pilot_hash = frozen["pilotResultsSha256"]
    else:
        require(not freeze_path.exists(), f"work directory already frozen: {freeze_path}")
        freeze_path.write_text(json.dumps(freeze_config(args, catalog, expected_rsd, selected,
                                                        pilot_results_sha, selection_sha), indent=2) + "\n")
    started = time.perf_counter()
    root = args.work / ("pilot" if args.pilot_only else "full")
    root.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process_stem, row, args, expected_rsd, baseline, expected_audit, root)
                   for row in stems]
        for future in futures:
            row = future.result(); rows.append(row)
            print(f"{row['recordingRef']}/{row['sourceIDs'][0]} complete", flush=True)
    rows.sort(key=lambda row: row["identity"])
    totals = {(profile, mode): mode_totals(rows, profile, mode)
              for profile in args.profiles for mode in MODES}
    control = sum(baseline[row["identity"]]["totalBytes"] for row in rows)
    session_rows = []
    for session in sorted({row["recordingRef"] for row in rows}):
        members = [row for row in rows if row["recordingRef"] == session]
        item = {"recordingRef": session, "stemCount": len(members),
                "controlBytes": sum(baseline[row["identity"]]["totalBytes"] for row in members)}
        for profile in args.profiles:
            for mode in MODES:
                item[f"p{profile}{mode}Bytes"] = sum(
                    row["profiles"][profile][mode]["outputBytes"] for row in members)
        session_rows.append(item)
    selected_ids = set(args.pilot)
    selection_totals = {f"p{p}-{m}": mode_totals(
        [row for row in rows if row["identity"] in selected_ids], p, m)
        for p in args.profiles for m in MODES} if not args.pilot_only else None
    remaining_totals = {f"p{p}-{m}": mode_totals(
        [row for row in rows if row["identity"] not in selected_ids], p, m)
        for p in args.profiles for m in MODES} if not args.pilot_only else None
    pilot_selection = None
    if args.pilot_only and set(args.profiles) == set(PROFILES):
        candidates = [{"profile": profile, "ransBytes": totals[(profile, "rans")]["outputBytes"]}
                      for profile in PROFILES[1:]]
        candidates.sort(key=lambda item: (item["ransBytes"], item["profile"]))
        selected = candidates[0]["profile"]
        pilot_selection = {"format": "issue77-round3-selection-v1", "profiles": candidates,
                           "selectedProfile": selected, "pilotIdentities": args.pilot,
                           "pilotResultsSha256": None}
    result = {"format": "issue77-round3-results-v1", "freezeSha256": sha(freeze_path),
              "pilot": args.pilot_only, "stemCount": len(rows),
              "elapsedSeconds": time.perf_counter() - started, "controlBytes": control,
              "selectedProfile": selected, "totals": {f"p{p}-{m}": totals[(p, m)]
                                                         for p in args.profiles for m in MODES},
              "sessions": session_rows, "selectionTotals": selection_totals,
              "remainingTotals": remaining_totals,
              "stems": rows}
    result_path = args.work / ("pilot-results.json" if args.pilot_only else "results.json")
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    if args.pilot_only and pilot_selection is not None:
        pilot_selection["pilotResultsSha256"] = sha(result_path)
        (args.work / "selection.json").write_text(json.dumps(pilot_selection, indent=2) + "\n")
        # The selection is part of the next measured freeze; retain its hash in
        # a small receipt instead of rewriting the pilot source freeze.
        print(json.dumps(pilot_selection, indent=2))
    stem_rows = []
    for row in rows:
        item = {"identity": row["identity"], "recordingRef": row["recordingRef"],
                "source": "/".join(row["sourceIDs"]), "controlBytes": baseline[row["identity"]]["totalBytes"]}
        for profile in args.profiles:
            for mode in MODES:
                value = row["profiles"][profile][mode]
                item[f"p{profile}{mode}Bytes"] = value["outputBytes"]
                item[f"p{profile}{mode}Sha256"] = value["outputSha256"]
        stem_rows.append(item)
    write_csv(args.work / ("pilot-per-stem.csv" if args.pilot_only else "per-stem.csv"), stem_rows)
    write_csv(args.work / ("pilot-per-session.csv" if args.pilot_only else "per-session.csv"), session_rows)
    print(json.dumps({"controlBytes": control,
                      "totals": {f"p{p}-{m}": totals[(p, m)]["outputBytes"]
                                 for p in args.profiles for m in MODES}, "selectedProfile": selected}, indent=2))


if __name__ == "__main__":
    main()
