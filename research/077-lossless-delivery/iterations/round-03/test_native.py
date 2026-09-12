#!/usr/bin/env python3
"""Independent round-03 native gates.

The input records and expected PCM are serialized here rather than produced by
the round-01/round-03 encoders.  The native helper path is configurable and a
missing helper is a hard failure.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


RSD_MAGIC = b"I77RSD01"
R3_MAGIC = b"I77FIR03"
S24_MIN = -(1 << 23)
S24_MAX = (1 << 23) - 1


def s24(value: int) -> bytes:
    if not S24_MIN <= value <= S24_MAX:
        raise ValueError(value)
    return struct.pack("<I", value & 0xFFFFFF)[:3]


def pcm(left: list[int], right: list[int]) -> bytes:
    return b"".join(s24(a) + s24(b) for a, b in zip(left, right))


def put_bits(data: bytearray, bit_position: int, width: int, value: int) -> None:
    for index in range(width):
        bit = (value >> (width - index - 1)) & 1
        position = bit_position + index
        mask = 1 << (7 - (position & 7))
        if bit:
            data[position >> 3] |= mask
        else:
            data[position >> 3] &= ~mask


def manifest(frames: int) -> bytes:
    zeros = "0" * 64
    value = {
        "bitDepth": 24,
        "channels": 2,
        "chunks": [{"bytes": 1, "flacSha256": zeros, "frames": frames,
                     "offset": 0, "packedStartFrame": 0, "pcmSha256": zeros}],
        "format": "miso_sparse_stem_v1",
        "frames": frames,
        "identity": "sha256:" + zeros,
        "intervals": [{"frames": frames, "packedFrameOffset": 0, "startFrame": 0}],
        "sampleRateHz": 44100,
    }
    import json
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def subframe(kind: int, blocksize: int, *, order: int = 0, precision: int = 0,
             shift: int = 0, method: int = 1, partition_order: int = 0,
             values: list[int] | None = None, warmups: list[int] | None = None,
             coefficients: list[int] | None = None, parameters: list[int] | None = None,
             raw_widths: list[int] | None = None) -> bytes:
    values = values or []
    warmups = warmups or []
    coefficients = coefficients or []
    if kind in (0, 1):
        method = 255
        order = precision = shift = partition_order = 0
        count = 1 if kind == 0 else blocksize
        partition_count = 0
        parameters = []
        raw_widths = []
    else:
        count = blocksize - order
        partition_count = 1 << partition_order
        parameters = parameters or [0] * partition_count
        raw_widths = raw_widths or [0] * partition_count
        if len(parameters) != partition_count or len(raw_widths) != partition_count:
            raise ValueError("partition metadata")
    if shift < -128 or shift > 127:
        raise ValueError("shift")
    header = struct.pack("<8BII", kind, 0, order, precision, shift & 0xFF,
                         method, partition_order, 0, count, partition_count)
    body = bytearray(header)
    body += struct.pack(f"<{len(warmups)}i", *warmups) if warmups else b""
    body += struct.pack(f"<{len(coefficients)}i", *coefficients) if coefficients else b""
    if kind in (2, 3):
        for parameter, width in zip(parameters, raw_widths):
            body += struct.pack("<BBH", parameter, width, 0)
    body += struct.pack(f"<{len(values)}i", *values) if values else b""
    return bytes(body)


@dataclass(frozen=True)
class Fixture:
    data: bytes
    expected: bytes


def fixture() -> Fixture:
    frames: list[bytes] = []
    expected: list[bytes] = []
    packed = 0
    source_offset = 0

    def add(blocksize: int, assignment: int, left_sub: bytes, right_sub: bytes,
            left: list[int], right: list[int]) -> None:
        nonlocal packed, source_offset
        body = struct.pack("<IQQII4B", 0, packed, source_offset, 1, blocksize,
                           assignment, 2, 24, 0) + left_sub + right_sub
        frames.append(struct.pack("<I", len(body)) + body)
        expected.append(pcm(left, right))
        packed += blocksize
        source_offset += len(body)

    add(4, 0, subframe(0, 4, values=[3]), subframe(0, 4, values=[-2]),
        [3] * 4, [-2] * 4)

    left = [0, 1, -2, 3, -4, 5, -6, 7]
    right = [7, -6, 5, -4, 3, -2, 1, 0]
    add(8, 0, subframe(2, 8, values=left), subframe(2, 8, values=right), left, right)

    # Partitioned input with an original raw-width-zero escape partition.
    zeros = [0, 0, 0, 0]
    add(4, 0, subframe(2, 4, values=zeros, parameters=[31], raw_widths=[0]),
        subframe(2, 4, values=zeros, parameters=[31], raw_widths=[0]), zeros, zeros)

    # Mid/side frame: native output must restore the original stereo pair.
    mid = [2, 0, 1, -1]
    side = [0, 1, -1, 2]
    left = [2, 1, 1, 0]
    right = [2, 0, 2, -2]
    add(4, 3, subframe(2, 4, values=mid), subframe(2, 4, values=side), left, right)

    # Left/side assignment with negative and odd samples.  The side channel
    # is left minus right, so restoration must subtract it exactly.
    left = [5, -3, 2, -1, 0]
    right = [-2, 4, -1, 3, -5]
    side = [left_value - right_value for left_value, right_value in zip(left, right)]
    add(5, 1, subframe(2, 5, values=left), subframe(2, 5, values=side), left, right)

    # Right/side assignment with a distinct odd/negative matrix.  The side
    # channel is left minus right, so restoration must add it to the right.
    right = [-5, 2, -3, 4, -1]
    left = [3, -2, 5, -1, 7]
    side = [left_value - right_value for left_value, right_value in zip(left, right)]
    add(5, 2, subframe(2, 5, values=side), subframe(2, 5, values=right), left, right)

    # LPC order one with signed i32 residual extrema still yielding s24 PCM.
    left = [32768, 0]
    right = [-32768, -1]
    add(2, 0,
        subframe(3, 2, order=1, precision=15, shift=-3, warmups=[32768],
                 coefficients=[8192], values=[-(1 << 31)]),
        subframe(3, 2, order=1, precision=15, shift=-3, warmups=[-32768],
                 coefficients=[8192], values=[(1 << 31) - 1]), left, right)

    # Verbatim odd block length and a fixed order-1 partition transition.
    left = [4, -3, 2, -1, 0]
    right = [-4, 3, -2, 1, 0]
    add(5, 0, subframe(1, 5, values=left), subframe(1, 5, values=right), left, right)
    warm_left = [10]
    res_left = [1, -1, 2, -2, 3, -3, 4]
    warm_right = [-5]
    res_right = [-1, 1, -2, 2, -3, 3, -4]
    left = [10]
    right = [-5]
    for residual in res_left:
        left.append(left[-1] + residual)
    for residual in res_right:
        right.append(right[-1] + residual)
    add(8, 0, subframe(2, 8, order=1, warmups=warm_left, values=res_left,
                        partition_order=1, parameters=[0, 30]),
        subframe(2, 8, order=1, warmups=warm_right, values=res_right,
                 partition_order=1, parameters=[0, 30]), left, right)

    embedded = manifest(packed)
    header = RSD_MAGIC + struct.pack("<QQ", len(embedded), len(frames)) + embedded
    return Fixture(header + b"".join(frames), b"".join(expected))


class NativeRound3Tests(unittest.TestCase):
    helper: Path

    @classmethod
    def setUpClass(cls) -> None:
        parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
        parser.add_argument("--helper")
        args, _ = parser.parse_known_args()
        configured = args.helper or os.environ.get("ROUND3_HELPER")
        cls.helper = Path(configured or "/data/issue-77-lossless/iterations/round-03/round3-helper")
        if not cls.helper.is_file() or not os.access(cls.helper, os.X_OK):
            raise AssertionError(f"native round3 helper not executable: {cls.helper}")

    def command(self, args: list[str], cwd: Path) -> tuple[int, str]:
        result = subprocess.run([str(self.helper), *args], cwd=cwd,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, check=False)
        diagnostic = (result.stdout or "") + (result.stderr or "")
        for marker in ("AddressSanitizer", "UndefinedBehaviorSanitizer", "runtime error:",
                       "LeakSanitizer", "SUMMARY: UndefinedBehaviorSanitizer"):
            self.assertNotIn(marker, diagnostic, diagnostic)
        return result.returncode, diagnostic

    def run_pair(self, root: Path, mode: int, profile: int,
                 source: Path, expected: bytes) -> tuple[Path, Path]:
        stem = root / f"m{mode}-p{profile}"
        output, original, coded, encoded_summary = (stem.with_suffix(suffix)
                                                     for suffix in (".fir", ".oa", ".ca", ".e.json"))
        decoded, decoded_original, decoded_coded, decoded_summary = (stem.with_suffix(suffix)
                                                                       for suffix in (".raw", ".doa", ".dca", ".d.json"))
        code, diagnostic = self.command(["encode", str(source), str(output), str(original),
                                        str(coded), str(encoded_summary), str(mode), str(profile)], root)
        self.assertEqual(code, 0, diagnostic)
        code, diagnostic = self.command(["decode", str(output), str(decoded), str(decoded_original),
                                        str(decoded_coded), str(decoded_summary)], root)
        self.assertEqual(code, 0, diagnostic)
        self.assertEqual(decoded.read_bytes(), expected, f"mode={mode} profile={profile}")
        self.assertEqual(original.read_bytes(), decoded_original.read_bytes())
        self.assertEqual(coded.read_bytes(), decoded_coded.read_bytes())
        return output, coded

    def test_all_profiles_and_coders_round_trip(self) -> None:
        value = fixture()
        with tempfile.TemporaryDirectory(prefix="round3-native-") as directory:
            root = Path(directory)
            source = root / "input.rsd"
            source.write_bytes(value.data)
            coded_by_profile: dict[int, bytes] = {}
            for profile in range(5):
                rice, rice_audit = self.run_pair(root, 0, profile, source, value.expected)
                rans, rans_audit = self.run_pair(root, 1, profile, source, value.expected)
                self.assertEqual(rice_audit.read_bytes(), rans_audit.read_bytes())
                coded_by_profile[profile] = rans.read_bytes()
            self.assertNotEqual(coded_by_profile[0], coded_by_profile[1],
                                "enabled profile did not change the transmitted artifact")

    def test_header_payload_and_eof_rejection(self) -> None:
        value = fixture()
        with tempfile.TemporaryDirectory(prefix="round3-corrupt-") as directory:
            root = Path(directory)
            source = root / "input.rsd"
            source.write_bytes(value.data)
            output, _ = self.run_pair(root, 1, 1, source, value.expected)
            original = output.read_bytes()

            def reject(data: bytes, label: str) -> None:
                candidate = root / f"{label}.fir"
                candidate.write_bytes(data)
                code, diagnostic = self.command(["decode", str(candidate), str(root / f"{label}.raw"),
                                                 "-", "-", str(root / f"{label}.json")], root)
                self.assertEqual(code, 2, f"{label}: {diagnostic}")

            bad_profile = bytearray(original)
            bad_profile[10] = 5
            reject(bytes(bad_profile), "profile")
            bad_shape = bytearray(original)
            bad_shape[9] = 2
            reject(bytes(bad_shape), "shape")
            bad_reserved = bytearray(original)
            bad_reserved[11] = 1
            reject(bytes(bad_reserved), "reserved")
            reject(original[:-1], "truncated")
            reject(original + b"trailing", "trailing")

            manifest_length = struct.unpack_from("<Q", original, 12)[0]
            table_start = 32 + manifest_length
            bad_table = bytearray(original)
            frequencies = [struct.unpack_from("<H", bad_table, table_start + 3 + 2 * index)[0]
                           for index in range(17)]
            nonzero = next(index for index, frequency in enumerate(frequencies) if frequency)
            first_frequency = frequencies[nonzero]
            struct.pack_into("<H", bad_table, table_start + 3 + 2 * nonzero, first_frequency - 1)
            reject(bytes(bad_table), "table-sum")

            bad_payload = bytearray(original)
            payload_start = table_start + struct.unpack_from("<I", original, 28)[0] * 37
            bad_payload[payload_start + 8] ^= 0x40
            candidate = root / "payload.fir"
            candidate.write_bytes(bad_payload)
            code, diagnostic = self.command(["decode", str(candidate), str(root / "payload.raw"),
                                             "-", "-", str(root / "payload.json")], root)
            self.assertIn(code, (0, 2), diagnostic)
            if code == 0:
                self.assertNotEqual((root / "payload.raw").read_bytes(), value.expected)

            # The second frame is the first predictive frame.  Its first
            # subframe has fixed order zero, one partition, and a three-byte
            # side-information header (8+2+4+5 bits, zero-padded).
            first_frame = table_start + struct.unpack_from("<I", original, 28)[0] * 37
            first_body = struct.unpack_from("<I", original, first_frame)[0]
            predictive_frame = first_frame + 4 + first_body
            body_start = predictive_frame + 4
            side_start = body_start + 4
            side_bytes = 3
            lengths = side_start + side_bytes
            entropy_bytes, bypass_bytes = struct.unpack_from("<II", original, lengths)
            entropy_start = lengths + 8
            bypass_start = entropy_start + entropy_bytes

            bad_manifest = bytearray(original)
            struct.pack_into("<Q", bad_manifest, 12, (1 << 20) + 1)
            reject(bytes(bad_manifest), "oversized-manifest")
            bad_tables = bytearray(original)
            struct.pack_into("<I", bad_tables, 28, 4 * 31 * 5 + 1)
            reject(bytes(bad_tables), "oversized-table-count")
            duplicate = bytearray(original)
            second_key = duplicate[table_start + 37:table_start + 40]
            duplicate[table_start:table_start + 3] = second_key
            reject(bytes(duplicate), "duplicate-table-key")

            bad_role = bytearray(original)
            bad_role[table_start] = 4
            reject(bytes(bad_role), "out-of-range-table-role")
            bad_k = bytearray(original)
            bad_k[table_start + 1] = 31
            reject(bytes(bad_k), "out-of-range-table-k")
            bad_context = bytearray(original)
            bad_context[table_start + 2] = 5
            reject(bytes(bad_context), "out-of-range-table-context")
            unsorted = bytearray(original)
            first_table = bytes(unsorted[table_start:table_start + 37])
            second_table = bytes(unsorted[table_start + 37:table_start + 74])
            unsorted[table_start:table_start + 37] = second_table
            unsorted[table_start + 37:table_start + 74] = first_table
            reject(bytes(unsorted), "unsorted-table-keys")

            bad_state = bytearray(original)
            struct.pack_into("<I", bad_state, entropy_start, 0x80000000)
            reject(bytes(bad_state), "invalid-initial-rans-state")
            bad_terminal = bytearray(original)
            bad_terminal[entropy_start + entropy_bytes - 1] ^= 1
            reject(bytes(bad_terminal), "invalid-terminal-rans-state")

            bad_padding = bytearray(original)
            bad_padding[side_start + side_bytes - 1] |= 1
            reject(bytes(bad_padding), "nonzero-side-padding")
            bad_flags = bytearray(original)
            bad_flags[body_start + 3] = 1
            reject(bytes(bad_flags), "nonzero-frame-flags")
            bad_frame_length = bytearray(original)
            struct.pack_into("<I", bad_frame_length, predictive_frame, 4 * 1024 * 1024 + 1)
            reject(bytes(bad_frame_length), "oversized-frame-body")
            bad_subframe_length = bytearray(original)
            struct.pack_into("<I", bad_subframe_length, lengths, 4 * 1024 * 1024 + 1)
            reject(bytes(bad_subframe_length), "oversized-subframe-entropy")

            # Replacing the ordinary Rice2 k with escape 31 must be rejected
            # by round 3 even when the following five bits happen to decode as
            # raw width zero.
            bad_escape = bytearray(original)
            put_bits(bad_escape, side_start * 8 + 14, 5, 31)
            reject(bytes(bad_escape), "round3-raw-escape")


if __name__ == "__main__":
    options = argparse.ArgumentParser(add_help=False)
    options.add_argument("--helper")
    native_args, unittest_args = options.parse_known_args()
    if native_args.helper:
        os.environ["ROUND3_HELPER"] = native_args.helper
    sys.argv = [sys.argv[0], *unittest_args]
    unittest.main()
