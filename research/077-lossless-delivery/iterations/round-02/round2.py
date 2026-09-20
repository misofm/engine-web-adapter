#!/usr/bin/env python3
"""Issue #77 round 2 matched Rice/context-rANS runner.

The runner is deliberately issue-specific. It verifies the frozen round-1
records and manifests, invokes the native helper for each complete stem/mode,
and writes generated artifacts only beneath the requested scratch directory.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import time


HERE = Path(__file__).resolve().parents[2]
DEFAULT_RECORDS = Path("/data/issue-77-lossless/iterations/round-01/full-run3/full")
COPY_BYTES = 1024 * 1024
ZERO = bytes(COPY_BYTES)
RSD_MAGIC = b"I77RSD01"
ENT_MAGIC = b"I77ENT02"
MODES = ("rice", "rans")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            block = source.read(COPY_BYTES)
            if not block:
                return digest.hexdigest()
            digest.update(block)


def check_file(path: Path, size: int, digest: str) -> None:
    require(path.is_file(), f"missing {path}")
    require(path.stat().st_size == size, f"wrong size {path}")
    require(sha(path) == digest, f"wrong hash {path}")


def read_u64(data: bytes, offset: int) -> int:
    require(offset + 8 <= len(data), "truncated u64")
    return int.from_bytes(data[offset:offset + 8], "little")


def validate_manifest(manifest: dict, row: dict) -> int:
    require(manifest["format"] == "miso_sparse_stem_v1", "wrong manifest format")
    require(manifest["identity"] == row["identity"], "manifest identity mismatch")
    require(manifest["sampleRateHz"] == 44100 and manifest["channels"] == 2 and
            manifest["bitDepth"] == 24 and manifest["frames"] == row["shape"]["frames"],
            "round 2 accepts only frozen stereo s24le 44.1 kHz shape")
    packed = 0
    end = 0
    for interval in manifest["intervals"]:
        start, frames = interval["startFrame"], interval["frames"]
        require(start >= end and frames > 0 and start + frames <= manifest["frames"],
                "invalid sparse interval")
        require(interval["packedFrameOffset"] == packed, "noncontiguous sparse map")
        packed += frames
        end = start + frames
    frame_cursor = byte_cursor = 0
    for chunk in manifest["chunks"]:
        require(chunk["packedStartFrame"] == frame_cursor and chunk["offset"] == byte_cursor and
                chunk["frames"] > 0 and chunk["bytes"] > 0, "invalid chunk map")
        frame_cursor += chunk["frames"]
        byte_cursor += chunk["bytes"]
    require(frame_cursor == packed, "chunk/interval frame mismatch")
    return packed


def read_rsd_header(path: Path, expected_manifest: bytes) -> tuple[bytes, int]:
    with path.open("rb") as source:
        require(source.read(8) == RSD_MAGIC, f"bad RSD magic {path}")
        length_data = source.read(8)
        count_data = source.read(8)
        require(len(length_data) == 8 and len(count_data) == 8, "truncated RSD header")
        manifest_length = int.from_bytes(length_data, "little")
        record_count = int.from_bytes(count_data, "little")
        require(manifest_length <= 1024 * 1024, "RSD manifest exceeds round-2 bound")
        embedded = source.read(manifest_length)
        require(embedded == expected_manifest, "RSD manifest differs from frozen manifest")
        return embedded, record_count


def read_entropy_header(path: Path, expected_manifest: bytes, expected_mode: int,
                        expected_records: int) -> dict:
    with path.open("rb") as source:
        header = source.read(32)
        require(len(header) == 32 and header[:8] == ENT_MAGIC, f"bad entropy header {path}")
        mode = header[8]
        profile = header[9]
        flags = int.from_bytes(header[10:12], "little")
        manifest_length = int.from_bytes(header[12:20], "little")
        record_count = int.from_bytes(header[20:28], "little")
        table_count = int.from_bytes(header[28:32], "little")
        require(mode == expected_mode and profile == 1 and flags == 0 and
                manifest_length <= 1024 * 1024 and record_count == expected_records and
                table_count <= 4 * 31 * 5 and (mode != 0 or table_count == 0),
                "invalid entropy header fields")
        embedded = source.read(manifest_length)
        require(len(embedded) == manifest_length and embedded == expected_manifest,
                "entropy manifest differs from frozen manifest")
        previous_key = None
        for _ in range(table_count):
            table_header = source.read(3)
            require(len(table_header) == 3, "truncated entropy table key")
            key = tuple(table_header)
            require(key[0] < 4 and key[1] < 31 and key[2] < 5 and
                    (previous_key is None or key > previous_key),
                    "entropy table keys are not strictly ordered")
            previous_key = key
            frequencies = source.read(34)
            require(len(frequencies) == 34 and
                    sum(int.from_bytes(frequencies[index:index + 2], "little")
                        for index in range(0, 34, 2)) == 4096,
                    "entropy table frequency total mismatch")
        table_bytes = table_count * 37
        return {"mode": mode, "manifest": embedded, "manifestBytes": manifest_length,
                "recordCount": record_count, "tableCount": table_count,
                "tableBytes": table_bytes, "headerBytes": 32,
                "dataOffset": 32 + manifest_length + table_bytes}


def validate_rsd_layout(path: Path, manifest: dict, expected_count: int) -> None:
    with path.open("rb") as source:
        header = source.read(24)
        require(len(header) == 24 and header[:8] == RSD_MAGIC, "bad RSD header")
        manifest_length = int.from_bytes(header[8:16], "little")
        source.seek(24 + manifest_length)
        packed = 0
        current_chunk = 0
        seen = [0] * len(manifest["chunks"])
        previous_offset: int | None = None
        for record_index in range(expected_count):
            length_data = source.read(4)
            require(len(length_data) == 4, "truncated RSD record length")
            body_bytes = int.from_bytes(length_data, "little")
            require(0 < body_bytes <= 1024 * 1024, "RSD record exceeds bound")
            body = source.read(body_bytes)
            require(len(body) == body_bytes and body_bytes >= 32, "truncated RSD record")
            chunk = int.from_bytes(body[0:4], "little")
            packed_start = int.from_bytes(body[4:12], "little")
            source_offset = int.from_bytes(body[12:20], "little")
            blocksize = int.from_bytes(body[24:28], "little")
            assignment, channels, bps, reserved = body[28:32]
            require(chunk < len(seen) and blocksize > 0 and channels == 2 and bps == 24 and
                    assignment <= 3 and reserved == 0, "invalid RSD frame envelope")
            require(chunk == current_chunk or chunk == current_chunk + 1,
                    "RSD chunk ordering mismatch")
            if chunk != current_chunk:
                require(seen[current_chunk] == manifest["chunks"][current_chunk]["frames"],
                        "RSD chunk frame count mismatch")
                current_chunk = chunk
                previous_offset = None
            require(packed_start == packed, "RSD packed-frame sequence mismatch")
            if record_index == 0:
                require(chunk == 0 and packed_start == 0, "RSD does not start at chunk zero")
            if previous_offset is not None:
                require(source_offset > previous_offset, "RSD source offsets are not increasing")
            previous_offset = source_offset
            packed += blocksize
            seen[chunk] += blocksize
        require(seen == [chunk["frames"] for chunk in manifest["chunks"]],
                "RSD chunk coverage mismatch")
        require(source.read(1) == b"", "RSD trailing bytes")


def canonical_hash(active: Path, manifest: dict) -> str:
    digest = hashlib.sha256()
    end = 0
    with active.open("rb") as source:
        for interval in manifest["intervals"]:
            start, frames = interval["startFrame"], interval["frames"]
            zeros = (start - end) * 6
            while zeros:
                amount = min(COPY_BYTES, zeros)
                digest.update(ZERO[:amount])
                zeros -= amount
            remaining = frames * 6
            while remaining:
                block = source.read(min(COPY_BYTES, remaining))
                require(block, "truncated reconstructed active PCM")
                digest.update(block)
                remaining -= len(block)
            end = start + frames
        zeros = (manifest["frames"] - end) * 6
        while zeros:
            amount = min(COPY_BYTES, zeros)
            digest.update(ZERO[:amount])
            zeros -= amount
        require(not source.read(1), "trailing reconstructed active PCM")
    return digest.hexdigest()


def chunk_hashes(active: Path, manifest: dict) -> list[str]:
    result = []
    with active.open("rb") as source:
        for chunk in manifest["chunks"]:
            remaining = chunk["frames"] * 6
            digest = hashlib.sha256()
            while remaining:
                block = source.read(min(COPY_BYTES, remaining))
                require(block, "truncated chunk PCM")
                digest.update(block)
                remaining -= len(block)
            result.append(digest.hexdigest())
        require(not source.read(1), "trailing active PCM after chunks")
    return result


def run_timed(command: list[str], receipt: Path) -> dict:
    started = time.perf_counter()
    receipt.parent.mkdir(parents=True, exist_ok=True)
    time_file = receipt.with_suffix(".time")
    stderr_file = receipt.with_suffix(".stderr")
    with stderr_file.open("wb") as stderr:
        result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(time_file), *command],
                                stdout=subprocess.DEVNULL, stderr=stderr, check=False)
    require(result.returncode == 0, f"helper failed: {' '.join(command)}")
    values = time_file.read_text().split()
    require(len(values) == 3, "bad GNU time receipt")
    return {"wallSeconds": time.perf_counter() - started,
            "userSeconds": float(values[0]), "systemSeconds": float(values[1]),
            "peakRssKiB": int(values[2])}


def parse_summary(path: Path) -> dict:
    value = json.loads(path.read_text())
    require(value["format"] == "issue77-round2-summary-v1", "bad native summary")
    return value


def process_stem(row: dict, args: argparse.Namespace, expected_rsd: dict, root: Path) -> dict:
    identity = row["identity"].split(":", 1)[1]
    rsd = args.records_root / identity / "stem.rsd"
    expected = expected_rsd[row["identity"]]
    check_file(rsd, expected["recordBytes"], expected["recordSha256"])
    manifest_path = HERE / row["manifestPath"]
    manifest_bytes = manifest_path.read_bytes()
    require(hashlib.sha256(manifest_bytes).hexdigest() == row["manifestSha256"],
            "frozen manifest changed")
    manifest = json.loads(manifest_bytes)
    active_frames = validate_manifest(manifest, row)
    embedded, record_count = read_rsd_header(rsd, manifest_bytes)
    require(json.loads(embedded) == manifest, "embedded manifest JSON changed")
    require(record_count == expected["recordCount"], "RSD record count differs from root receipt")
    validate_rsd_layout(rsd, manifest, record_count)
    source_root = args.corpus / identity
    baseline = args.baseline[row["identity"]]
    check_file(source_root / "active.raw", row["activePcmBytes"], baseline["packedPcmSha256"])
    stem_work = root / identity
    stem_work.mkdir(parents=True, exist_ok=True)
    modes = {}
    for mode_index, mode in enumerate(MODES):
        output = stem_work / f"{mode}.ent"
        encode_audit = stem_work / f"{mode}.encode.audit"
        encode_summary = stem_work / f"{mode}.encode.json"
        decoded = stem_work / f"{mode}.raw"
        decode_audit = stem_work / f"{mode}.decode.audit"
        decode_summary = stem_work / f"{mode}.decode.json"
        encode_metrics = run_timed([str(args.helper), "encode", str(rsd), str(output),
                                    str(encode_audit), str(encode_summary), str(mode_index)],
                                   stem_work / f"{mode}.encode.receipt")
        encode_info = parse_summary(encode_summary)
        entropy_header = read_entropy_header(output, manifest_bytes, mode_index, record_count)
        encoded_manifest = json.loads(entropy_header["manifest"])
        require(encoded_manifest == manifest, f"{mode} embedded manifest JSON changed")
        require(encode_info["mode"] == mode_index and
                encode_info["recordCount"] == record_count and
                encode_info["frameCount"] == record_count and
                encode_info["manifestBytes"] == entropy_header["manifestBytes"] and
                encode_info["tableCount"] == entropy_header["tableCount"] and
                encode_info["tableBytes"] == entropy_header["tableBytes"],
                f"{mode} header/summary mismatch")
        require(encode_info["frameBytes"] ==
                8 * encode_info["frameCount"] + encode_info["sideBytes"] +
                8 * encode_info["predictiveSubframes"] + encode_info["entropyBytes"] +
                encode_info["bypassBytes"], f"{mode} frame accounting mismatch")
        require(encode_info["fileBytes"] ==
                32 + encode_info["manifestBytes"] + encode_info["tableBytes"] +
                encode_info["frameBytes"] and output.stat().st_size == encode_info["fileBytes"],
                f"{mode} file accounting mismatch")
        decode_metrics = run_timed([str(args.helper), "decode", str(output), str(decoded),
                                    str(decode_audit), str(decode_summary)],
                                   stem_work / f"{mode}.decode.receipt")
        decode_info = parse_summary(decode_summary)
        check_file(decoded, row["activePcmBytes"], baseline["packedPcmSha256"])
        require(canonical_hash(decoded, encoded_manifest) == identity, f"{mode} canonical hash mismatch")
        require(chunk_hashes(decoded, encoded_manifest) == [chunk["pcmSha256"] for chunk in baseline["chunks"]],
                f"{mode} chunk PCM transcript mismatch")
        require(sha(encode_audit) == sha(decode_audit), f"{mode} logical transcript mismatch")
        require(encode_info["recordCount"] == record_count and encode_info["frameCount"] == record_count and
                decode_info["recordCount"] == record_count and decode_info["frameCount"] == record_count,
                f"{mode} frame count mismatch")
        require(encode_info["fileBytes"] == output.stat().st_size, f"{mode} output size receipt mismatch")
        for field in ("predictiveSubframes", "manifestBytes", "tableCount", "tableBytes", "sideBytes",
                      "entropyBytes", "bypassBytes", "frameBytes"):
            require(decode_info[field] == encode_info[field], f"{mode} decode accounting mismatch: {field}")
        require(decode_info["fileBytes"] == output.stat().st_size,
                f"{mode} decode input size receipt mismatch")
        modes[mode] = {
            "mode": mode, "outputBytes": output.stat().st_size, "outputSha256": sha(output),
            "auditSha256": sha(encode_audit), "auditBytes": encode_audit.stat().st_size,
            "recordCount": record_count, "frameCount": record_count,
            "encodeSummary": encode_info, "decodeSummary": decode_info,
            "encode": encode_metrics, "decode": decode_metrics,
        }
    return {
        "identity": row["identity"], "recordingRef": row["recordingRef"], "sourceIDs": row["sourceIDs"],
        "activeFrames": active_frames, "activePcmBytes": row["activePcmBytes"],
        "canonicalPcmSha256": identity, "packedPcmSha256": baseline["packedPcmSha256"],
        "rsdBytes": expected["recordBytes"], "rsdSha256": expected["recordSha256"],
        "manifestBytes": len(manifest_bytes), "modes": modes,
    }


def freeze_config(args: argparse.Namespace, catalog: dict, expected_rsd: dict) -> dict:
    return {
        "format": "issue77-round2-freeze-v1",
        "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scopeSha256": sha(HERE / "iterations" / "round-02-scope.md"),
        "runnerSha256": sha(Path(__file__)),
        "nativeSha256": sha(HERE / "iterations" / "round-02" / "native" / "round2.c"),
        "round1NativeDependencySha256": sha(HERE / "iterations" / "round-01" / "native" / "round1.c"),
        "sourcesSha256": sha(HERE / "sources.json"),
        "baselineEvidenceSha256": sha(HERE / "evidence" / "results.json"),
        "round1EvidenceSha256": sha(HERE / "evidence" / "results.json"),
        "round1VerificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "verification.json"),
        "round1RootVerificationSha256": sha(HERE / "iterations" / "round-01-evidence" / "root-verification.json"),
        "records": expected_rsd,
        "helper": {"path": str(args.helper), "sha256": sha(args.helper)},
        "library": {"path": "/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a",
                    "sha256": sha(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a"))},
        "compiler": "gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow",
        "compilerVersion": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
        "recordsRoot": str(args.records_root), "corpus": str(args.corpus),
        "workerConcurrency": args.workers, "maxFrameBodyBytes": 4 * 1024 * 1024,
        "maxManifestBytes": 1024 * 1024, "maxTables": 4 * 31 * 5,
        "rans": {"scaleBits": 12, "stateLowerBound": 1 << 23, "initialState": 1 << 23,
                 "quotientAlphabet": 17, "tableTotal": 4096, "bypassQBits": 32},
        "modes": {"rice": 0, "rans": 1},
        "commands": {"encode": "helper encode INPUT_RSD OUTPUT AUDIT SUMMARY MODE",
                     "decode": "helper decode INPUT OUTPUT_RAW AUDIT SUMMARY"},
        "pilotIdentities": args.pilot,
        "platform": platform.platform(),
        "cpu": subprocess.check_output(["lscpu"], text=True),
        "catalogStemCount": len(catalog["stems"]),
    }


def add_mode_totals(rows: list[dict], mode: str) -> dict:
    members = [row["modes"][mode] for row in rows]
    return {
        "mode": mode, "stemCount": len(rows),
        "outputBytes": sum(item["outputBytes"] for item in members),
        "recordCount": sum(item["recordCount"] for item in members),
        "frameCount": sum(item["frameCount"] for item in members),
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
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--records-root", type=Path, default=DEFAULT_RECORDS)
    parser.add_argument("--corpus", type=Path, default=Path("/data/issue-77-lossless/run-02"))
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 5))
    parser.add_argument("--pilot", nargs="*", default=[
        "sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
        "sha256:8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
        "sha256:fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
        "sha256:68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f"])
    parser.add_argument("--pilot-only", action="store_true")
    parser.add_argument("--resume-frozen", action="store_true")
    args = parser.parse_args()
    args.work = args.work.resolve()
    args.helper = args.helper.resolve()
    args.records_root = args.records_root.resolve()
    args.corpus = args.corpus.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((HERE / "sources.json").read_text())
    baseline_evidence = json.loads((HERE / "evidence" / "results.json").read_text())
    root_receipt = json.loads((HERE / "iterations" / "round-01-evidence" / "root-verification.json").read_text())
    verification = json.loads((HERE / "iterations" / "round-01-evidence" / "verification.json").read_text())
    verification_by_identity = {row["identity"]: row for row in verification["stems"]}
    expected_rsd = {item["identity"]: {"recordBytes": item["recordBytes"], "recordSha256": item["recordSha256"],
                                       "recordCount": verification_by_identity[item["identity"]]["recordCount"]}
                    for item in root_receipt["stems"]}
    baseline = {item["identity"]: next(result for result in item["results"] if result["candidate"] == "flac8e-30s")
                for item in baseline_evidence["stems"]}
    args.baseline = baseline
    stems = [row for row in catalog["stems"] if not args.pilot_only or row["identity"] in args.pilot]
    require(len(stems) == (4 if args.pilot_only else 30), "unexpected stem set")
    freeze_path = args.work / "freeze.json"
    if args.resume_frozen:
        frozen = json.loads(freeze_path.read_text())
        require(frozen["scopeSha256"] == sha(HERE / "iterations" / "round-02-scope.md") and
                frozen["runnerSha256"] == sha(Path(__file__)) and
                frozen["nativeSha256"] == sha(HERE / "iterations" / "round-02" / "native" / "round2.c") and
                frozen["round1NativeDependencySha256"] == sha(HERE / "iterations" / "round-01" / "native" / "round1.c") and
                frozen["sourcesSha256"] == sha(HERE / "sources.json") and
                frozen["baselineEvidenceSha256"] == sha(HERE / "evidence" / "results.json") and
                frozen["round1VerificationSha256"] == sha(HERE / "iterations" / "round-01-evidence" / "verification.json") and
                frozen["round1RootVerificationSha256"] == sha(HERE / "iterations" / "round-01-evidence" / "root-verification.json") and
                frozen["catalogStemCount"] == len(catalog["stems"]) and
                frozen["records"] == expected_rsd and frozen["corpus"] == str(args.corpus) and
                frozen["pilotIdentities"] == args.pilot,
                "round2 source changed after freeze")
        require(frozen["helper"]["sha256"] == sha(args.helper) and
                frozen["recordsRoot"] == str(args.records_root) and frozen["workerConcurrency"] == args.workers,
                "round2 helper/input/worker changed after freeze")
    else:
        require(not freeze_path.exists(), "work directory already frozen")
        freeze_path.write_text(json.dumps(freeze_config(args, catalog, expected_rsd), indent=2) + "\n")
    started = time.perf_counter()
    root = args.work / ("pilot" if args.pilot_only else "full")
    root.mkdir(parents=True, exist_ok=True)
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process_stem, row, args, expected_rsd, root) for row in stems]
        for future in futures:
            row = future.result()
            rows.append(row)
            print(f"{row['recordingRef']}/{row['sourceIDs'][0]}: "
                  f"Rice {row['modes']['rice']['outputBytes']:,}, "
                  f"rANS {row['modes']['rans']['outputBytes']:,} bytes; PCM/transcript verified", flush=True)
    rows.sort(key=lambda row: row["identity"])
    mode_totals = {mode: add_mode_totals(rows, mode) for mode in MODES}
    session_rows = []
    for session in sorted({row["recordingRef"] for row in rows}):
        members = [row for row in rows if row["recordingRef"] == session]
        session_rows.append({"recordingRef": session, "stemCount": len(members),
                             "controlBytes": sum(baseline[row["identity"]]["totalBytes"] for row in members),
                             "riceBytes": sum(row["modes"]["rice"]["outputBytes"] for row in members),
                             "ransBytes": sum(row["modes"]["rans"]["outputBytes"] for row in members)})
    stem_rows = []
    for row in rows:
        stem = {"identity": row["identity"], "recordingRef": row["recordingRef"],
                "source": "/".join(row["sourceIDs"]), "controlBytes": baseline[row["identity"]]["totalBytes"],
                "activePcmBytes": row["activePcmBytes"], "rsdBytes": row["rsdBytes"],
                "rsdSha256": row["rsdSha256"], "canonicalPcmSha256": row["canonicalPcmSha256"]}
        for mode in MODES:
            stem[f"{mode}Bytes"] = row["modes"][mode]["outputBytes"]
            stem[f"{mode}Sha256"] = row["modes"][mode]["outputSha256"]
            stem[f"{mode}AuditSha256"] = row["modes"][mode]["auditSha256"]
        stem_rows.append(stem)
    stem_fields = list(stem_rows[0])
    write_csv(args.work / ("pilot-per-stem.csv" if args.pilot_only else "per-stem.csv"), stem_rows, stem_fields)
    write_csv(args.work / ("pilot-per-session.csv" if args.pilot_only else "per-session.csv"),
              session_rows, list(session_rows[0]))
    totals_row = {"stemCount": len(rows), "controlBytes": sum(baseline[row["identity"]]["totalBytes"] for row in rows),
                  "riceBytes": mode_totals["rice"]["outputBytes"], "ransBytes": mode_totals["rans"]["outputBytes"],
                  "riceMinusRansBytes": mode_totals["rice"]["outputBytes"] - mode_totals["rans"]["outputBytes"],
                  "riceMinusControlBytes": mode_totals["rice"]["outputBytes"] -
                  sum(baseline[row["identity"]]["totalBytes"] for row in rows),
                  "ransMinusControlBytes": mode_totals["rans"]["outputBytes"] -
                  sum(baseline[row["identity"]]["totalBytes"] for row in rows)}
    write_csv(args.work / ("pilot-totals.csv" if args.pilot_only else "totals.csv"), [totals_row], list(totals_row))
    result = {"format": "issue77-round2-results-v1", "freezeSha256": sha(freeze_path),
              "pilot": args.pilot_only, "stemCount": len(rows),
              "elapsedSeconds": time.perf_counter() - started,
              "controlBytes": totals_row["controlBytes"], "modeTotals": mode_totals,
              "sessions": session_rows, "stems": rows}
    (args.work / ("pilot-results.json" if args.pilot_only else "results.json")).write_text(
        json.dumps(result, indent=2) + "\n")
    print(json.dumps({"controlBytes": result["controlBytes"],
                      "riceBytes": mode_totals["rice"]["outputBytes"],
                      "ransBytes": mode_totals["rans"]["outputBytes"]}, indent=2))


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
