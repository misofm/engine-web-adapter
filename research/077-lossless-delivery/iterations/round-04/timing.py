#!/usr/bin/env python3
"""Serial, audit-free decode timing for the frozen round-4 pilots.

The timed interval is only the native decode command, including its PCM output
write.  Input warming, compressed-file hashing, and PCM verification happen
outside that interval.  This runner intentionally refuses to reuse a timing
work directory: a timing result is tied to the freeze written before its first
trial.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import time


HERE = Path(__file__).resolve().parents[2]
PILOTS = (
    "ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
    "8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
    "fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
    "68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f",
)
TRIAL_COUNT = 3
STEM_SEED = 0x77040000
MODE_SEED = 0x7704A000
COPY_BYTES = 1024 * 1024
DEFAULT_R3_WORK = Path("/data/issue-77-lossless/iterations/round-03/pilot-run4")
DEFAULT_SANITIZED_WORK = Path("/data/issue-77-lossless/iterations/round-04/sanitized-final2")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    require(path.is_file(), f"missing file for hash: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(COPY_BYTES):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    require(path.is_file(), f"missing JSON: {path}")
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"JSON object required: {path}")
    return value


def warm(path: Path) -> None:
    """Read a compressed input before timing; no digest work is done here."""
    with path.open("rb") as source:
        while source.read(COPY_BYTES):
            pass


def identity_key(stem: str) -> str:
    return f"sha256:{stem}"


def parse_time_receipt(path: Path) -> tuple[float, float, int]:
    require(path.is_file(), f"missing /usr/bin/time receipt: {path}")
    values = path.read_text().split()
    require(len(values) == 3, f"invalid /usr/bin/time receipt: {path}")
    return float(values[0]), float(values[1]), int(values[2])


def timed_decode(command: list[str], output: Path, receipt_root: Path) -> dict:
    """Run one native decode; output creation is inside this timed interval."""
    require(not output.exists(), f"PCM output is not fresh: {output}")
    receipt_root.parent.mkdir(parents=True, exist_ok=True)
    time_path = receipt_root.with_suffix(".time")
    stderr_path = receipt_root.with_suffix(".stderr")
    require(not time_path.exists() and not stderr_path.exists(),
            f"timing receipt already exists: {receipt_root}")
    started = time.perf_counter()
    with stderr_path.open("wb") as stderr:
        completed = subprocess.run(
            ["/usr/bin/time", "-f", "%U %S %M", "-o", str(time_path), *command],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr,
            check=False,
        )
    wall_seconds = time.perf_counter() - started
    if completed.returncode != 0:
        detail = stderr_path.read_text(errors="replace")[-2000:]
        raise ValueError(f"timed decode failed ({completed.returncode}): {command}: {detail}")
    require(stderr_path.stat().st_size == 0,
            f"timed decode wrote diagnostics: {command}")
    user_seconds, system_seconds, peak_rss = parse_time_receipt(time_path)
    return {
        "wallSeconds": wall_seconds,
        "userSeconds": user_seconds,
        "systemSeconds": system_seconds,
        "peakRssKiB": peak_rss,
        "timedCommand": command,
        "hashVerificationInsideTimedInterval": False,
        "pcmWriteInsideTimedInterval": True,
        "rssScope": "child process maximum RSS from /usr/bin/time, KiB",
    }


def selected_modes(profile: int) -> tuple[str, ...]:
    return ("p0-rice", "p0-rans", f"p{profile}-rice", f"p{profile}-rans", "r3-p3-rans")


def validate_r4_pilot(pilot_work: Path, selected_profile: int) -> tuple[dict, dict, dict, dict]:
    freeze_path = pilot_work / "freeze.json"
    results_path = pilot_work / "pilot-results.json"
    selection_path = pilot_work / "selection.json"
    freeze = read_json(freeze_path)
    results = read_json(results_path)
    selection = read_json(selection_path)
    require(freeze.get("format") == "issue77-round4-freeze-v1" and
            freeze.get("runKind") == "pilot" and freeze.get("pilot") is True,
            "pilot freeze is not a round-4 pilot freeze")
    require(freeze.get("profiles") == [0, 1, 2], "round-4 pilot profile grid changed")
    require(results.get("format") == "issue77-round4-results-v1" and
            results.get("pilot") is True and results.get("stemCount") == len(PILOTS),
            "pilot results are not the scoped round-4 result")
    require(results.get("freezeSha256") == sha(freeze_path),
            "round-4 pilot results do not authenticate their freeze")
    require(selection.get("format") == "issue77-round4-selection-v1",
            "bad round-4 selection receipt")
    expected_ids = [identity_key(stem) for stem in PILOTS]
    require(set(selection.get("pilotIdentities", [])) == set(expected_ids) and
            len(selection.get("pilotIdentities", [])) == len(PILOTS),
            "round-4 selection identities differ from the exact four pilots")
    rows = {row["identity"]: row for row in results.get("stems", [])}
    require(set(rows) == set(expected_ids) and len(rows) == len(PILOTS),
            "round-4 pilot result identities differ from the exact four pilots")
    require(selection.get("pilotResultsSha256") == sha(results_path),
            "selection receipt pilot-results hash mismatch")
    candidates = selection.get("profiles")
    require(isinstance(candidates, list) and {item.get("profile") for item in candidates} == {1, 2},
            "selection receipt does not contain both enabled profiles")
    for candidate in candidates:
        profile = candidate["profile"]
        expected_bytes = sum(rows[identity]["profiles"][str(profile)]["rans"]["outputBytes"]
                             for identity in expected_ids)
        require(candidate.get("ransBytes") == expected_bytes,
                f"selection rANS bytes disagree with pilot rows for profile {profile}")
    winner = min(candidates, key=lambda item: (item["ransBytes"], item["profile"]))
    require(selection.get("selectedProfile") == winner["profile"] and
            selected_profile == selection.get("selectedProfile"),
            "selected profile differs from the frozen round-4 pilot selection")
    require(freeze.get("nativeSha256") == sha(HERE / "iterations" / "round-04" / "native" / "round4.c"),
            "round-4 pilot native source changed")
    require(freeze.get("runnerSha256") == sha(HERE / "iterations" / "round-04" / "round4.py"),
            "round-4 pilot runner changed")
    helper_path = Path(freeze["helper"]["path"]).resolve()
    require(freeze.get("helper", {}).get("sha256") == sha(helper_path),
            "round-4 pilot helper changed")
    receipt = read_json(pilot_work / "root-verification.json")
    require(receipt.get("format") == "issue77-round4-root-audit-v1" and
            receipt.get("allChecksPassed") is True and receipt.get("artifactCount") == 24 and
            receipt.get("freezeSha256") == sha(freeze_path),
            "round-4 pilot root audit is not the verified 24-file receipt")
    return freeze, results, selection, {row["identity"]: row for row in results["stems"]}


def validate_r4_full(full_work: Path, selected_profile: int, pilot_work: Path,
                     pilot_results: dict, selection: dict) -> tuple[dict, dict]:
    freeze_path = full_work / "freeze.json"
    results_path = full_work / "results.json"
    freeze = read_json(freeze_path)
    results = read_json(results_path)
    require(freeze.get("format") == "issue77-round4-freeze-v1" and
            freeze.get("runKind") == "full" and freeze.get("pilot") is False and
            freeze.get("profiles") == [0, selected_profile] and
            freeze.get("selectedProfile") == selected_profile,
            "full freeze is not the selected round-4 run")
    require(results.get("format") == "issue77-round4-results-v1" and
            results.get("pilot") is False and results.get("runKind") == "full" and
            results.get("stemCount") == 30 and results.get("selectedProfile") == selected_profile,
            "full results are not the scoped round-4 result")
    require(results.get("freezeSha256") == sha(freeze_path),
            "round-4 full results do not authenticate their freeze")
    require(freeze.get("pilotResultsSha256") == sha(pilot_work / "pilot-results.json") and
            freeze.get("pilotSelectionSha256") == sha(pilot_work / "selection.json") and
            selection.get("pilotResultsSha256") == sha(pilot_work / "pilot-results.json"),
            "full freeze is not bound to the final pilot selection")
    require(freeze.get("nativeSha256") == sha(HERE / "iterations" / "round-04" / "native" / "round4.c") and
            freeze.get("runnerSha256") == sha(HERE / "iterations" / "round-04" / "round4.py"),
            "round-4 full source changed")
    helper_path = Path(freeze["helper"]["path"]).resolve()
    require(freeze.get("helper", {}).get("sha256") == sha(helper_path),
            "round-4 full helper changed")
    receipt = read_json(full_work / "root-verification.json")
    require(receipt.get("format") == "issue77-round4-root-audit-v1" and
            receipt.get("allChecksPassed") is True and receipt.get("artifactCount") == 120 and
            receipt.get("freezeSha256") == sha(freeze_path),
            "round-4 full root audit is not the verified 120-file receipt")
    return freeze, results


def validate_r4_sanitized(sanitized_work: Path, selected_profile: int) -> tuple[dict, dict]:
    freeze_path = sanitized_work / "freeze.json"
    results_path = sanitized_work / "results.json"
    freeze = read_json(freeze_path)
    results = read_json(results_path)
    require(freeze.get("format") == "issue77-round4-freeze-v1" and
            freeze.get("runKind") == "sanitized-pilot" and
            freeze.get("profiles") == [selected_profile] and
            freeze.get("selectedProfile") == selected_profile,
            "sanitized freeze is not the selected round-4 pilot")
    require(results.get("format") == "issue77-round4-results-v1" and
            results.get("runKind") == "sanitized-pilot" and
            results.get("pilot") is False and results.get("stemCount") == len(PILOTS) and
            results.get("selectedProfile") == selected_profile and
            results.get("freezeSha256") == sha(freeze_path),
            "sanitized results do not authenticate the selected pilot")
    require(freeze.get("nativeSha256") == sha(HERE / "iterations" / "round-04" / "native" / "round4.c") and
            freeze.get("runnerSha256") == sha(HERE / "iterations" / "round-04" / "round4.py"),
            "sanitized round-4 source changed")
    helper_path = Path(freeze["helper"]["path"]).resolve()
    require(freeze.get("helper", {}).get("sha256") == sha(helper_path),
            "sanitized round-4 helper changed")
    receipt = read_json(sanitized_work / "root-verification.json")
    require(receipt.get("format") == "issue77-round4-root-audit-v1" and
            receipt.get("allChecksPassed") is True and receipt.get("artifactCount") == 8 and
            receipt.get("freezeSha256") == sha(freeze_path),
            "sanitized root audit is not the verified 8-file receipt")
    return freeze, results


def validate_r3_reference(r3_work: Path, r3_helper: Path) -> tuple[dict, dict, dict]:
    freeze_path = r3_work / "freeze.json"
    results_path = r3_work / "pilot-results.json"
    selection_path = r3_work / "selection.json"
    freeze = read_json(freeze_path)
    results = read_json(results_path)
    selection = read_json(selection_path)
    require(freeze.get("format") == "issue77-round3-freeze-v1" and freeze.get("pilot") is True and
            freeze.get("profiles") == [0, 1, 2, 3, 4],
            "R3 reference is not the frozen five-profile pilot")
    require(results.get("format") == "issue77-round3-results-v1" and
            results.get("pilot") is True and results.get("stemCount") == len(PILOTS) and
            results.get("freezeSha256") == sha(freeze_path),
            "R3 reference results do not authenticate their freeze")
    require(selection.get("format") == "issue77-round3-selection-v1" and
            selection.get("pilotResultsSha256") == sha(results_path) and
            selection.get("selectedProfile") == 3,
            "R3 reference selection is not P3")
    expected_ids = {identity_key(stem) for stem in PILOTS}
    rows = {row["identity"]: row for row in results.get("stems", [])}
    require(set(rows) == expected_ids and len(rows) == len(PILOTS),
            "R3 reference pilot identities differ")
    require(Path(freeze.get("helper", {}).get("path", "")).resolve() == r3_helper and
            freeze.get("helper", {}).get("sha256") == sha(r3_helper),
            "R3 reference helper differs from its freeze")
    require(freeze.get("nativeSha256") == sha(HERE / "iterations" / "round-03" / "native" / "round3.c") and
            freeze.get("runnerSha256") == sha(HERE / "iterations" / "round-03" / "round3.py"),
            "R3 reference source changed")
    receipt = read_json(r3_work / "root-verification.json")
    require(receipt.get("format") == "issue77-round3-root-audit-v1" and
            receipt.get("allChecksPassed") is True and receipt.get("artifactCount") == 40 and
            receipt.get("freezeSha256") == sha(freeze_path),
            "R3 root audit is not the verified 40-file receipt")
    return freeze, results, rows


def artifact_info(path: Path) -> dict:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha(path)}


def validate_inputs(args: argparse.Namespace) -> dict:
    r4_freeze, r4_results, selection, r4_rows = validate_r4_pilot(
        args.pilot_work, args.selected_profile)
    require(Path(r4_freeze["helper"]["path"]).resolve() == args.helper,
            "timing R4 helper differs from frozen pilot helper")
    r4_full_freeze, r4_full_results = validate_r4_full(
        args.full_work, args.selected_profile, args.pilot_work, r4_results, selection)
    r4_san_freeze, r4_san_results = validate_r4_sanitized(
        args.sanitized_work, args.selected_profile)
    r3_freeze, r3_results, r3_rows = validate_r3_reference(args.round3_work,
                                                            args.round3_helper)
    require(Path(r4_full_freeze["helper"]["path"]).resolve() == args.helper,
            "timing R4 helper differs from frozen full helper")
    r4_native = HERE / "iterations" / "round-04" / "native" / "round4.c"
    r4_runner = HERE / "iterations" / "round-04" / "round4.py"
    r3_native = HERE / "iterations" / "round-03" / "native" / "round3.c"
    r3_runner = HERE / "iterations" / "round-03" / "round3.py"
    r2_native = HERE / "iterations" / "round-02" / "native" / "round2.c"
    r2_runner = HERE / "iterations" / "round-02" / "round2.py"
    r1_native = HERE / "iterations" / "round-01" / "native" / "round1.c"
    manifests: dict[str, dict] = {}
    artifacts: dict[str, dict] = {}
    pilot_rows = {row["identity"]: row for row in r4_results["stems"]}
    r3_pilot_rows = {row["identity"]: row for row in r3_results["stems"]}
    require(set(pilot_rows) == set(r3_pilot_rows), "R3 and R4 pilot identities differ")
    for stem in PILOTS:
        identity = identity_key(stem)
        manifest = HERE / "manifests" / f"{stem}.json"
        require(manifest.is_file(), f"missing pilot manifest: {manifest}")
        manifest_value = read_json(manifest)
        require(manifest_value.get("channels") == 2 and manifest_value.get("bitDepth") == 24 and
                isinstance(manifest_value.get("chunks"), list) and manifest_value["chunks"],
                f"invalid pilot manifest: {manifest}")
        manifests[stem] = artifact_info(manifest)
        r4_row = pilot_rows[identity]
        r3_row = r3_pilot_rows[identity]
        require(r4_row["activePcmBytes"] == r3_row["activePcmBytes"] and
                r4_row["packedPcmSha256"] == r3_row["packedPcmSha256"],
                f"R3 and R4 expected PCM differ for {stem}")
        artifacts[stem] = {}
        for mode, profile, entropy in (("p0-rice", 0, "rice"),
                                       ("p0-rans", 0, "rans"),
                                       (f"p{args.selected_profile}-rice", args.selected_profile, "rice"),
                                       (f"p{args.selected_profile}-rans", args.selected_profile, "rans")):
            path = args.pilot_work / "pilot" / stem / f"{mode}.xch"
            require(path.is_file(), f"missing R4 pilot artifact: {path}")
            expected = r4_row["profiles"][str(profile)][entropy]
            info = artifact_info(path)
            require(info["bytes"] == expected["outputBytes"] and
                    info["sha256"] == expected["outputSha256"],
                    f"R4 pilot artifact differs from pilot result: {path}")
            artifacts[stem][mode] = info
        r3_path = args.round3_work / "pilot" / stem / "p3-rans.fir"
        require(r3_path.is_file(), f"missing R3 P3 rANS artifact: {r3_path}")
        expected_r3 = r3_row["profiles"]["3"]["rans"]
        info = artifact_info(r3_path)
        require(info["bytes"] == expected_r3["outputBytes"] and
                info["sha256"] == expected_r3["outputSha256"],
                f"R3 P3 rANS artifact differs from pilot result: {r3_path}")
        artifacts[stem]["r3-p3-rans"] = info
    dependencies = {
        "scope": artifact_info(HERE / "iterations" / "round-04-scope.md"),
        "timing": artifact_info(Path(__file__)),
        "round4Native": artifact_info(r4_native),
        "round4Runner": artifact_info(r4_runner),
        "round4Helper": artifact_info(args.helper),
        "round4PilotFreeze": artifact_info(args.pilot_work / "freeze.json"),
        "round4PilotResults": artifact_info(args.pilot_work / "pilot-results.json"),
        "round4Selection": artifact_info(args.pilot_work / "selection.json"),
        "round4PilotRoot": artifact_info(args.pilot_work / "root-verification.json"),
        "round4SanitizedFreeze": artifact_info(args.sanitized_work / "freeze.json"),
        "round4SanitizedResults": artifact_info(args.sanitized_work / "results.json"),
        "round4SanitizedRoot": artifact_info(args.sanitized_work / "root-verification.json"),
        "round4SanitizedHelper": artifact_info(Path(r4_san_freeze["helper"]["path"])),
        "round4FullFreeze": artifact_info(args.full_work / "freeze.json"),
        "round4FullResults": artifact_info(args.full_work / "results.json"),
        "round4FullRoot": artifact_info(args.full_work / "root-verification.json"),
        "round3Native": artifact_info(r3_native),
        "round3Runner": artifact_info(r3_runner),
        "round3Helper": artifact_info(args.round3_helper),
        "round3PilotFreeze": artifact_info(args.round3_work / "freeze.json"),
        "round3PilotResults": artifact_info(args.round3_work / "pilot-results.json"),
        "round3Selection": artifact_info(args.round3_work / "selection.json"),
        "round3PilotRoot": artifact_info(args.round3_work / "root-verification.json"),
        "round2Native": artifact_info(r2_native),
        "round2Runner": artifact_info(r2_runner),
        "round1Native": artifact_info(r1_native),
        "libFLAC": artifact_info(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")),
    }
    return {"r4Freeze": r4_freeze, "r4Results": r4_results, "selection": selection,
            "r4Rows": r4_rows, "r4FullFreeze": r4_full_freeze,
            "r4FullResults": r4_full_results, "r4SanitizedFreeze": r4_san_freeze,
            "r4SanitizedResults": r4_san_results, "r3Freeze": r3_freeze,
            "r3Results": r3_results, "r3Rows": r3_rows, "manifests": manifests,
            "artifacts": artifacts, "dependencies": dependencies}


def freeze_config(args: argparse.Namespace, validated: dict) -> dict:
    return {
        "format": "issue77-round4-timing-freeze-v1",
        "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timingSha256": sha(Path(__file__)),
        "helper": artifact_info(args.helper),
        "round3Helper": artifact_info(args.round3_helper),
        "pilotWork": str(args.pilot_work),
        "sanitizedWork": str(args.sanitized_work),
        "fullWork": str(args.full_work),
        "round3Work": str(args.round3_work),
        "pilotFreezeSha256": sha(args.pilot_work / "freeze.json"),
        "pilotResultsSha256": sha(args.pilot_work / "pilot-results.json"),
        "pilotSelectionSha256": sha(args.pilot_work / "selection.json"),
        "sanitizedFreezeSha256": sha(args.sanitized_work / "freeze.json"),
        "sanitizedResultsSha256": sha(args.sanitized_work / "results.json"),
        "fullFreezeSha256": sha(args.full_work / "freeze.json"),
        "fullResultsSha256": sha(args.full_work / "results.json"),
        "round3FreezeSha256": sha(args.round3_work / "freeze.json"),
        "round3ResultsSha256": sha(args.round3_work / "pilot-results.json"),
        "round3SelectionSha256": sha(args.round3_work / "selection.json"),
        "selectedProfile": args.selected_profile,
        "pilots": list(PILOTS),
        "trialCount": TRIAL_COUNT,
        "stemSeed": STEM_SEED,
        "modeSeed": MODE_SEED,
        "modes": list(selected_modes(args.selected_profile)),
        "manifests": validated["manifests"],
        "compressedArtifacts": validated["artifacts"],
        "dependencies": validated["dependencies"],
        "pilotResultFormat": validated["r4Results"]["format"],
        "pilotSelectionFormat": validated["selection"]["format"],
        "round3ResultFormat": validated["r3Results"]["format"],
        "auditArguments": {"round4": ["-", "-"], "round3": ["-", "-"]},
        "hashVerificationInsideTimedInterval": False,
        "pcmWriteInsideTimedInterval": True,
        "rssScope": "child process maximum RSS from /usr/bin/time, KiB",
        "warmCompressedInputOutsideTimedInterval": True,
        "auditSerializationInsideTimedInterval": False,
        "fullRunVerifiedBeforeTiming": True,
        "sanitizedPilotVerifiedBeforeTiming": True,
    }


def verify_frozen_file(info: dict, label: str) -> None:
    require(isinstance(info, dict) and isinstance(info.get("path"), str),
            f"malformed frozen file entry: {label}")
    path = Path(info["path"])
    actual = artifact_info(path)
    require(actual == info, f"frozen file changed after timing: {label}")


def verify_frozen_inputs(freeze_path: Path, expected_freeze_sha: str, freeze: dict) -> None:
    require(sha(freeze_path) == expected_freeze_sha,
            "timing freeze changed during trials")
    require(freeze.get("timingSha256") == sha(Path(__file__)),
            "timing source changed after timing freeze")
    verify_frozen_file(freeze["helper"], "round4 helper")
    verify_frozen_file(freeze["round3Helper"], "round3 helper")
    for label, info in freeze["dependencies"].items():
        verify_frozen_file(info, f"dependency {label}")
    for stem, info in freeze["manifests"].items():
        verify_frozen_file(info, f"manifest {stem}")
    for stem, modes in freeze["compressedArtifacts"].items():
        for mode, info in modes.items():
            verify_frozen_file(info, f"compressed artifact {stem}/{mode}")


def validate_decode_summary(summary: dict, mode: str, compressed: Path,
                            expected_row: dict, expected_records: int) -> None:
    if mode == "r3-p3-rans":
        require(summary.get("format") == "issue77-round3-summary-v1" and
                summary.get("mode") == 1 and summary.get("predictorProfile") == 3,
                f"bad R3 P3 decode summary: {compressed}")
    else:
        profile_text, entropy = mode.split("-", 1)
        require(summary.get("format") == "issue77-round4-summary-v1" and
                summary.get("mode") == (1 if entropy == "rans" else 0) and
                summary.get("predictorProfile") == int(profile_text[1:]),
                f"bad round-4 decode summary: {compressed}")
    require(summary.get("recordCount") == expected_records and
            summary.get("frameCount") == expected_records and
            summary.get("inputRecordCount") == expected_records,
            f"decode record count mismatch: {compressed}")
    require(summary.get("fileBytes") == compressed.stat().st_size,
            f"decode summary file size mismatch: {compressed}")
    require(summary.get("auditBytes") == 0 and summary.get("originalAuditBytes") == 0,
            f"audit output was enabled: {compressed}")
    require(expected_row["activePcmBytes"] > 0, f"invalid expected PCM length: {compressed}")


def expected_pcm(row: dict) -> tuple[int, str, str]:
    return row["activePcmBytes"], row["packedPcmSha256"], row["identity"]


def verify_pcm(output: Path, expected_row: dict, manifest: Path) -> None:
    require(output.stat().st_size == expected_row["activePcmBytes"] and
            sha(output) == expected_row["packedPcmSha256"],
            f"PCM byte/SHA mismatch: {output}")
    # The canonical digest and chunk digests are already independently pinned by
    # the pilot receipts; the timing check repeats the same local verifier used
    # by the frozen runner so a successful decode cannot hide a wrong gap.
    r2_path = HERE / "iterations" / "round-02" / "round2.py"
    import importlib.util
    spec = importlib.util.spec_from_file_location("round2_timing_readonly", r2_path)
    require(spec is not None and spec.loader is not None, "cannot load frozen PCM verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    manifest_value = read_json(manifest)
    require(module.canonical_hash(output, manifest_value) == expected_row["identity"].split(":", 1)[1],
            f"canonical PCM digest mismatch: {output}")
    expected_chunks = [chunk["pcmSha256"] for chunk in manifest_value["chunks"]]
    require(module.chunk_hashes(output, manifest_value) == expected_chunks,
            f"canonical PCM chunk digest mismatch: {output}")


def run_trials(args: argparse.Namespace, freeze_path: Path, validated: dict) -> dict:
    r4_rows = {row["identity"].split(":", 1)[1]: row for row in validated["r4Results"]["stems"]}
    r3_rows = {row["identity"].split(":", 1)[1]: row for row in validated["r3Results"]["stems"]}
    modes = selected_modes(args.selected_profile)
    trials = []
    for trial_index in range(TRIAL_COUNT):
        stem_order = list(PILOTS)
        random.Random(STEM_SEED + trial_index).shuffle(stem_order)
        mode_order = list(modes)
        random.Random(MODE_SEED + trial_index).shuffle(mode_order)
        trial_root = args.work / f"trial-{trial_index + 1}"
        trial_root.mkdir(parents=True, exist_ok=True)
        mode_results = {}
        for mode in mode_order:
            mode_root = trial_root / mode
            mode_root.mkdir(parents=True, exist_ok=True)
            stem_results = []
            for stem in stem_order:
                compressed = validated["artifacts"][stem][mode]["path"]
                compressed_path = Path(compressed)
                warm(compressed_path)
                output = mode_root / f"{stem}.raw"
                summary_path = mode_root / f"{stem}.summary.json"
                receipt = mode_root / stem
                if mode == "r3-p3-rans":
                    helper = args.round3_helper
                    command = [str(helper), "decode", str(compressed_path), str(output), "-", "-",
                               str(summary_path)]
                    expected_row = r3_rows[stem]
                    expected_records = expected_row["profiles"]["3"]["rans"]["encodeSummary"]["recordCount"]
                else:
                    helper = args.helper
                    command = [str(helper), "decode", str(compressed_path), str(output), "-", "-",
                               str(summary_path)]
                    expected_row = r4_rows[stem]
                    profile_text, entropy = mode.split("-", 1)
                    expected_records = expected_row["profiles"][profile_text[1:]][entropy]["encodeSummary"]["recordCount"]
                measurement = timed_decode(command, output, receipt)
                summary = read_json(summary_path)
                validate_decode_summary(summary, mode, compressed_path, expected_row, expected_records)
                verify_pcm(output, expected_row, args.manifests[stem])
                expected_identity = expected_row["identity"]
                expected_sha = expected_row["packedPcmSha256"]
                summary_fields = {key: summary[key] for key in
                                  ("recordCount", "frameCount", "fileBytes", "auditBytes")}
                if "originalAuditBytes" in summary:
                    summary_fields["originalAuditBytes"] = summary["originalAuditBytes"]
                stem_results.append({
                    "identity": expected_identity,
                    "bytes": output.stat().st_size,
                    "sha256": expected_sha,
                    "measurement": measurement,
                    "summary": summary_fields,
                })
                output.unlink()
            mode_results[mode] = {
                "order": list(stem_order),
                "stems": stem_results,
                "wallSeconds": sum(item["measurement"]["wallSeconds"] for item in stem_results),
                "userSeconds": sum(item["measurement"]["userSeconds"] for item in stem_results),
                "systemSeconds": sum(item["measurement"]["systemSeconds"] for item in stem_results),
                "peakRssKiB": max(item["measurement"]["peakRssKiB"] for item in stem_results),
            }
        trials.append({
            "trial": trial_index + 1,
            "stemOrder": stem_order,
            "modeOrder": mode_order,
            "modes": mode_results,
            "hashVerificationInsideTimedInterval": False,
        })
        print(json.dumps({"trial": trial_index + 1,
                          "seconds": {mode: mode_results[mode]["wallSeconds"] for mode in modes}},
                         sort_keys=True), flush=True)
    return {
        "format": "issue77-round4-timing-v1",
        "timingFreezeSha256": sha(freeze_path),
        "trials": trials,
        "selectedProfile": args.selected_profile,
        "modes": list(modes),
        "pilotWork": str(args.pilot_work),
        "fullWork": str(args.full_work),
        "sanitizedWork": str(args.sanitized_work),
        "round3Work": str(args.round3_work),
        "helper": str(args.helper),
        "round3Helper": str(args.round3_helper),
        "warmCompressedInputOutsideTimedInterval": True,
        "auditDisabledForRound4": True,
        "auditDisabledForRound3": True,
        "auditArguments": {"round4": ["-", "-"], "round3": ["-", "-"]},
        "hashVerificationInsideTimedInterval": False,
        "pcmWriteInsideTimedInterval": True,
        "auditSerializationInsideTimedInterval": False,
        "rssScope": "child process maximum RSS from /usr/bin/time, KiB",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--pilot-work", type=Path, required=True)
    parser.add_argument("--sanitized-work", type=Path, default=DEFAULT_SANITIZED_WORK)
    parser.add_argument("--full-work", type=Path, required=True)
    parser.add_argument("--round3-work", type=Path, default=DEFAULT_R3_WORK)
    parser.add_argument("--selected-profile", type=int, required=True, choices=(1, 2))
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--round3-helper", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=TRIAL_COUNT)
    args = parser.parse_args()
    require(args.trials == TRIAL_COUNT, "scope freezes exactly three serial timing trials")
    args.work = args.work.resolve()
    args.pilot_work = args.pilot_work.resolve()
    args.sanitized_work = args.sanitized_work.resolve()
    args.full_work = args.full_work.resolve()
    args.round3_work = args.round3_work.resolve()
    args.helper = args.helper.resolve()
    args.round3_helper = args.round3_helper.resolve()
    require(args.helper.is_file() and args.round3_helper.is_file(), "timing helper is missing")
    args.work.mkdir(parents=True, exist_ok=True)
    require(not any(args.work.iterdir()), "timing work directory must be empty before freeze")
    validated = validate_inputs(args)
    args.manifests = {stem: HERE / "manifests" / f"{stem}.json" for stem in PILOTS}
    freeze = freeze_config(args, validated)
    freeze_path = args.work / "timing-freeze.json"
    freeze_path.write_text(json.dumps(freeze, indent=2) + "\n")
    frozen_sha = sha(freeze_path)
    result = run_trials(args, freeze_path, validated)
    verify_frozen_inputs(freeze_path, frozen_sha, freeze)
    (args.work / "timing.json").write_text(json.dumps(result, indent=2) + "\n")
    require(read_json(args.work / "timing.json").get("timingFreezeSha256") == sha(freeze_path),
            "timing result does not authenticate its freeze")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"round4 timing: FAIL: {error}", flush=True)
        raise SystemExit(1)
