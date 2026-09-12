#!/usr/bin/env python3
"""Bounded round-4 pilot/full runner over the frozen round-1 RSD corpus."""

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
R2_PATH = HERE / "iterations" / "round-02" / "round2.py"
spec = importlib.util.spec_from_file_location("round2_readonly", R2_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load frozen round2 runner: {R2_PATH}")
r2 = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r2
spec.loader.exec_module(r2)

DEFAULT_RECORDS = Path("/data/issue-77-lossless/iterations/round-01/full-run3/full")
DEFAULT_CORPUS = Path("/data/issue-77-lossless/run-02")
R3_FULL = Path("/data/issue-77-lossless/iterations/round-03/full-final/full")
ROOT_ORIGINAL_AUDIT = Path("/data/issue-77-lossless/iterations/round-03/root-original-audit.json")
MODES = ("rice", "rans")
PROFILES = (0, 1, 2)
PILOT = [
    "sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
    "sha256:8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
    "sha256:fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
    "sha256:68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def equal_after_magic(left: Path, right: Path) -> bool:
    with left.open("rb") as a, right.open("rb") as b:
        if len(a.read(8)) != 8 or len(b.read(8)) != 8:
            return False
        while True:
            left_block = a.read(1024 * 1024)
            right_block = b.read(1024 * 1024)
            if left_block != right_block:
                return False
            if not left_block:
                return True


def parse_summary(path: Path) -> dict:
    value = json.loads(path.read_text())
    require(value["format"] == "issue77-round4-summary-v1", f"bad round4 summary {path}")
    return value


def read_header(path: Path, expected_manifest: bytes, mode: int,
                profile: int, records: int) -> dict:
    with path.open("rb") as source:
        header = source.read(32)
        require(len(header) == 32 and header[:8] == b"I77XCH04", f"bad round4 header {path}")
        actual_mode, shape, actual_profile, reserved = header[8:12]
        manifest_length = int.from_bytes(header[12:20], "little")
        record_count = int.from_bytes(header[20:28], "little")
        table_count = int.from_bytes(header[28:32], "little")
        require((actual_mode, shape, actual_profile, reserved) == (mode, 1, profile, 0) and
                record_count == records and manifest_length <= 1024 * 1024 and
                table_count <= 4 * 31 * 5 and (mode or table_count == 0),
                "invalid round4 header")
        require(source.read(manifest_length) == expected_manifest, "embedded manifest differs")
        previous = None
        for _ in range(table_count):
            key_bytes = source.read(3)
            require(len(key_bytes) == 3, "truncated round4 table key")
            key = tuple(key_bytes)
            require(key[0] < 4 and key[1] < 31 and key[2] < 5 and
                    (previous is None or key > previous), "unordered round4 table key")
            previous = key
            frequencies = source.read(34)
            require(len(frequencies) == 34 and
                    sum(int.from_bytes(frequencies[i:i + 2], "little")
                        for i in range(0, 34, 2)) == 4096, "bad round4 table sum")
        return {"mode": mode, "profile": profile, "manifestBytes": manifest_length,
                "recordCount": record_count, "tableCount": table_count,
                "tableBytes": table_count * 37,
                "dataOffset": 32 + manifest_length + table_count * 37}


def validate_summary(summary: dict, header: dict, file_bytes: int, records: int) -> None:
    require(summary["mode"] == header["mode"] and
            summary["predictorProfile"] == header["profile"] and
            summary["recordCount"] == records and summary["frameCount"] == records,
            "round4 summary/header mismatch")
    require(summary["manifestBytes"] == header["manifestBytes"] and
            summary["tableCount"] == header["tableCount"] and
            summary["tableBytes"] == header["tableBytes"], "round4 table accounting mismatch")
    expected_frame_bytes = (8 * summary["frameCount"] + summary["sideBytes"] +
                            8 * summary["predictiveSubframes"] + summary["entropyBytes"] +
                            summary["bypassBytes"] + summary["coefficientBytes"])
    require(summary["frameBytes"] == expected_frame_bytes, "round4 frame accounting mismatch")
    require(summary["fileBytes"] == 32 + summary["manifestBytes"] + summary["tableBytes"] +
            summary["frameBytes"] == file_bytes, "round4 file accounting mismatch")
    require(summary["disabledFrames"] + summary["reference0Frames"] +
            summary["reference1Frames"] == records, "round4 selector accounting mismatch")


def expected_inputs(catalog: dict) -> tuple[dict, dict, dict]:
    root_receipt = json.loads((HERE / "iterations" / "round-01-evidence" /
                               "root-verification.json").read_text())
    verification = json.loads((HERE / "iterations" / "round-01-evidence" /
                               "verification.json").read_text())
    by_identity = {row["identity"]: row for row in verification["stems"]}
    expected_rsd = {item["identity"]: {"recordBytes": item["recordBytes"],
                                        "recordSha256": item["recordSha256"],
                                        "recordCount": by_identity[item["identity"]]["recordCount"]}
                    for item in root_receipt["stems"]}
    baseline_evidence = json.loads((HERE / "evidence" / "results.json").read_text())
    baseline = {item["identity"]: next(result for result in item["results"]
                                       if result["candidate"] == "flac8e-30s")
                for item in baseline_evidence["stems"]}
    root_audit = json.loads(ROOT_ORIGINAL_AUDIT.read_text())
    expected_audit = {item["identity"]: item for item in root_audit["stems"]}
    require(set(expected_audit) == set(expected_rsd), "original audit stem set mismatch")
    return expected_rsd, baseline, expected_audit


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
    embedded, count = r2.read_rsd_header(rsd, manifest_bytes)
    require(json.loads(embedded) == manifest and count == expected["recordCount"],
            "RSD manifest/count mismatch")
    r2.validate_rsd_layout(rsd, manifest, count)
    base = baseline[row["identity"]]
    active = args.corpus / identity / "active.raw"
    r2.check_file(active, row["activePcmBytes"], base["packedPcmSha256"])
    stem_work = work_root / identity
    stem_work.mkdir(parents=True, exist_ok=True)
    results: dict[int, dict[str, dict]] = {}
    for profile in args.profiles:
        results[profile] = {}
        for mode_index, mode_name in enumerate(MODES):
            stem = stem_work / f"p{profile}-{mode_name}"
            output = stem.with_suffix(".xch")
            original_audit = stem.with_suffix(".original.audit")
            coded_audit = stem.with_suffix(".coded.audit")
            enc_summary = stem.with_suffix(".encode.json")
            decoded = stem.with_suffix(".raw")
            dec_original = stem.with_suffix(".decode.original.audit")
            dec_coded = stem.with_suffix(".decode.coded.audit")
            dec_summary = stem.with_suffix(".decode.json")
            enc_time = r2.run_timed([str(args.helper), "encode", str(rsd), str(output),
                                     str(original_audit), str(coded_audit), str(enc_summary),
                                     str(mode_index), str(profile)], stem.with_suffix(".encode.time"))
            enc = parse_summary(enc_summary)
            header = read_header(output, manifest_bytes, mode_index, profile, count)
            validate_summary(enc, header, output.stat().st_size, count)
            if profile == 0:
                old = R3_FULL / identity / f"p0-{mode_name}.fir"
                require(old.is_file(), f"missing frozen round3 P0 control {old}")
                require(equal_after_magic(output, old), "disabled round4 framing differs from round3 P0")
            dec_time = r2.run_timed([str(args.helper), "decode", str(output), str(decoded),
                                     str(dec_original), str(dec_coded), str(dec_summary)],
                                    stem.with_suffix(".decode.time"))
            dec = parse_summary(dec_summary)
            r2.check_file(decoded, row["activePcmBytes"], base["packedPcmSha256"])
            require(r2.canonical_hash(decoded, manifest) == identity, "canonical hash mismatch")
            require(r2.chunk_hashes(decoded, manifest) ==
                    [chunk["pcmSha256"] for chunk in base["chunks"]], "chunk hash mismatch")
            require(sha(original_audit) == sha(dec_original) and
                    original_audit.stat().st_size == expected_audit[row["identity"]]["originalAuditBytes"] and
                    sha(original_audit) == expected_audit[row["identity"]]["originalAuditSha256"],
                    "original residual audit mismatch")
            require(sha(coded_audit) == sha(dec_coded), "coded residual audit mismatch")
            validate_summary(dec, header, output.stat().st_size, count)
            for field in ("predictiveSubframes", "manifestBytes", "tableCount", "tableBytes",
                          "sideBytes", "entropyBytes", "bypassBytes", "frameBytes",
                          "disabledFrames", "reference0Frames", "reference1Frames",
                          "coefficientBytes", "predictionClamp", "modularWrap"):
                require(enc[field] == dec[field], f"encode/decode mismatch {field}")
            results[profile][mode_name] = {
                "mode": mode_name, "profile": profile, "outputBytes": output.stat().st_size,
                "outputSha256": sha(output), "originalAuditSha256": sha(original_audit),
                "codedAuditSha256": sha(coded_audit), "auditBytes": coded_audit.stat().st_size,
                "encodeSummary": enc, "decodeSummary": dec, "encode": enc_time, "decode": dec_time,
            }
    for profile in args.profiles:
        require(results[profile]["rice"]["codedAuditSha256"] ==
                results[profile]["rans"]["codedAuditSha256"],
                f"Rice/RANS coded audit differs for profile {profile}")
    return {"identity": row["identity"], "recordingRef": row["recordingRef"],
            "sourceIDs": row["sourceIDs"], "activeFrames": active_frames,
            "activePcmBytes": row["activePcmBytes"], "canonicalPcmSha256": identity,
            "packedPcmSha256": base["packedPcmSha256"], "rsdBytes": expected["recordBytes"],
            "rsdSha256": expected["recordSha256"], "manifestBytes": len(manifest_bytes),
            "originalAuditBytes": expected_audit[row["identity"]]["originalAuditBytes"],
            "originalAuditSha256": expected_audit[row["identity"]]["originalAuditSha256"],
            "profiles": results}


def mode_totals(rows: list[dict], profile: int, mode: str) -> dict:
    members = [row["profiles"][profile][mode] for row in rows]
    def total(field: str) -> int:
        return sum(item["encodeSummary"][field] for item in members)
    return {"profile": profile, "mode": mode, "stemCount": len(members),
            "outputBytes": sum(item["outputBytes"] for item in members),
            "recordCount": total("recordCount"), "frameCount": total("frameCount"),
            "predictiveSubframes": total("predictiveSubframes"), "manifestBytes": total("manifestBytes"),
            "tableBytes": total("tableBytes"), "sideBytes": total("sideBytes"),
            "entropyBytes": total("entropyBytes"), "bypassBytes": total("bypassBytes"),
            "frameBytes": total("frameBytes"), "auditBytes": sum(item["auditBytes"] for item in members),
            "encodeWallSeconds": sum(item["encode"]["wallSeconds"] for item in members),
            "decodeWallSeconds": sum(item["decode"]["wallSeconds"] for item in members),
            "encodeUserSeconds": sum(item["encode"]["userSeconds"] for item in members),
            "decodeUserSeconds": sum(item["decode"]["userSeconds"] for item in members),
            "encodeSystemSeconds": sum(item["encode"]["systemSeconds"] for item in members),
            "decodeSystemSeconds": sum(item["decode"]["systemSeconds"] for item in members),
            "encodePeakRssKiB": max(item["encode"]["peakRssKiB"] for item in members),
            "decodePeakRssKiB": max(item["decode"]["peakRssKiB"] for item in members),
            **{field: total(field) for field in ("disabledFrames", "reference0Frames",
                                                  "reference1Frames", "coefficientBytes",
                                                  "predictionClamp", "modularWrap",
                                                  "fitDegenerate", "fitFailures",
                                                  "coefficientClipping")}}


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader(); writer.writerows(rows)


def freeze_config(args: argparse.Namespace, expected_rsd: dict, selected: int | None,
                  pilot_results_sha: str | None, selection_sha: str | None) -> dict:
    native = HERE / "iterations" / "round-04" / "native" / "round4.c"
    return {"format": "issue77-round4-freeze-v1", "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scopeSha256": sha(HERE / "iterations" / "round-04-scope.md"),
            "runnerSha256": sha(Path(__file__)), "nativeSha256": sha(native),
            "round3NativeSha256": sha(HERE / "iterations" / "round-03" / "native" / "round3.c"),
            "round3EvidenceSha256": sha(HERE / "iterations" / "round-03-evidence" / "full-results.json"),
            "round3FreezeSha256": sha(HERE / "iterations" / "round-03-evidence" / "full-freeze.json"),
            "round2NativeSha256": sha(HERE / "iterations" / "round-02" / "native" / "round2.c"),
            "round2RunnerSha256": sha(HERE / "iterations" / "round-02" / "round2.py"),
            "round1NativeSha256": sha(HERE / "iterations" / "round-01" / "native" / "round1.c"),
            "sourcesSha256": sha(HERE / "sources.json"),
            "baselineEvidenceSha256": sha(HERE / "evidence" / "results.json"),
            "r1VerificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "verification.json"),
            "r1RootVerificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "root-verification.json"),
            "libFLACSha256": sha(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")),
            "independentOriginalAuditSha256": sha(ROOT_ORIGINAL_AUDIT), "records": expected_rsd,
            "helper": {"path": str(args.helper), "sha256": sha(args.helper)},
            "recordsRoot": str(args.records_root), "corpus": str(args.corpus),
            "workerConcurrency": args.workers, "profiles": args.profiles, "pilot": args.pilot_only,
            "selectedProfile": selected, "pilotResultsSha256": pilot_results_sha,
            "pilotSelectionSha256": selection_sha, "maxFrameBodyBytes": 4 * 1024 * 1024,
            "maxManifestBytes": 1024 * 1024, "maxTables": 4 * 31 * 5,
            "modes": {"rice": 0, "rans": 1}, "compiler": "gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow -fno-fast-math -ffp-contract=off",
            "compilerVersion": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
            "sanitized": args.sanitized_pilot,
            "platform": platform.platform(), "cpu": subprocess.check_output(["lscpu"], text=True),
            "commands": {"encode": "helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE PROFILE",
                         "decode": "helper decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY"}}


def verify_freeze(frozen: dict, args: argparse.Namespace, expected_rsd: dict,
                  selected: int | None, pilot_results_sha: str | None,
                  selection_sha: str | None) -> None:
    require(frozen["runnerSha256"] == sha(Path(__file__)) and
            frozen["nativeSha256"] == sha(HERE / "iterations" / "round-04" / "native" / "round4.c") and
            frozen["scopeSha256"] == sha(HERE / "iterations" / "round-04-scope.md") and
            frozen["helper"]["sha256"] == sha(args.helper), "round4 source/helper changed")
    expected_kind = "pilot" if args.pilot_only else "sanitized-pilot" if args.sanitized_pilot else "full"
    frozen_selected = None if args.pilot_only else selected
    require(frozen.get("runKind") == expected_kind and frozen["records"] == expected_rsd and
            frozen["corpus"] == str(args.corpus) and frozen["profiles"] == args.profiles and
            frozen["selectedProfile"] == frozen_selected and frozen["pilotResultsSha256"] == pilot_results_sha and
            frozen["pilotSelectionSha256"] == selection_sha, "round4 inputs changed")
    require(frozen["round3EvidenceSha256"] ==
            sha(HERE / "iterations" / "round-03-evidence" / "full-results.json") and
            frozen["round3FreezeSha256"] ==
            sha(HERE / "iterations" / "round-03-evidence" / "full-freeze.json") and
            frozen["round3NativeSha256"] == sha(HERE / "iterations" / "round-03" / "native" / "round3.c") and
            frozen["round2NativeSha256"] == sha(HERE / "iterations" / "round-02" / "native" / "round2.c") and
            frozen["round2RunnerSha256"] == sha(HERE / "iterations" / "round-02" / "round2.py") and
            frozen["round1NativeSha256"] == sha(HERE / "iterations" / "round-01" / "native" / "round1.c") and
            frozen["sourcesSha256"] == sha(HERE / "sources.json") and
            frozen["baselineEvidenceSha256"] == sha(HERE / "evidence" / "results.json") and
            frozen["r1VerificationSha256"] == sha(HERE / "iterations" / "round-01-evidence" / "verification.json") and
            frozen["r1RootVerificationSha256"] == sha(HERE / "iterations" / "round-01-evidence" / "root-verification.json") and
            frozen["independentOriginalAuditSha256"] == sha(ROOT_ORIGINAL_AUDIT) and
            frozen["libFLACSha256"] == sha(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")),
            "round4 dependency changed")


def load_selection(selection_path: Path, pilot_work: Path, selected: int | None,
                   args: argparse.Namespace) -> tuple[dict, str, str, dict]:
    selection = json.loads(selection_path.read_text())
    pilot_results_path = pilot_work / "pilot-results.json"
    require(selection.get("format") == "issue77-round4-selection-v1" and
            pilot_results_path.is_file(), "invalid round4 selection receipt")
    result = json.loads(pilot_results_path.read_text())
    pilot_freeze_path = pilot_work / "freeze.json"
    require(pilot_freeze_path.is_file() and
            result.get("freezeSha256") == sha(pilot_freeze_path),
            "pilot result is not bound to its freeze")
    pilot_freeze = json.loads(pilot_freeze_path.read_text())
    native = HERE / "iterations" / "round-04" / "native" / "round4.c"
    dependencies = {
        "nativeSha256": native,
        "runnerSha256": Path(__file__),
        "scopeSha256": HERE / "iterations" / "round-04-scope.md",
        "round3NativeSha256": HERE / "iterations" / "round-03" / "native" / "round3.c",
        "round2NativeSha256": HERE / "iterations" / "round-02" / "native" / "round2.c",
        "round2RunnerSha256": HERE / "iterations" / "round-02" / "round2.py",
        "round1NativeSha256": HERE / "iterations" / "round-01" / "native" / "round1.c",
        "sourcesSha256": HERE / "sources.json",
        "baselineEvidenceSha256": HERE / "evidence" / "results.json",
        "r1VerificationSha256": HERE / "iterations" / "round-01-evidence" / "verification.json",
        "r1RootVerificationSha256": HERE / "iterations" / "round-01-evidence" / "root-verification.json",
        "independentOriginalAuditSha256": ROOT_ORIGINAL_AUDIT,
    }
    require(pilot_freeze.get("runKind") == "pilot" and pilot_freeze.get("profiles") == [0, 1, 2] and
            pilot_freeze.get("pilot") is True and pilot_freeze.get("recordsRoot") == str(args.records_root) and
            pilot_freeze.get("corpus") == str(args.corpus), "pilot freeze configuration mismatch")
    for key, path in dependencies.items():
        require(pilot_freeze.get(key) == sha(path), f"pilot freeze dependency changed: {key}")
    helper_path = Path(pilot_freeze["helper"]["path"])
    require(helper_path.is_file() and pilot_freeze["helper"]["sha256"] == sha(helper_path),
            "pilot helper changed after freeze")
    require(result.get("format") == "issue77-round4-results-v1" and result.get("pilot") is True and
            result.get("stemCount") == 4 and
            {row["identity"] for row in result["stems"]} == set(PILOT),
            "selection pilot result is not the four scoped stems")
    result_sha = sha(pilot_results_path)
    selection_sha = sha(selection_path)
    require(selection.get("pilotResultsSha256") == result_sha and selected in (1, 2) and
            selection.get("selectedProfile") == selected, "selection receipt hash/profile mismatch")
    candidates = sorted(selection.get("profiles", []), key=lambda item: (item["ransBytes"], item["profile"]))
    require({item["profile"] for item in candidates} == {1, 2}, "selection candidate set mismatch")
    for candidate in candidates:
        actual = sum(row["profiles"][str(candidate["profile"])]["rans"]["outputBytes"]
                     for row in result["stems"])
        require(actual == candidate["ransBytes"], "selection rANS total is not recomputed from pilot rows")
    require(candidates[0]["profile"] == selected, "selection is not minimum pilot rANS")
    return selection, result_sha, selection_sha, pilot_freeze


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--records-root", type=Path, default=DEFAULT_RECORDS)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 5))
    parser.add_argument("--pilot", nargs="*", default=PILOT)
    parser.add_argument("--pilot-only", action="store_true")
    parser.add_argument("--sanitized-pilot", action="store_true")
    parser.add_argument("--profiles", nargs="+", type=int)
    parser.add_argument("--selected-profile", type=int)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--pilot-work", type=Path)
    args = parser.parse_args()
    for name in ("work", "helper", "records_root", "corpus"):
        setattr(args, name, getattr(args, name).resolve())
    selection = None; pilot_results_sha = None; selection_sha = None; pilot_freeze = None
    require(not (args.pilot_only and args.sanitized_pilot), "choose one pilot mode")
    run_kind = "full"
    if args.pilot_only:
        run_kind = "pilot"
        require(set(args.pilot) == set(PILOT) and len(args.pilot) == 4,
                "pilot must use the exact four scoped identities")
        args.profiles = list(args.profiles or PROFILES)
        require(set(args.profiles) == set(PROFILES), "pilot must run profiles 0,1,2")
    elif args.sanitized_pilot:
        run_kind = "sanitized-pilot"
        require(args.selection and args.pilot_work and args.selected_profile in (1, 2),
                "sanitized pilot requires selection and selected profile")
        require(set(args.pilot) == set(PILOT) and len(args.pilot) == 4,
                "sanitized pilot must use the exact four scoped identities")
        args.selection = args.selection.resolve(); args.pilot_work = args.pilot_work.resolve()
        _, pilot_results_sha, selection_sha, pilot_freeze = load_selection(
            args.selection, args.pilot_work, args.selected_profile, args)
        args.profiles = [args.selected_profile]
    else:
        require(args.selection and args.pilot_work, "full run requires selection and pilot work")
        args.selection = args.selection.resolve(); args.pilot_work = args.pilot_work.resolve()
        selection, pilot_results_sha, selection_sha, pilot_freeze = load_selection(
            args.selection, args.pilot_work, args.selected_profile, args)
        args.profiles = [0, args.selected_profile]
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((HERE / "sources.json").read_text())
    expected_rsd, baseline, expected_audit = expected_inputs(catalog)
    if pilot_freeze is not None:
        require(pilot_freeze.get("records") == expected_rsd,
                "pilot freeze RSD catalog differs from current frozen records")
    stems = [row for row in catalog["stems"] if row["identity"] in args.pilot] if run_kind != "full" else catalog["stems"]
    require(len(stems) == (4 if run_kind != "full" else 30), "unexpected scoped stem count")
    freeze_path = args.work / "freeze.json"
    selected = args.selected_profile
    require(not freeze_path.exists(), "work directory already frozen")
    freeze = freeze_config(args, expected_rsd, selected, pilot_results_sha, selection_sha)
    freeze["runKind"] = run_kind
    freeze["pilotIdentities"] = args.pilot
    if args.sanitized_pilot:
        freeze["compiler"] = ("gcc -std=c11 -O1 -g -fno-omit-frame-pointer -fno-fast-math "
                               "-ffp-contract=off -fsanitize=address,undefined -Wall -Wextra "
                               "-Wconversion -Wshadow")
    freeze_path.write_text(json.dumps(freeze, indent=2) + "\n")
    verify_freeze(freeze, args, expected_rsd, selected, pilot_results_sha, selection_sha)
    started = time.perf_counter(); root = args.work / ("pilot" if run_kind == "pilot" else
                                                        "sanitized-pilot" if run_kind == "sanitized-pilot" else "full")
    root.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process_stem, row, args, expected_rsd, baseline, expected_audit, root)
                   for row in stems]
        for future in futures:
            row = future.result(); rows.append(row)
            print(f"{row['recordingRef']}/{row['sourceIDs'][0]} complete", flush=True)
    rows.sort(key=lambda row: row["identity"])
    totals = {(p, m): mode_totals(rows, p, m) for p in args.profiles for m in MODES}
    control = sum(baseline[row["identity"]]["totalBytes"] for row in rows)
    sessions = []
    for session in sorted({row["recordingRef"] for row in rows}):
        members = [row for row in rows if row["recordingRef"] == session]
        item = {"recordingRef": session, "stemCount": len(members),
                "controlBytes": sum(baseline[row["identity"]]["totalBytes"] for row in members)}
        for p in args.profiles:
            for m in MODES:
                item[f"p{p}{m}Bytes"] = sum(row["profiles"][p][m]["outputBytes"] for row in members)
        sessions.append(item)
    selected_ids = set(args.pilot)
    pilot_totals = ({f"p{p}-{m}": mode_totals([r for r in rows if r["identity"] in selected_ids], p, m)
                     for p in args.profiles for m in MODES} if run_kind == "full" else None)
    remaining_totals = ({f"p{p}-{m}": mode_totals([r for r in rows if r["identity"] not in selected_ids], p, m)
                         for p in args.profiles for m in MODES} if run_kind == "full" else None)
    pilot_selection = None
    if args.pilot_only:
        candidates = sorted(({"profile": p, "ransBytes": totals[(p, "rans")]["outputBytes"]}
                             for p in PROFILES[1:]), key=lambda item: (item["ransBytes"], item["profile"]))
        selected = candidates[0]["profile"]
        pilot_selection = {"format": "issue77-round4-selection-v1", "profiles": candidates,
                           "selectedProfile": selected, "pilotIdentities": args.pilot,
                           "pilotResultsSha256": None}
    result = {"format": "issue77-round4-results-v1", "freezeSha256": sha(freeze_path),
              "runKind": run_kind, "pilot": args.pilot_only, "stemCount": len(rows),
              "elapsedSeconds": time.perf_counter() - started, "controlBytes": control,
              "selectedProfile": selected, "totals": {f"p{p}-{m}": totals[(p, m)] for p in args.profiles for m in MODES},
              "sessions": sessions, "selectionTotals": pilot_totals, "remainingTotals": remaining_totals,
              "stems": rows}
    result_path = args.work / ("pilot-results.json" if args.pilot_only else "results.json")
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    if pilot_selection:
        pilot_selection["pilotResultsSha256"] = sha(result_path)
        (args.work / "selection.json").write_text(json.dumps(pilot_selection, indent=2) + "\n")
        print(json.dumps(pilot_selection, indent=2))
    stem_rows = []
    for row in rows:
        item = {"identity": row["identity"], "recordingRef": row["recordingRef"],
                "source": "/".join(row["sourceIDs"]), "controlBytes": baseline[row["identity"]]["totalBytes"]}
        for p in args.profiles:
            for m in MODES:
                item[f"p{p}{m}Bytes"] = row["profiles"][p][m]["outputBytes"]
                item[f"p{p}{m}Sha256"] = row["profiles"][p][m]["outputSha256"]
        stem_rows.append(item)
    write_csv(args.work / ("pilot-per-stem.csv" if args.pilot_only else
                           "sanitized-per-stem.csv" if args.sanitized_pilot else "per-stem.csv"), stem_rows)
    write_csv(args.work / ("pilot-per-session.csv" if args.pilot_only else
                           "sanitized-per-session.csv" if args.sanitized_pilot else "per-session.csv"), sessions)
    verify_freeze(freeze, args, expected_rsd, selected, pilot_results_sha, selection_sha)
    print(json.dumps({"controlBytes": control, "totals": {f"p{p}-{m}": totals[(p, m)]["outputBytes"] for p in args.profiles for m in MODES},
                      "selectedProfile": selected}, indent=2))


if __name__ == "__main__":
    main()
