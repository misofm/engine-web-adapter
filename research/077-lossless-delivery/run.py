#!/usr/bin/env python3
"""Issue #77 only: freeze, encode, and exactly verify the published 30 stems.

Offline scratch files live outside the repository. No production code is imported.
Python memory stays bounded by COPY_BYTES; codecs operate on files/streams.
"""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import time
import urllib.request

HERE = Path(__file__).resolve().parent
COPY_BYTES = 1024 * 1024
ZERO = bytes(COPY_BYTES)
CANDIDATES = [
    {"id": "published", "codec": "published", "layout": "30s"},
    {"id": "ffmpeg5-30s", "codec": "ffmpeg", "options": ["5"], "layout": "30s"},
    {"id": "ffmpeg8-30s", "codec": "ffmpeg", "options": ["8"], "layout": "30s"},
    {"id": "flac5-30s", "codec": "flac", "options": ["-5"], "layout": "30s"},
    {"id": "flac8-30s", "codec": "flac", "options": ["-8"], "layout": "30s"},
    {"id": "flac8e-30s", "codec": "flac", "options": ["-8", "-e"], "layout": "30s"},
    {"id": "flac8e-60s", "codec": "flac", "options": ["-8", "-e"], "layout": "60s"},
    {"id": "flac8e-concat", "codec": "flac", "options": ["-8", "-e"], "layout": "concat"},
    {"id": "flac8e-dense", "codec": "flac", "options": ["-8", "-e"], "layout": "dense"},
    {"id": "wavpack-concat", "codec": "wavpack", "options": [], "layout": "concat"},
    {"id": "wavpackx6-concat", "codec": "wavpack", "options": ["-x6"], "layout": "concat"},
    {"id": "wavpackhh-concat", "codec": "wavpack", "options": ["-hh"], "layout": "concat"},
    {"id": "wavpackhhx6-concat", "codec": "wavpack", "options": ["-hh", "-x6"], "layout": "concat"},
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_file(path, size, digest):
    require(path.stat().st_size == size, f"Wrong byte count: {path}")
    require(sha(path) == digest, f"Wrong SHA-256: {path}")


def transfer(source, count, target=None, digest=None, zeros=False):
    while count:
        data = source.read(min(count, COPY_BYTES))
        require(bool(data), "Truncated PCM or payload")
        if zeros:
            require(not any(data), "Interval map would omit nonzero PCM")
        if target is not None:
            target.write(data)
        if digest is not None:
            digest.update(data)
        count -= len(data)


def hash_zeros(digest, count):
    while count:
        size = min(count, COPY_BYTES)
        digest.update(ZERO[:size])
        count -= size


def validate_manifest(manifest):
    require(manifest["format"] == "miso_sparse_stem_v1", "Wrong published format")
    require(manifest["bitDepth"] == 24 and manifest["channels"] == 2,
            "This frozen experiment requires interleaved signed stereo s24le")
    end = packed = 0
    for interval in manifest["intervals"]:
        start, frames = interval["startFrame"], interval["frames"]
        require(start >= end and frames > 0 and start + frames <= manifest["frames"],
                "Overlapping, empty, or out-of-range interval")
        require(interval["packedFrameOffset"] == packed, "Noncontiguous packed intervals")
        end = start + frames
        packed += frames
    frames = offset = 0
    for chunk in manifest["chunks"]:
        require(chunk["packedStartFrame"] == frames and chunk["offset"] == offset,
                "Noncontiguous chunk index")
        require(0 < chunk["frames"] <= 30 * manifest["sampleRateHz"] and chunk["bytes"] > 0,
                "Unexpected published chunk policy")
        frames += chunk["frames"]
        offset += chunk["bytes"]
    require(frames == packed, "Intervals and chunks disagree")
    return packed


def pack_active(original, packed, manifest):
    """Verify every omitted byte is zero; retain the supplied map exactly."""
    end = 0
    with original.open("rb") as src, packed.open("wb") as dst:
        for interval in manifest["intervals"]:
            start, frames = interval["startFrame"], interval["frames"]
            transfer(src, (start - end) * 6, zeros=True)
            transfer(src, frames * 6, target=dst)
            end = start + frames
        transfer(src, (manifest["frames"] - end) * 6, zeros=True)
        require(not src.read(1), "Trailing canonical PCM")


def reconstructed_hash(packed, manifest):
    digest = hashlib.sha256()
    end = 0
    with packed.open("rb") as src:
        for interval in manifest["intervals"]:
            start, frames = interval["startFrame"], interval["frames"]
            hash_zeros(digest, (start - end) * 6)
            transfer(src, frames * 6, digest=digest)
            end = start + frames
        hash_zeros(digest, (manifest["frames"] - end) * 6)
        require(not src.read(1), "Trailing packed PCM")
    result = digest.hexdigest()
    require("sha256:" + result == manifest["identity"], "Reconstructed canonical PCM mismatch")
    return result


def measured(command, log, output, input_path=None):
    """Wall includes process startup and output-file writes; CPU/RSS are child-only."""
    started = time.perf_counter()
    with output.open("wb") as stdout, log.with_suffix(".stderr").open("wb") as stderr:
        stdin = input_path.open("rb") if input_path else subprocess.DEVNULL
        try:
            subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(log),
                            *command], stdin=stdin, stdout=stdout, stderr=stderr, check=True)
        finally:
            if input_path:
                stdin.close()
    wall = time.perf_counter() - started
    user, system, rss = log.read_text().split()
    return {"wallSeconds": wall, "userSeconds": float(user), "systemSeconds": float(system),
            "peakRssKiB": int(rss)}


def encoder(candidate, tools, raw, encoded):
    codec = candidate["codec"]
    options = candidate["options"]
    if codec == "ffmpeg":
        # Publication encodes stdin/stdout, then finalizes STREAMINFO below.
        return [tools["ffmpeg"], "-v", "error", "-nostdin", "-f", "s24le", "-ar", "44100",
                "-ac", "2", "-i", "pipe:0", "-map_metadata", "-1", "-map_chapters", "-1",
                "-fflags", "+bitexact", "-flags:a", "+bitexact", "-metadata_header_padding", "0",
                "-compression_level", *options, "-sample_fmt", "s32", "-bits_per_raw_sample",
                "24", "-f", "flac", "-"], raw, encoded
    if codec == "flac":
        return [tools["flac"], "--silent", "--force", *options, "--no-padding", "--no-seektable",
                "--force-raw-format", "--endian=little", "--sign=signed", "--channels=2",
                "--bps=24", "--sample-rate=44100", "-o", str(encoded), str(raw)], None, encoded.with_suffix(".stdout")
    if codec == "wavpack":
        return [tools["wavpack"], "-q", "-y", "--threads=1", "--raw-pcm=44100,24s,2,le",
                *options, str(raw), "-o", str(encoded)], None, encoded.with_suffix(".stdout")
    raise ValueError(codec)


def decoder(codec, tools, encoded):
    if codec == "wavpack":
        return [tools["wvunpack"], "-q", "--threads=1", "--raw", str(encoded), "-o", "-"]
    return [tools["flac"], "--silent", "--decode", "--stdout", "--force-raw-format",
            "--endian=little", "--sign=signed", str(encoded)]


def combine_metrics(metrics):
    return {key: (max(m[key] for m in metrics) if key == "peakRssKiB" else
                  sum(m[key] for m in metrics))
            for key in ["wallSeconds", "userSeconds", "systemSeconds", "peakRssKiB"]}


def flac_metadata_bytes(path):
    with path.open("rb") as f:
        require(f.read(4) == b"fLaC", "Not native FLAC")
        total = 4
        while True:
            header = f.read(4)
            require(len(header) == 4, "Truncated FLAC metadata")
            count = int.from_bytes(header[1:], "big")
            transfer(f, count)
            total += 4 + count
            if header[0] & 128:
                return total


def finalize_ffmpeg(path, raw, frames):
    # The publication finalizes the stream length and PCM MD5 and clears the
    # optional frame-byte bounds. These are metadata edits, not audio coding.
    with raw.open("rb") as src:
        md5 = hashlib.file_digest(src, "md5").digest()
    with path.open("r+b") as dst:
        header = bytearray(dst.read(42))
        require(header[:8] == b"fLaC\x00\x00\x00\x22", "Unexpected FFmpeg STREAMINFO")
        header[12:18] = bytes(6)
        shape = int.from_bytes(header[18:26], "big")
        header[18:26] = ((shape & ~((1 << 36) - 1)) | frames).to_bytes(8, "big")
        header[26:42] = md5
        dst.seek(0)
        dst.write(header)


def input_file(row, kind, args):
    identity = row["identity"].split(":")[1]
    size = row["originalTransportBytes"] if kind == "original" else row["bytes"]
    digest = row["originalFlacSha256"] if kind == "original" else row["sha256"]
    if args.local_inputs:
        path = Path(json.loads(args.local_inputs.read_text())[identity][kind])
    else:
        path = args.work / "inputs" / f"{identity}.{kind}"
        if not path.exists():
            require(args.url_template is not None, "Supply --local-inputs or --url-template")
            blob = row["originalBlobId"] if kind == "original" else row["blobId"]
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(".partial")
            with urllib.request.urlopen(args.url_template.format(blob_id=blob), timeout=60) as src, partial.open("wb") as dst:
                transfer(src, size, target=dst)
                require(not src.read(1), "Unexpected trailing downloaded bytes")
            check_file(partial, size, digest)
            partial.replace(path)
    check_file(path, size, digest)
    return path


def stem_run(row, args, tools):
    identity = row["identity"].split(":")[1]
    work = args.work / identity
    work.mkdir()
    manifest_bytes = (HERE / row["manifestPath"]).read_bytes()
    require(hashlib.sha256(manifest_bytes).hexdigest() == row["manifestSha256"], "Frozen map changed")
    manifest = json.loads(manifest_bytes)
    active_frames = validate_manifest(manifest)
    require(manifest["sampleRateHz"] == 44100 and manifest["identity"] == row["identity"], "Wrong source")
    require(active_frames * 6 == row["activePcmBytes"], "Active byte count mismatch")
    original = input_file(row, "original", args)
    published = input_file(row, "published", args)
    raw = work / "original.raw"
    original_metrics = measured(decoder("flac", tools, original), work / "original.time", raw)
    check_file(raw, manifest["frames"] * 6, identity)
    packed = work / "active.raw"
    pack_active(raw, packed, manifest)
    require(reconstructed_hash(packed, manifest) == identity, "Baseline reconstruction failed")
    packed_sha = sha(packed)
    results = [{"candidate": "original", "payloadBytes": original.stat().st_size,
                "manifestBytes": 0, "headerBytes": 0, "totalBytes": original.stat().st_size,
                "flacMetadataBytes": flac_metadata_bytes(original), "chunkCount": 1,
                "canonicalPcmSha256": identity, "decode": original_metrics,
                "blobSha256": row["originalFlacSha256"], "encode": None}]
    for candidate in CANDIDATES:
        cid = candidate["id"]
        directory = work / cid
        directory.mkdir()
        dense = candidate["layout"] == "dense"
        source = raw if dense else packed
        total_frames = manifest["frames"] if dense else active_frames
        if candidate["layout"] == "30s":
            lengths = [c["frames"] for c in manifest["chunks"]]
        else:
            maximum = 60 * 44100 if candidate["layout"] == "60s" else total_frames
            lengths = [min(maximum, total_frames - start) for start in range(0, total_frames, maximum)]
        chunks, enc_times, dec_times = [], [], []
        reconstructed = directory / "decoded.raw"
        offset = packed_start = metadata_bytes = 0
        with source.open("rb") as source_file, reconstructed.open("wb") as decoded_file:
            for index, frames in enumerate(lengths):
                chunk_raw = directory / "input.raw"
                digest = hashlib.sha256()
                with chunk_raw.open("wb") as dst:
                    transfer(source_file, frames * 6, target=dst, digest=digest)
                chunk_sha = digest.hexdigest()
                is_wavpack = candidate["codec"] == "wavpack"
                encoded = directory / f"{index}.{'wv' if is_wavpack else 'flac'}"
                if cid == "published":
                    prior = manifest["chunks"][index]
                    with published.open("rb") as src, encoded.open("wb") as dst:
                        src.seek(16 + row["manifestBytes"] + prior["offset"])
                        transfer(src, prior["bytes"], target=dst)
                    check_file(encoded, prior["bytes"], prior["flacSha256"])
                    require(chunk_sha == prior["pcmSha256"], "Published chunk PCM identity differs")
                else:
                    command, stdin, stdout = encoder(candidate, tools, chunk_raw, encoded)
                    enc_times.append(measured(command, directory / f"{index}.encode.time", stdout, stdin))
                    if candidate["codec"] == "ffmpeg":
                        finalize_ffmpeg(encoded, chunk_raw, frames)
                decoded = directory / "chunk-decoded.raw"
                dec_times.append(measured(decoder(candidate["codec"], tools, encoded),
                                          directory / f"{index}.decode.time", decoded))
                check_file(decoded, frames * 6, chunk_sha)
                with decoded.open("rb") as src:
                    transfer(src, frames * 6, target=decoded_file)
                size = encoded.stat().st_size
                chunk = {"bytes": size, "frames": frames, "offset": offset,
                         "packedStartFrame": packed_start, "pcmSha256": chunk_sha,
                         "wavpackSha256" if is_wavpack else "flacSha256": sha(encoded)}
                chunks.append(chunk)
                offset += size
                packed_start += frames
                if not is_wavpack:
                    metadata_bytes += flac_metadata_bytes(encoded)
                decoded.unlink()
                chunk_raw.unlink()
            require(not source_file.read(1), "Chunk policy dropped PCM")
        verified = sha(reconstructed) if dense else reconstructed_hash(reconstructed, manifest)
        require(verified == identity, "Candidate canonical hash mismatch")
        if not dense:
            require(sha(reconstructed) == packed_sha, "Packed channel/sample ordering mismatch")
        reconstructed.unlink()
        packaged = copy.deepcopy(manifest)
        packaged["chunks"] = chunks
        magic = b"MISOSTM1"
        if candidate["codec"] == "wavpack":
            packaged["format"] = "issue77_research_wavpack_v1"
            magic = b"MISO77WV"
        if dense:
            packaged["format"] = "issue77_research_dense_flac_v1"
            magic = b"MISO77DF"
        serialized = canonical_json(packaged)
        if cid in ("published", "ffmpeg5-30s"):
            require(serialized == manifest_bytes, "Publication replay is not byte-exact")
        (directory / "manifest.json").write_bytes(serialized)
        blob = directory / "stem.blob"
        with blob.open("wb") as dst:
            dst.write(magic + struct.pack("<Q", len(serialized)))
            dst.write(serialized)
            for index in range(len(chunks)):
                path = directory / f"{index}.{'wv' if candidate['codec'] == 'wavpack' else 'flac'}"
                with path.open("rb") as src:
                    shutil.copyfileobj(src, dst, COPY_BYTES)
        blob_sha = sha(blob)
        if cid in ("published", "ffmpeg5-30s"):
            require(blob_sha == row["sha256"], "Publication blob differs")
        results.append({"candidate": cid, "payloadBytes": offset, "manifestBytes": len(serialized),
                        "headerBytes": 16, "totalBytes": blob.stat().st_size,
                        "flacMetadataBytes": None if candidate["codec"] == "wavpack" else metadata_bytes,
                        "chunkCount": len(chunks), "canonicalPcmSha256": verified,
                        "packedPcmSha256": None if dense else packed_sha, "blobSha256": blob_sha,
                        "encode": combine_metrics(enc_times) if enc_times else None,
                        "decode": combine_metrics(dec_times), "chunks": chunks})
        print(f"{row['recordingRef']}/{row['sourceIDs'][0]} {cid}: {blob.stat().st_size:,} bytes; PCM verified", flush=True)
    result = {"identity": row["identity"], "recordingRef": row["recordingRef"],
              "sourceIDs": row["sourceIDs"], "results": results}
    write_json(work / "result.json", result)
    return result


def freeze(args, catalog, tools):
    require(not (args.work / "freeze.json").exists(), "Use an empty work directory; freeze already exists")
    versions = {}
    for name, path in tools.items():
        flag = "-version" if name == "ffmpeg" else "--version"
        result = subprocess.run([path, flag], capture_output=True, text=True, check=True)
        versions[name] = {"executable": path, "sha256": sha(path),
                          "version": (result.stdout + result.stderr).strip()}
    value = {"format": "issue77-frozen-experiment-v1", "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "sourcesSha256": sha(HERE / "sources.json"), "runnerSha256": sha(__file__),
             "manifestSha256": {r["manifestPath"]: sha(HERE / r["manifestPath"]) for r in catalog["stems"]},
             "candidates": CANDIDATES, "tools": versions,
             "encoderCommands": {c["id"]: encoder(c, tools, Path("INPUT.raw"), Path("OUTPUT.codec"))[0]
                                 for c in CANDIDATES if c["codec"] != "published"},
             "decoderCommands": {c: decoder(c, tools, Path("INPUT.codec")) for c in ["flac", "wavpack"]},
             "platform": platform.platform(), "cpu": subprocess.check_output(["lscpu"], text=True),
             "workerConcurrency": args.workers, "codecThreads": "WavPack explicitly 1; libFLAC default 1; FFmpeg publication defaults",
             "cacheState": "Uncontrolled server filesystem/page cache; no mobile/network/OPFS claim",
             "memoryMeasurement": "GNU time maximum child RSS KiB per codec invocation; excludes Python, filesystem page cache and browser",
             "separatedStems": "Not supplied; published 30 submixed stems only"}
    write_json(args.work / "freeze.json", value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--flac", required=True)
    parser.add_argument("--wavpack", required=True)
    parser.add_argument("--wvunpack", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--local-inputs", type=Path)
    parser.add_argument("--url-template", help="Caller-owned URL containing {blob_id}")
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 9))
    parser.add_argument("--freeze-only", action="store_true")
    parser.add_argument("--resume-frozen", action="store_true")
    args = parser.parse_args()
    args.work = args.work.resolve()
    require(not args.work.is_relative_to(HERE.parent.parent), "Scratch must be outside the repository")
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((HERE / "sources.json").read_text())
    tools = {k: str(Path(getattr(args, k)).resolve()) for k in ["flac", "wavpack", "wvunpack", "ffmpeg"]}
    if args.resume_frozen:
        frozen = json.loads((args.work / "freeze.json").read_text())
        require(frozen["runnerSha256"] == sha(__file__) and frozen["sourcesSha256"] == sha(HERE / "sources.json"),
                "Runner or catalog changed since freeze")
        require(frozen["workerConcurrency"] == args.workers, "Concurrency changed since freeze")
        for name, path in tools.items():
            require(sha(path) == frozen["tools"][name]["sha256"], "Codec changed since freeze")
        for path, digest in frozen["manifestSha256"].items():
            require(sha(HERE / path) == digest, "Interval map changed since freeze")
    else:
        freeze(args, catalog, tools)
    if args.freeze_only:
        return
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        stems = list(pool.map(lambda row: stem_run(row, args, tools), catalog["stems"]))
    write_json(args.work / "results.json", {"format": "issue77-server-results-v1",
               "freezeSha256": sha(args.work / "freeze.json"), "wallSeconds": time.perf_counter() - started,
               "stems": stems})


if __name__ == "__main__":
    main()
