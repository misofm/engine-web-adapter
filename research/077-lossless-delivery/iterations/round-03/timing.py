#!/usr/bin/env python3
"""Serial, audit-free decode timing for the frozen round-3 pilot.

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
STEM_SEED = 0x77030000
MODE_SEED = 0x7703A000
COPY_BYTES = 1024 * 1024
DEFAULT_ROUND2_WORK = Path("/data/issue-77-lossless/iterations/round-02/final-pilot3")


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
    return ("p0-rice", "p0-rans", f"p{profile}-rice", f"p{profile}-rans", "r2-rans")


def validate_selection(pilot_work: Path, selected_profile: int) -> tuple[dict, dict, dict]:
    freeze_path = pilot_work / "freeze.json"
    results_path = pilot_work / "pilot-results.json"
    selection_path = pilot_work / "selection.json"
    freeze = read_json(freeze_path)
    results = read_json(results_path)
    selection = read_json(selection_path)
    require(freeze.get("format") == "issue77-round3-freeze-v1" and freeze.get("pilot") is True,
            "pilot freeze is not a round-3 pilot freeze")
    require(freeze.get("profiles") == [0, 1, 2, 3, 4], "pilot freeze profile grid changed")
    require(results.get("format") == "issue77-round3-results-v1" and
            results.get("pilot") is True and results.get("stemCount") == len(PILOTS),
            "pilot results are not the scoped round-3 result")
    require(results.get("freezeSha256") == sha(freeze_path),
            "round-3 pilot results do not authenticate their freeze")
    require(selection.get("format") == "issue77-round3-selection-v1",
            "bad round-3 selection receipt")
    expected_ids = [identity_key(stem) for stem in PILOTS]
    require(set(selection.get("pilotIdentities", [])) == set(expected_ids) and
            len(selection.get("pilotIdentities", [])) == len(PILOTS),
            "selection receipt pilot identities differ from the exact four pilots")
    rows = {row["identity"]: row for row in results.get("stems", [])}
    require(set(rows) == set(expected_ids) and len(rows) == len(PILOTS),
            "pilot result identities differ from the exact four pilots")
    require(selection.get("pilotResultsSha256") == sha(results_path),
            "selection receipt pilot-results hash mismatch")
    candidates = selection.get("profiles")
    require(isinstance(candidates, list) and {item.get("profile") for item in candidates} == {1, 2, 3, 4},
            "selection receipt does not contain all enabled profiles")
    for candidate in candidates:
        profile = candidate["profile"]
        expected_bytes = sum(rows[identity]["profiles"][str(profile)]["rans"]["outputBytes"]
                             for identity in expected_ids)
        require(candidate.get("ransBytes") == expected_bytes,
                f"selection rANS bytes disagree with pilot rows for profile {profile}")
    winner = min(candidates, key=lambda item: (item["ransBytes"], item["profile"]))
    require(selection.get("selectedProfile") == winner["profile"] and
            selected_profile == selection.get("selectedProfile"),
            "selected profile differs from the frozen pilot selection")
    require(freeze.get("nativeSha256") == sha(HERE / "iterations" / "round-03" / "native" / "round3.c"),
            "pilot native source changed")
    require(freeze.get("runnerSha256") == sha(HERE / "iterations" / "round-03" / "round3.py"),
            "pilot round-3 runner changed")
    require(freeze.get("helper", {}).get("sha256") == sha(Path(freeze["helper"]["path"])),
            "pilot helper changed")
    return freeze, results, selection


def validate_round2_reference(round2_work: Path, round2_helper: Path) -> tuple[dict, dict, dict]:
    freeze_path = round2_work / "freeze.json"
    results_path = round2_work / "pilot-results.json"
    freeze = read_json(freeze_path)
    results = read_json(results_path)
    require(freeze.get("format") == "issue77-round2-freeze-v1" and
            results.get("format") == "issue77-round2-results-v1" and
            results.get("pilot") is True and results.get("stemCount") == len(PILOTS),
            "round-2 reference is not the frozen four-stem pilot")
    require(results.get("freezeSha256") == sha(freeze_path),
            "round-2 reference results do not authenticate their freeze")
    require(Path(freeze.get("helper", {}).get("path", "")).resolve() == round2_helper,
            "round-2 helper path differs from its reference freeze")
    require(freeze.get("helper", {}).get("sha256") == sha(round2_helper),
            "round-2 helper differs from its reference freeze")
    rows = {row["identity"]: row for row in results.get("stems", [])}
    expected_ids = {identity_key(stem) for stem in PILOTS}
    require(set(rows) == expected_ids and len(rows) == len(PILOTS),
            "round-2 reference pilot identities differ")
    return freeze, results, rows


def artifact_info(path: Path) -> dict:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha(path)}


def validate_inputs(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict]:
    pilot_freeze, pilot_results, selection = validate_selection(args.pilot_work, args.selected_profile)
    require(Path(pilot_freeze.get("helper", {}).get("path", "")).resolve() == args.helper,
            "round-3 helper path differs from its pilot freeze")
    round2_freeze, round2_results, round2_rows = validate_round2_reference(args.round2_work,
                                                                            args.round2_helper)
    r3_native = HERE / "iterations" / "round-03" / "native" / "round3.c"
    r2_native = HERE / "iterations" / "round-02" / "native" / "round2.c"
    r2_runner = HERE / "iterations" / "round-02" / "round2.py"
    r1_native = HERE / "iterations" / "round-01" / "native" / "round1.c"
    manifests = {}
    artifacts = {}
    pilot_rows = {row["identity"]: row for row in pilot_results["stems"]}
    for stem in PILOTS:
        identity = identity_key(stem)
        manifest = HERE / "manifests" / f"{stem}.json"
        require(manifest.is_file(), f"missing pilot manifest: {manifest}")
        manifest_value = read_json(manifest)
        require(manifest_value.get("channels") == 2 and manifest_value.get("bitDepth") == 24 and
                isinstance(manifest_value.get("chunks"), list) and manifest_value["chunks"],
                f"invalid pilot manifest: {manifest}")
        manifests[stem] = artifact_info(manifest)
        r3_root = args.pilot_work / "pilot" / stem
        r2_root = args.round2_work / "pilot" / stem
        row = pilot_rows[identity]
        r2_row = round2_rows[identity]
        require(row["activePcmBytes"] == r2_row["activePcmBytes"] and
                row["packedPcmSha256"] == r2_row["packedPcmSha256"],
                f"round-2 and round-3 expected PCM differ for {stem}")
        artifacts[stem] = {}
        for mode, profile, entropy in (("p0-rice", 0, "rice"),
                                       ("p0-rans", 0, "rans"),
                                       (f"p{args.selected_profile}-rice", args.selected_profile, "rice"),
                                       (f"p{args.selected_profile}-rans", args.selected_profile, "rans")):
            path = r3_root / f"{mode}.fir"
            require(path.is_file(), f"missing round-3 pilot artifact: {path}")
            expected = row["profiles"][str(profile)][entropy]
            info = artifact_info(path)
            require(info["bytes"] == expected["outputBytes"] and info["sha256"] == expected["outputSha256"],
                    f"round-3 pilot artifact differs from pilot result: {path}")
            artifacts[stem][mode] = info
        r2_path = r2_root / "rans.ent"
        require(r2_path.is_file(), f"missing round-2 reference artifact: {r2_path}")
        expected_r2 = r2_row["modes"]["rans"]
        info = artifact_info(r2_path)
        require(info["bytes"] == expected_r2["outputBytes"] and info["sha256"] == expected_r2["outputSha256"],
                f"round-2 reference artifact differs from pilot result: {r2_path}")
        artifacts[stem]["r2-rans"] = info
    dependencies = {
        "scope": artifact_info(HERE / "iterations" / "round-03-scope.md"),
        "timing": artifact_info(Path(__file__)),
        "round3Native": artifact_info(r3_native),
        "round3Helper": artifact_info(args.helper),
        "round2Native": artifact_info(r2_native),
        "round2Runner": artifact_info(r2_runner),
        "round2Helper": artifact_info(args.round2_helper),
        "round1Native": artifact_info(r1_native),
        "libFLAC": artifact_info(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")),
        "round3PilotFreeze": artifact_info(args.pilot_work / "freeze.json"),
        "round3PilotResults": artifact_info(args.pilot_work / "pilot-results.json"),
        "round3Selection": artifact_info(args.pilot_work / "selection.json"),
        "round2ReferenceFreeze": artifact_info(args.round2_work / "freeze.json"),
        "round2ReferenceResults": artifact_info(args.round2_work / "pilot-results.json"),
    }
    return pilot_freeze, pilot_results, selection, round2_freeze, {
        "round2Results": round2_results, "manifests": manifests,
        "artifacts": artifacts, "dependencies": dependencies,
    }


def freeze_config(args: argparse.Namespace, pilot_freeze: dict, pilot_results: dict,
                  selection: dict, round2_freeze: dict, validated: dict) -> dict:
    return {
        "format": "issue77-round3-timing-freeze-v1",
        "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timingSha256": sha(Path(__file__)),
        "helper": artifact_info(args.helper),
        "round2Helper": artifact_info(args.round2_helper),
        "pilotWork": str(args.pilot_work),
        "round2Work": str(args.round2_work),
        "pilotFreezeSha256": sha(args.pilot_work / "freeze.json"),
        "pilotResultsSha256": sha(args.pilot_work / "pilot-results.json"),
        "pilotSelectionSha256": sha(args.pilot_work / "selection.json"),
        "round2FreezeSha256": sha(args.round2_work / "freeze.json"),
        "round2ResultsSha256": sha(args.round2_work / "pilot-results.json"),
        "selectedProfile": args.selected_profile,
        "pilots": list(PILOTS),
        "trialCount": TRIAL_COUNT,
        "stemSeed": STEM_SEED,
        "modeSeed": MODE_SEED,
        "modes": list(selected_modes(args.selected_profile)),
        "manifests": validated["manifests"],
        "compressedArtifacts": validated["artifacts"],
        "dependencies": validated["dependencies"],
        "pilotResultFormat": pilot_results["format"],
        "pilotSelectionFormat": selection["format"],
        "round2FreezeFormat": round2_freeze["format"],
        "auditArguments": {"round3": ["-", "-"], "round2": ["-"]},
        "hashVerificationInsideTimedInterval": False,
        "pcmWriteInsideTimedInterval": True,
        "rssScope": "child process maximum RSS from /usr/bin/time, KiB",
        "warmCompressedInputOutsideTimedInterval": True,
    }


def validate_decode_summary(summary: dict, mode: str, compressed: Path,
                            expected_row: dict, expected_records: int) -> None:
    if mode == "r2-rans":
        require(summary.get("format") == "issue77-round2-summary-v1" and summary.get("mode") == 1,
                f"bad round-2 decode summary: {compressed}")
    else:
        expected_profile = int(mode.split("-", 1)[0][1:])
        require(summary.get("format") == "issue77-round3-summary-v1" and
                summary.get("mode") == (1 if mode.endswith("rans") else 0) and
                summary.get("predictorProfile") == expected_profile,
                f"bad round-3 decode summary: {compressed}")
    require(summary.get("recordCount") == expected_records and
            summary.get("frameCount") == expected_records and
            summary.get("inputRecordCount") == expected_records,
            f"decode record count mismatch: {compressed}")
    require(summary.get("fileBytes") == compressed.stat().st_size,
            f"decode summary file size mismatch: {compressed}")
    require(summary.get("auditBytes") == 0, f"audit output was enabled: {compressed}")
    if mode != "r2-rans":
        require(summary.get("originalAuditBytes") == 0,
                f"round-3 original audit output was enabled: {compressed}")
    require(expected_row["activePcmBytes"] > 0, f"invalid expected PCM length: {compressed}")


def expected_pcm(row: dict) -> tuple[int, str, str]:
    return row["activePcmBytes"], row["packedPcmSha256"], row["identity"]


def run_trials(args: argparse.Namespace, freeze_path: Path, validated: dict,
               pilot_results: dict, round2_results: dict) -> dict:
    pilot_rows = {row["identity"].split(":", 1)[1]: row for row in pilot_results["stems"]}
    round2_rows = {row["identity"].split(":", 1)[1]: row for row in round2_results["stems"]}
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
                if mode == "r2-rans":
                    helper = args.round2_helper
                    command = [str(helper), "decode", str(compressed_path), str(output), "-",
                               str(summary_path)]
                    expected_row = round2_rows[stem]
                    expected_records = expected_row["modes"]["rans"]["encodeSummary"]["recordCount"]
                else:
                    helper = args.helper
                    command = [str(helper), "decode", str(compressed_path), str(output), "-", "-",
                               str(summary_path)]
                    expected_row = pilot_rows[stem]
                    profile_text, entropy = mode.split("-", 1)
                    expected_records = expected_row["profiles"][profile_text[1:]][entropy]["encodeSummary"]["recordCount"]
                measurement = timed_decode(command, output, receipt)
                summary = read_json(summary_path)
                validate_decode_summary(summary, mode, compressed_path, expected_row, expected_records)
                expected_bytes, expected_sha, expected_identity = expected_pcm(expected_row)
                require(output.stat().st_size == expected_bytes and sha(output) == expected_sha,
                        f"PCM verification failed for {mode}/{stem}")
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
        "format": "issue77-round3-timing-v1",
        "timingFreezeSha256": sha(freeze_path),
        "trials": trials,
        "selectedProfile": args.selected_profile,
        "modes": list(modes),
        "pilotWork": str(args.pilot_work),
        "round2Work": str(args.round2_work),
        "helper": str(args.helper),
        "round2Helper": str(args.round2_helper),
        "warmCompressedInputOutsideTimedInterval": True,
        "auditDisabledForRound3": True,
        "auditDisabledForRound2": True,
        "hashVerificationInsideTimedInterval": False,
        "pcmWriteInsideTimedInterval": True,
        "rssScope": "child process maximum RSS from /usr/bin/time, KiB",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--pilot-work", type=Path, required=True)
    parser.add_argument("--selected-profile", type=int, required=True, choices=(1, 2, 3, 4))
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--round2-helper", type=Path, required=True)
    parser.add_argument("--round2-work", type=Path, default=DEFAULT_ROUND2_WORK)
    parser.add_argument("--trials", type=int, default=TRIAL_COUNT)
    args = parser.parse_args()
    require(args.trials == TRIAL_COUNT, "scope freezes exactly three serial timing trials")
    args.work = args.work.resolve()
    args.pilot_work = args.pilot_work.resolve()
    args.helper = args.helper.resolve()
    args.round2_helper = args.round2_helper.resolve()
    args.round2_work = args.round2_work.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    require(not any(args.work.iterdir()), "timing work directory must be empty before freeze")
    pilot_freeze, pilot_results, selection, round2_freeze, validated = validate_inputs(args)
    freeze = freeze_config(args, pilot_freeze, pilot_results, selection, round2_freeze, validated)
    freeze_path = args.work / "timing-freeze.json"
    freeze_path.write_text(json.dumps(freeze, indent=2) + "\n")
    result = run_trials(args, freeze_path, validated, pilot_results, validated["round2Results"])
    (args.work / "timing.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"round3 timing: FAIL: {error}", flush=True)
        raise SystemExit(1)
