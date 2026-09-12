#!/usr/bin/env python3
"""Issue #77 round 1 native extraction, reconstruction, and diagnostics.

The runner is intentionally issue-specific. It consumes only the frozen
catalogue, manifests, evidence, and staged run-02 corpus, and writes all
generated files outside the repository.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import time


HERE = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = Path("/data/issue-77-lossless/run-02")
COPY_BYTES = 1024 * 1024
ZERO = bytes(COPY_BYTES)
LAGS = (1, 2, 4, 8, 16, 32)
STATS_MAGIC = b"I77ST01\x01"
RECORD_MAGIC = b"I77RSD01"


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
    require(path.is_file(), f"missing input {path}")
    require(path.stat().st_size == size, f"wrong byte count {path}")
    require(sha(path) == digest, f"wrong SHA-256 {path}")


def copy_exact(source, target, count: int | None = None) -> None:
    remaining = count
    require(remaining is not None, "copy_exact requires a byte count")
    while remaining:
        want = min(COPY_BYTES, remaining)
        block = source.read(want)
        require(block, "truncated input while copying")
        target.write(block)
        remaining -= len(block)


def canonical_hash(active: Path, manifest: dict) -> str:
    digest = hashlib.sha256()
    end = 0
    with active.open("rb") as source:
        for interval in manifest["intervals"]:
            start, frames = interval["startFrame"], interval["frames"]
            zero_bytes = (start - end) * 6
            while zero_bytes:
                amount = min(COPY_BYTES, zero_bytes)
                digest.update(ZERO[:amount])
                zero_bytes -= amount
            count = frames * 6
            while count:
                block = source.read(min(COPY_BYTES, count))
                require(block, "truncated active PCM")
                digest.update(block)
                count -= len(block)
            end = start + frames
        zero_bytes = (manifest["frames"] - end) * 6
        while zero_bytes:
            amount = min(COPY_BYTES, zero_bytes)
            digest.update(ZERO[:amount])
            zero_bytes -= amount
        require(not source.read(1), "trailing active PCM")
    return digest.hexdigest()


def validate_manifest(manifest: dict, row: dict) -> int:
    require(manifest["format"] == "miso_sparse_stem_v1", "wrong manifest format")
    require(manifest["identity"] == row["identity"], "manifest identity mismatch")
    require(manifest["sampleRateHz"] == 44100 and manifest["channels"] == 2 and manifest["bitDepth"] == 24,
            "round 1 accepts only stereo s24le 44.1 kHz")
    end = packed = 0
    for interval in manifest["intervals"]:
        start, frames = interval["startFrame"], interval["frames"]
        require(start >= end and frames > 0 and start + frames <= manifest["frames"], "bad interval")
        require(interval["packedFrameOffset"] == packed, "noncontiguous active map")
        end, packed = start + frames, packed + frames
    frame_cursor = byte_cursor = 0
    for chunk in manifest["chunks"]:
        require(chunk["packedStartFrame"] == frame_cursor and chunk["offset"] == byte_cursor,
                "noncontiguous chunk map")
        require(chunk["frames"] > 0 and chunk["bytes"] > 0, "empty chunk")
        frame_cursor += chunk["frames"]
        byte_cursor += chunk["bytes"]
    require(frame_cursor == packed, "chunk/interval frame mismatch")
    return packed


def read_embedded_manifest(path: Path, expected: bytes) -> tuple[dict, int]:
    """Read and authenticate the bounded manifest carried by one RSD file."""
    with path.open("rb") as source:
        require(source.read(8) == RECORD_MAGIC, f"bad record magic {path}")
        length_bytes = source.read(8)
        count_bytes = source.read(8)
        require(len(length_bytes) == 8 and len(count_bytes) == 8, "truncated record header")
        manifest_length, record_count = struct.unpack("<QQ", length_bytes + count_bytes)
        require(manifest_length <= 64 * 1024 * 1024, "embedded manifest is too large")
        embedded = source.read(manifest_length)
        require(len(embedded) == manifest_length and embedded == expected,
                "embedded manifest differs from frozen published manifest")
        try:
            manifest = json.loads(embedded)
        except json.JSONDecodeError as error:
            raise ValueError("embedded manifest is not JSON") from error
        return manifest, record_count


def validate_record_layout(path: Path, manifest: dict, expected_count: int) -> None:
    """Validate record ordering before the native decoder consumes the file."""
    with path.open("rb") as source:
        header = source.read(16)
        require(len(header) == 16 and header[:8] == RECORD_MAGIC, "bad record header")
        manifest_length = struct.unpack_from("<Q", header, 8)[0]
        source.seek(24 + manifest_length)
        packed_cursor = 0
        current_chunk = 0
        chunk_frames = [chunk["frames"] for chunk in manifest["chunks"]]
        chunk_seen = [0] * len(chunk_frames)
        previous_offset = None
        for record_index in range(expected_count):
            length_bytes = source.read(4)
            require(len(length_bytes) == 4, "truncated record length")
            (record_bytes,) = struct.unpack("<I", length_bytes)
            require(0 < record_bytes <= 1024 * 1024, "record exceeds bounded size")
            payload = source.read(record_bytes)
            require(len(payload) == record_bytes and record_bytes >= 32, "truncated record payload")
            chunk, packed, offset, frame_bytes, blocksize, assignment, channels, bps, reserved = \
                struct.unpack_from("<IQQII4B", payload)
            require(blocksize > 0 and frame_bytes > 0 and reserved == 0 and
                    channels == 2 and bps == 24 and assignment <= 3,
                    "invalid record envelope")
            require(chunk < len(chunk_frames), "record chunk index out of range")
            require(chunk == current_chunk or chunk == current_chunk + 1,
                    "record chunk order mismatch")
            if chunk != current_chunk:
                require(chunk_seen[current_chunk] == chunk_frames[current_chunk],
                        "record chunk frame count mismatch")
                current_chunk = chunk
                previous_offset = None
            require(packed == packed_cursor, "record packed-frame sequence mismatch")
            if record_index == 0:
                require(chunk == 0 and packed == 0, "merged record does not start at chunk zero")
            if previous_offset is not None:
                require(offset > previous_offset, "record source offsets are not increasing")
            previous_offset = offset
            packed_cursor += blocksize
            chunk_seen[chunk] += blocksize
        require(packed_cursor == sum(chunk_frames), "record PCM frame count mismatch")
        require(chunk_seen == chunk_frames, "record chunk coverage mismatch")
        require(source.read(1) == b"", "record file has trailing bytes")


def run_timed(command: list[str], log: Path, output: Path | None = None) -> dict:
    started = time.perf_counter()
    log.parent.mkdir(parents=True, exist_ok=True)
    stderr_path = log.with_suffix(".stderr")
    stdout = output.open("wb") if output else subprocess.DEVNULL
    stderr = stderr_path.open("wb")
    try:
        result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(log), *command],
                                stdout=stdout, stderr=stderr, check=False)
    finally:
        if output:
            stdout.close()
        stderr.close()
    require(result.returncode == 0, f"native command failed: {' '.join(command)}")
    values = log.read_text().split()
    require(len(values) == 3, f"bad GNU time receipt {log}")
    return {"wallSeconds": time.perf_counter() - started,
            "userSeconds": float(values[0]), "systemSeconds": float(values[1]),
            "peakRssKiB": int(values[2])}


def read_stats(path: Path) -> dict:
    data = path.read_bytes()
    require(data[:8] == STATS_MAGIC, f"bad stats magic {path}")
    offset = 8

    def values(count: int) -> list[int]:
        nonlocal offset
        result = list(struct.unpack_from(f"<{count}Q", data, offset))
        offset += count * 8
        return result

    result = {
        "types": values(4), "orders": values(33), "assignments": values(4),
        "methods": values(2), "ks": values(32),
    }
    scalar_names = ("residualSamples", "ordinarySamples", "escapedPartitions", "escapedSamples",
                    "subframes", "ordinarySubframes", "subframeHeaderBits", "wastedBits",
                    "warmupBits", "coefficientBits", "constantBits", "verbatimBits",
                    "residualHeaderBits", "quotientBits", "remainderBits", "escapedRawBits",
                    "frameHeaderBits", "frameCrcBits", "framePaddingBits", "frameBytes", "frameCount")
    for name, value in zip(scalar_names, values(len(scalar_names))):
        result[name] = value
    result["residualSum"], result["residualSumSq"] = struct.unpack_from("<dd", data, offset)
    offset += 16
    result["lagCounts"] = values(6)
    result["lagCorrSum"] = list(struct.unpack_from("<6d", data, offset))
    offset += 48
    result["qhist"] = values(4 * 32 * 17)
    result["conthist"] = values(4 * 32 * 5 * 17)
    result["remhist"] = values(4 * 32 * 31 * 2)
    require(offset == len(data), f"unexpected trailing stats bytes {path}")
    return result


def add_stats(total: dict | None, current: dict) -> dict:
    if total is None:
        total = {key: (value.copy() if isinstance(value, list) else value)
                 for key, value in current.items()}
        return total
    for key, value in current.items():
        if isinstance(value, list):
            total[key] = [a + b for a, b in zip(total[key], value)]
        elif isinstance(value, (int, float)):
            total[key] += value
    return total


def merge_records(paths: list[Path], target: Path, manifest_bytes: bytes) -> tuple[int, str]:
    count = 0
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as output:
        output.write(RECORD_MAGIC)
        output.write(struct.pack("<Q", len(manifest_bytes)))
        output.write(b"\0" * 8)
        output.write(manifest_bytes)
        for path in paths:
            with path.open("rb") as source:
                require(source.read(8) == RECORD_MAGIC, f"bad records {path}")
                length_bytes = source.read(8)
                count_bytes = source.read(8)
                require(len(length_bytes) == 8 and len(count_bytes) == 8, "truncated record header")
                manifest_length, chunk_count = struct.unpack("<QQ", length_bytes + count_bytes)
                embedded = source.read(manifest_length)
                require(embedded == manifest_bytes, "record manifest changed")
                while True:
                    block = source.read(COPY_BYTES)
                    if not block:
                        break
                    output.write(block)
                require(not source.read(1), f"trailing record bytes {path}")
                count += chunk_count
        output.seek(16)
        output.write(struct.pack("<Q", count))
    return count, sha(target)


def stem_paths(corpus: Path, row: dict) -> tuple[Path, Path, list[Path]]:
    identity = row["identity"].split(":", 1)[1]
    root = corpus / identity / "flac8e-30s"
    return root / "manifest.json", root / "stem.blob", [root / f"{i}.flac" for i in range(row["chunkCount"])]


def process_stem(row: dict, args: argparse.Namespace, tools: dict[str, str], root: Path) -> dict:
    identity = row["identity"].split(":", 1)[1]
    source_root = args.corpus / identity
    candidate = source_root / "flac8e-30s"
    manifest_path = HERE / row["manifestPath"]
    manifest_bytes = manifest_path.read_bytes()
    require(hashlib.sha256(manifest_bytes).hexdigest() == row["manifestSha256"], "frozen manifest changed")
    manifest = json.loads(manifest_bytes)
    active_frames = validate_manifest(manifest, row)
    check_file(source_root / "original.raw", manifest["frames"] * 6, identity)
    expected = json.loads((HERE / "evidence" / "results.json").read_text())
    result_row = next(item for item in next(s for s in expected["stems"] if s["identity"] == row["identity"])["results"]
                      if item["candidate"] == "flac8e-30s")
    check_file(source_root / "active.raw", row["activePcmBytes"], result_row["packedPcmSha256"])
    blob = candidate / "stem.blob"
    check_file(blob, result_row["totalBytes"], result_row["blobSha256"])
    chunks = result_row["chunks"]
    require(len(chunks) == len(manifest["chunks"]), "candidate chunk count mismatch")
    candidate_manifest_bytes = (candidate / "manifest.json").read_bytes()
    candidate_manifest = json.loads(candidate_manifest_bytes)
    validate_manifest(candidate_manifest, row)
    require(len(candidate_manifest_bytes) == result_row["manifestBytes"],
            "candidate manifest byte count mismatch")
    for candidate_chunk, expected_chunk in zip(candidate_manifest["chunks"], chunks):
        require(candidate_chunk["bytes"] == expected_chunk["bytes"] and
                candidate_chunk["offset"] == expected_chunk["offset"] and
                candidate_chunk["frames"] == expected_chunk["frames"] and
                candidate_chunk["packedStartFrame"] == expected_chunk["packedStartFrame"] and
                candidate_chunk["flacSha256"] == expected_chunk["flacSha256"],
                "candidate manifest differs from frozen chunk evidence")
    require(result_row["payloadBytes"] == sum(item["bytes"] for item in chunks) and
            result_row["totalBytes"] == result_row["payloadBytes"] + result_row["manifestBytes"] +
            result_row["headerBytes"], "candidate envelope byte accounting mismatch")

    stem_work = root / identity
    stem_work.mkdir(parents=True, exist_ok=True)
    records: list[Path] = []
    stats_total = None
    extract_metrics = []
    metadata_bytes = frame_bytes = 0
    packed_start = 0
    for index, (chunk, expected_chunk) in enumerate(zip(manifest["chunks"], chunks)):
        flac = candidate / f"{index}.flac"
        check_file(flac, expected_chunk["bytes"], expected_chunk["flacSha256"])
        rec = stem_work / f"{index}.rsd"
        summary = stem_work / f"{index}.extract.json"
        stats_path = stem_work / f"{index}.stats"
        command = [tools["helper"], "extract", str(flac), str(manifest_path), str(rec), str(summary),
                   str(stats_path), str(index), str(packed_start)]
        extract_metrics.append(run_timed(command, stem_work / f"{index}.extract.time"))
        receipt = json.loads(summary.read_text())
        require(receipt["recordCount"] > 0 and receipt["pcmBytes"] == chunk["frames"] * 6,
                "extraction receipt mismatch")
        require(receipt["metadataBytes"] + receipt["frameBytes"] == flac.stat().st_size,
                "metadata/frame byte mismatch")
        metadata_bytes += receipt["metadataBytes"]
        frame_bytes += receipt["frameBytes"]
        stats_total = add_stats(stats_total, read_stats(stats_path))
        records.append(rec)
        packed_start += chunk["frames"]

    require(result_row["payloadBytes"] == metadata_bytes + frame_bytes and
            result_row["totalBytes"] == frame_bytes + metadata_bytes +
            result_row["manifestBytes"] + result_row["headerBytes"],
            "stem control/envelope/frame accounting mismatch")

    merged = stem_work / "stem.rsd"
    record_count, record_sha = merge_records(records, merged, manifest_bytes)
    require(record_count == stats_total["frameCount"], "merged record/frame count mismatch")
    embedded_manifest, embedded_count = read_embedded_manifest(merged, manifest_bytes)
    require(embedded_count == record_count, "embedded record count mismatch")
    require(validate_manifest(embedded_manifest, row) == active_frames,
            "embedded manifest shape mismatch")
    validate_record_layout(merged, embedded_manifest, record_count)
    reconstructed = stem_work / "active.reconstructed.raw"
    decode_metrics = run_timed([tools["helper"], "decode", str(merged), str(reconstructed),
                                str(stem_work / "decode.json")], stem_work / "decode.time")
    check_file(reconstructed, row["activePcmBytes"], result_row["packedPcmSha256"])
    require(canonical_hash(reconstructed, embedded_manifest) == identity, "canonical PCM hash mismatch")
    require(frame_bytes * 8 == stats_total["frameBytes"] * 8 and
            stats_total["frameHeaderBits"] + stats_total["frameCrcBits"] + stats_total["framePaddingBits"] +
            stats_total["subframeHeaderBits"] + stats_total["wastedBits"] + stats_total["warmupBits"] +
            stats_total["coefficientBits"] + stats_total["constantBits"] + stats_total["verbatimBits"] +
            stats_total["residualHeaderBits"] + stats_total["quotientBits"] + stats_total["remainderBits"] +
            stats_total["escapedRawBits"] == stats_total["frameBytes"] * 8,
            "aggregate frame bit accounting mismatch")

    return {
        "identity": row["identity"], "recordingRef": row["recordingRef"],
        "sourceIDs": row["sourceIDs"], "activeFrames": active_frames,
        "activePcmBytes": row["activePcmBytes"], "canonicalPcmSha256": identity,
        "packedPcmSha256": result_row["packedPcmSha256"], "manifestBytes": len(manifest_bytes),
        "candidateManifestBytes": result_row["manifestBytes"],
        "envelopeHeaderBytes": result_row["headerBytes"],
        "envelopeBytes": result_row["manifestBytes"] + result_row["headerBytes"],
        "metadataBytes": metadata_bytes, "frameBytes": frame_bytes,
        "controlBytes": result_row["totalBytes"], "controlBlobSha256": result_row["blobSha256"],
        "recordCount": record_count, "recordSha256": record_sha,
        "stats": stats_total, "extract": extract_metrics, "decode": decode_metrics,
    }


def entropy(counts: list[int]) -> tuple[float, int]:
    total = sum(counts)
    if not total:
        return 0.0, 0
    h = sum(value * math.log2(total / value) for value in counts if value)
    return h, total


def table_score(counts: list[int]) -> tuple[float, int]:
    observed = [i for i, count in enumerate(counts) if count]
    total = sum(counts)
    if not observed:
        return 0.0, 0
    frequencies = {symbol: 1 for symbol in observed}
    remainder = 4096 - len(observed)
    allocations = []
    for symbol in observed:
        numerator = remainder * counts[symbol]
        allocations.append((numerator // total, numerator % total, symbol))
    for symbol, amount, _, _ in ((s, a, r, s) for s, (a, r, _) in zip(observed, allocations)):
        frequencies[symbol] += amount
    used = sum(frequencies.values())
    for _, _, symbol in sorted(allocations, key=lambda item: (-item[1], item[2]))[:4096 - used]:
        frequencies[symbol] += 1
    score = sum(counts[symbol] * math.log2(4096 / frequencies[symbol]) for symbol in observed)
    return score, len(observed)


def model_metrics(stats: dict, control_bytes: int | None = None) -> dict:
    qhist = stats["qhist"]
    conthist = stats["conthist"]
    remhist = stats["remhist"]
    ideal = table = 0.0
    q_tables = q_table_symbols = context_tables = context_table_symbols = 0
    q_escapes = 0
    remainder_fitted = remainder_raw = 0.0
    for role in range(4):
        for k in range(32):
            base = (role * 32 + k) * 17
            counts = qhist[base:base + 17]
            h, n = entropy(counts)
            if n:
                ideal += h
                score, observed = table_score(counts)
                table += score
                q_tables += 1
                q_table_symbols += observed
                q_escapes += counts[16]
            for context in range(5):
                cbase = ((role * 32 + k) * 5 + context) * 17
                ccounts = conthist[cbase:cbase + 17]
                ch, cn = entropy(ccounts)
                if cn:
                    context_tables += 1
                    context_table_symbols += table_score(ccounts)[1]
                    # Add all context table scores below after the table charge.
            # Remainder bit positions are kept independent for this diagnostic.
            for bit in range(min(k, 31)):
                rbase = ((role * 32 + k) * 31 + bit) * 2
                zero, one = remhist[rbase:rbase + 2]
                nbits = zero + one
                if nbits:
                    remainder_raw += nbits
                    if zero and one:
                        remainder_fitted += zero * math.log2(nbits / zero) + one * math.log2(nbits / one)
    context_score = 0.0
    for role in range(4):
        for k in range(32):
            for context in range(5):
                cbase = ((role * 32 + k) * 5 + context) * 17
                score, n = table_score(conthist[cbase:cbase + 17])
                if n:
                    context_score += score
    q_table_bytes = 4 + q_tables * (2 + 17 * 2) if q_tables else 4
    context_table_bytes = 4 + context_tables * (3 + 17 * 2) if context_tables else 4
    state_bits = stats["ordinarySubframes"] * 32
    padding_bits = stats["ordinarySubframes"] * 8
    control_bits = stats["frameBytes"] * 8 if control_bytes is None else control_bytes * 8
    q_model_bits = control_bits - stats["quotientBits"] + ideal + q_escapes * 32 + q_table_bytes * 8 + state_bits + padding_bits
    table_model_bits = control_bits - stats["quotientBits"] + table + q_escapes * 32 + q_table_bytes * 8 + state_bits + padding_bits
    context_model_bits = control_bits - stats["quotientBits"] + context_score + q_escapes * 32 + context_table_bytes * 8 + state_bits + padding_bits
    return {
        "residualSamples": stats["residualSamples"], "ordinarySamples": stats["ordinarySamples"],
        "escapedSamples": stats["escapedSamples"], "deliveryControlBits": control_bits,
        "unchangedBits": control_bits - stats["quotientBits"],
        "escapeFraction": (stats["escapedSamples"] / stats["residualSamples"] if stats["residualSamples"] else 0.0),
        "quotientControlBits": stats["quotientBits"], "remainderControlBits": stats["remainderBits"],
        "idealQuotientBits": ideal + q_escapes * 32, "tableQuotientBits": table + q_escapes * 32,
        "contextTableQuotientBits": context_score + q_escapes * 32,
        "qTableCount": q_tables, "qTableBytes": q_table_bytes,
        "contextTableCount": context_tables, "contextTableBytes": context_table_bytes,
        "coderStateBits": state_bits, "nominalPaddingBits": padding_bits,
        "idealModelBits": q_model_bits, "tableModelBits": table_model_bits,
        "contextModelBits": context_model_bits, "remainderRawBits": remainder_raw,
        "remainderFittedBits": remainder_fitted,
        "remainderFittedGainBits": remainder_raw - remainder_fitted,
        "lagCorr": [stats["lagCorrSum"][i] / stats["lagCounts"][i] if stats["lagCounts"][i] else None for i in range(6)],
    }


def sum_model_metrics(models: list[dict], control_bytes: int) -> dict:
    """Sum independently transmitted per-stem budgets; pooled histograms stay diagnostic."""
    require(models, "cannot sum an empty model list")
    summed: dict = {}
    additive = ("residualSamples", "ordinarySamples", "escapedSamples", "deliveryControlBits",
                "unchangedBits", "quotientControlBits", "remainderControlBits", "idealQuotientBits",
                "tableQuotientBits", "contextTableQuotientBits", "qTableCount", "qTableBytes",
                "contextTableCount", "contextTableBytes", "coderStateBits", "nominalPaddingBits",
                "idealModelBits", "tableModelBits", "contextModelBits", "remainderRawBits",
                "remainderFittedBits", "remainderFittedGainBits")
    for key in additive:
        summed[key] = sum(model[key] for model in models)
    summed["deliveryControlBits"] = control_bytes * 8
    summed["escapeFraction"] = (summed["escapedSamples"] / summed["residualSamples"]
                                 if summed["residualSamples"] else 0.0)
    summed["lagCorr"] = None
    return summed


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def freeze_config(args, catalog: dict, tools: dict[str, str], stems: list[dict]) -> dict:
    return {
        "format": "issue77-round1-freeze-v1", "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scopeSha256": sha(HERE / "iterations" / "round-01-scope.md"),
        "runnerSha256": sha(Path(__file__)), "nativeSha256": sha(HERE / "iterations" / "round-01" / "native" / "round1.c"),
        "sourcesSha256": sha(HERE / "sources.json"), "evidenceSha256": sha(HERE / "evidence" / "results.json"),
        "manifestSha256": {row["manifestPath"]: sha(HERE / row["manifestPath"]) for row in stems},
        "helper": {"path": tools["helper"], "sha256": sha(Path(tools["helper"]))},
        "compiler": "gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow",
        "compilerVersion": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
        "library": {"path": "/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a",
                    "sha256": sha(Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a"))},
        "corpus": str(args.corpus), "workerConcurrency": args.workers, "maxRecordBytes": 1024 * 1024,
        "model": {"quotientAlphabet": 17, "contextClasses": 5, "tableTotal": 4096, "qEscapeSymbol": 16,
                   "qBypassBits": 32, "coderStateBytes": 4, "paddingBudgetBytes": 1},
        "pilotIdentities": [row["identity"] for row in stems if row["identity"] in args.pilot],
        "commands": {"extract": "helper extract INPUT MANIFEST RECORDS SUMMARY STATS CHUNK_INDEX PACKED_START",
                      "decode": "helper decode RECORDS OUTPUT SUMMARY"},
        "platform": platform.platform(), "cpu": subprocess.check_output(["lscpu"], text=True),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 5))
    parser.add_argument("--pilot", nargs="*", default=["sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
                                                            "sha256:8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0",
                                                            "sha256:fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda",
                                                            "sha256:68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f"])
    parser.add_argument("--pilot-only", action="store_true")
    parser.add_argument("--freeze-only", action="store_true")
    parser.add_argument("--resume-frozen", action="store_true")
    args = parser.parse_args()
    args.work = args.work.resolve()
    args.corpus = args.corpus.resolve()
    args.helper = args.helper.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((HERE / "sources.json").read_text())
    stems = [row for row in catalog["stems"] if not args.pilot_only or row["identity"] in args.pilot]
    require(len(stems) == (4 if args.pilot_only else 30), "unexpected pilot/full stem set")
    tools = {"helper": str(args.helper)}
    freeze_path = args.work / "freeze.json"
    if args.resume_frozen:
        frozen = json.loads(freeze_path.read_text())
        require(frozen["runnerSha256"] == sha(Path(__file__)) and
                frozen["nativeSha256"] == sha(HERE / "iterations" / "round-01" / "native" / "round1.c") and
                frozen["scopeSha256"] == sha(HERE / "iterations" / "round-01-scope.md") and
                frozen["sourcesSha256"] == sha(HERE / "sources.json") and
                frozen["evidenceSha256"] == sha(HERE / "evidence" / "results.json"),
                "source changed after freeze")
        require(frozen["helper"]["sha256"] == sha(args.helper), "helper changed after freeze")
        require(frozen["corpus"] == str(args.corpus) and frozen["workerConcurrency"] == args.workers,
                "frozen corpus or worker count changed")
        for path, digest in frozen["manifestSha256"].items():
            require(sha(HERE / path) == digest, f"manifest changed after freeze: {path}")
    else:
        require(not freeze_path.exists(), "work directory already frozen")
        freeze_path.write_text(json.dumps(freeze_config(args, catalog, tools, catalog["stems"]), indent=2) + "\n")
        if args.freeze_only:
            return
    started = time.perf_counter()
    root = args.work / ("pilot" if args.pilot_only else "full")
    root.mkdir(parents=True, exist_ok=True)
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process_stem, row, args, tools, root) for row in stems]
        for future in futures:
            row = future.result()
            row["model"] = model_metrics(row["stats"], row["controlBytes"])
            rows.append(row)
            print(f"{row['recordingRef']}/{row['sourceIDs'][0]}: {row['controlBytes']:,} bytes; records and canonical PCM verified", flush=True)
    rows.sort(key=lambda row: row["identity"])
    stem_rows = []
    for row in rows:
        model = row["model"]
        stem_rows.append({"identity": row["identity"], "recordingRef": row["recordingRef"], "source": "/".join(row["sourceIDs"]),
                          "controlBytes": row["controlBytes"], "manifestBytes": row["manifestBytes"],
                          "candidateManifestBytes": row["candidateManifestBytes"],
                          "envelopeHeaderBytes": row["envelopeHeaderBytes"],
                          "envelopeBytes": row["envelopeBytes"],
                          "metadataBytes": row["metadataBytes"], "frameBytes": row["frameBytes"],
                          "recordCount": row["recordCount"], "residualSamples": row["stats"]["residualSamples"],
                          "ordinarySamples": row["stats"]["ordinarySamples"], "escapedSamples": row["stats"]["escapedSamples"],
                          "frameHeaderBits": row["stats"]["frameHeaderBits"], "frameCrcBits": row["stats"]["frameCrcBits"],
                          "framePaddingBits": row["stats"]["framePaddingBits"], "subframeHeaderBits": row["stats"]["subframeHeaderBits"],
                          "warmupBits": row["stats"]["warmupBits"], "coefficientBits": row["stats"]["coefficientBits"],
                          "residualHeaderBits": row["stats"]["residualHeaderBits"], "quotientBits": row["stats"]["quotientBits"],
                          "remainderBits": row["stats"]["remainderBits"], "escapedRawBits": row["stats"]["escapedRawBits"],
                          "idealModelBits": model["idealModelBits"], "tableModelBits": model["tableModelBits"],
                          "contextModelBits": model["contextModelBits"], "remainderFittedGainBits": model["remainderFittedGainBits"],
                          "idealQuotientBits": model["idealQuotientBits"], "tableQuotientBits": model["tableQuotientBits"],
                          "contextTableQuotientBits": model["contextTableQuotientBits"],
                          "qTableCount": model["qTableCount"], "qTableBytes": model["qTableBytes"],
                          "contextTableCount": model["contextTableCount"], "contextTableBytes": model["contextTableBytes"],
                          "coderStateBits": model["coderStateBits"], "nominalPaddingBits": model["nominalPaddingBits"],
                          "remainderRawBits": model["remainderRawBits"], "remainderFittedBits": model["remainderFittedBits"],
                          "escapeFraction": model["escapeFraction"], "recordSha256": row["recordSha256"],
                          "canonicalPcmSha256": row["canonicalPcmSha256"],
                          "extractSeconds": sum(item["wallSeconds"] for item in row["extract"]),
                          "decodeSeconds": row["decode"]["wallSeconds"], "decodePeakRssKiB": row["decode"]["peakRssKiB"]})
    fields = list(stem_rows[0])
    write_csv(args.work / ("pilot-per-stem.csv" if args.pilot_only else "per-stem.csv"), stem_rows, fields)
    session_rows = []
    for session in sorted({row["recordingRef"] for row in stem_rows}):
        members = [row for row in stem_rows if row["recordingRef"] == session]
        session_rows.append({"recordingRef": session, "stemCount": len(members),
                             "controlBytes": sum(row["controlBytes"] for row in members),
                             "manifestBytes": sum(row["manifestBytes"] for row in members),
                             "candidateManifestBytes": sum(row["candidateManifestBytes"] for row in members),
                             "envelopeHeaderBytes": sum(row["envelopeHeaderBytes"] for row in members),
                             "envelopeBytes": sum(row["envelopeBytes"] for row in members),
                             "metadataBytes": sum(row["metadataBytes"] for row in members),
                             "frameBytes": sum(row["frameBytes"] for row in members),
                             "residualSamples": sum(row["residualSamples"] for row in members),
                             "quotientBits": sum(row["quotientBits"] for row in members),
                             "remainderBits": sum(row["remainderBits"] for row in members),
                             "idealModelBits": sum(row["idealModelBits"] for row in members),
                             "tableModelBits": sum(row["tableModelBits"] for row in members),
                             "contextModelBits": sum(row["contextModelBits"] for row in members),
                             "qTableBytes": sum(row["qTableBytes"] for row in members),
                             "contextTableBytes": sum(row["contextTableBytes"] for row in members),
                             "coderStateBits": sum(row["coderStateBits"] for row in members),
                             "nominalPaddingBits": sum(row["nominalPaddingBits"] for row in members)})
    write_csv(args.work / ("pilot-per-session.csv" if args.pilot_only else "per-session.csv"),
              session_rows, list(session_rows[0]))
    total_stats = None
    for row in rows:
        total_stats = add_stats(total_stats, row["stats"])
    total_model = sum_model_metrics([row["model"] for row in rows],
                                     sum(row["controlBytes"] for row in rows))
    pooled_model = model_metrics(total_stats, sum(row["controlBytes"] for row in rows))
    total = {"format": "issue77-round1-results-v1", "freezeSha256": sha(freeze_path),
             "pilot": args.pilot_only, "stemCount": len(rows), "elapsedSeconds": time.perf_counter() - started,
             "controlBytes": sum(row["controlBytes"] for row in rows), "manifestBytes": sum(row["manifestBytes"] for row in rows),
             "candidateManifestBytes": sum(row["candidateManifestBytes"] for row in rows),
             "envelopeHeaderBytes": sum(row["envelopeHeaderBytes"] for row in rows),
             "envelopeBytes": sum(row["envelopeBytes"] for row in rows),
             "metadataBytes": sum(row["metadataBytes"] for row in rows), "frameBytes": sum(row["frameBytes"] for row in rows),
             "stats": total_stats, "model": total_model, "pooledModelDiagnostic": pooled_model, "stems": rows}
    total_row = {"stemCount": len(rows), "controlBytes": total["controlBytes"],
                 "manifestBytes": total["manifestBytes"], "frameBytes": total["frameBytes"],
                 "candidateManifestBytes": total["candidateManifestBytes"],
                 "envelopeHeaderBytes": total["envelopeHeaderBytes"],
                 "envelopeBytes": total["envelopeBytes"], "metadataBytes": total["metadataBytes"],
                 "residualSamples": total_stats["residualSamples"], "quotientBits": total_stats["quotientBits"],
                 "remainderBits": total_stats["remainderBits"], "idealModelBits": total_model["idealModelBits"],
                 "tableModelBits": total_model["tableModelBits"], "contextModelBits": total_model["contextModelBits"],
                 "qTableBytes": total_model["qTableBytes"], "contextTableBytes": total_model["contextTableBytes"],
                 "coderStateBits": total_model["coderStateBits"], "nominalPaddingBits": total_model["nominalPaddingBits"]}
    write_csv(args.work / ("pilot-totals.csv" if args.pilot_only else "totals.csv"), [total_row], list(total_row))
    (args.work / ("pilot-results.json" if args.pilot_only else "results.json")).write_text(json.dumps(total, indent=2) + "\n")
    print(json.dumps({"controlBytes": total["controlBytes"], "idealModelBits": total_model["idealModelBits"],
                      "tableModelBits": total_model["tableModelBits"], "contextModelBits": total_model["contextModelBits"],
                      "pooledDiagnosticContextModelBits": pooled_model["contextModelBits"]}, indent=2))


if __name__ == "__main__":
    main()
