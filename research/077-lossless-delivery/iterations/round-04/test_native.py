#!/usr/bin/env python3
"""Focused round-4 native round-trip and malformed-frame gates."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

RSD_MAGIC = b"I77RSD01"
R4_MAGIC = b"I77XCH04"
S24_MIN = -(1 << 23)
S24_MAX = (1 << 23) - 1


def s24(value: int) -> bytes:
    if not S24_MIN <= value <= S24_MAX:
        raise ValueError(value)
    return struct.pack("<I", value & 0xFFFFFF)[:3]


def pcm(left: list[int], right: list[int]) -> bytes:
    return b"".join(s24(a) + s24(b) for a, b in zip(left, right))


def old_fixture() -> tuple[bytes, bytes]:
    import importlib.util
    path = Path(__file__).parents[1] / "round-03" / "test_native.py"
    spec = importlib.util.spec_from_file_location("round3_fixture", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    value = module.fixture()
    return value.data, value.expected


def fixed_subframe(values: list[int]) -> bytes:
    blocksize = len(values)
    header = struct.pack("<8BII", 2, 0, 0, 0, 0, 1, 0, 0, blocksize, 1)
    return header + struct.pack("<BBH", 0, 0, 0) + struct.pack(f"<{blocksize}i", *values)


def correlated_fixture() -> tuple[bytes, bytes]:
    left = [((index % 31) - 15) * 997 for index in range(64)]
    right = [2 * value for value in left]
    blocksize = len(left)
    manifest_value = {
        "bitDepth": 24, "channels": 2,
        "chunks": [{"bytes": blocksize * 6, "flacSha256": "0" * 64,
                     "frames": blocksize, "offset": 0, "packedStartFrame": 0,
                     "pcmSha256": "0" * 64}],
        "format": "miso_sparse_stem_v1", "frames": blocksize,
        "identity": "sha256:" + "0" * 64,
        "intervals": [{"frames": blocksize, "packedFrameOffset": 0, "startFrame": 0}],
        "sampleRateHz": 44100,
    }
    manifest = json.dumps(manifest_value, separators=(",", ":"), sort_keys=True).encode()
    body = struct.pack("<IQQII4B", 0, 0, 0, 1, blocksize, 0, 2, 24, 0)
    body += fixed_subframe(left) + fixed_subframe(right)
    rsd = RSD_MAGIC + struct.pack("<QQ", len(manifest), 1) + manifest
    rsd += struct.pack("<I", len(body)) + body
    return rsd, pcm(left, right)


class NativeRound4Tests(unittest.TestCase):
    helper: Path

    @classmethod
    def setUpClass(cls) -> None:
        parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
        parser.add_argument("--helper")
        args, _ = parser.parse_known_args()
        configured = args.helper or os.environ.get("ROUND4_HELPER")
        cls.helper = Path(configured or "/data/issue-77-lossless/iterations/round-04/round4-helper")
        if not cls.helper.is_file() or not os.access(cls.helper, os.X_OK):
            raise AssertionError(f"native round4 helper not executable: {cls.helper}")

    def command(self, args: list[str], cwd: Path) -> tuple[int, str]:
        result = subprocess.run([str(self.helper), *args], cwd=cwd,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, check=False)
        diagnostic = (result.stdout or "") + (result.stderr or "")
        for marker in ("AddressSanitizer", "UndefinedBehaviorSanitizer", "runtime error:",
                       "LeakSanitizer", "SUMMARY: UndefinedBehaviorSanitizer"):
            self.assertNotIn(marker, diagnostic, diagnostic)
        return result.returncode, diagnostic

    def pair(self, root: Path, source: Path, expected: bytes, mode: int, profile: int) -> Path:
        stem = root / f"m{mode}-p{profile}"
        output, original, coded, enc_summary = (stem.with_suffix(suffix)
                                                for suffix in (".xch", ".oa", ".ca", ".e.json"))
        decoded, decoded_original, decoded_coded, dec_summary = (stem.with_suffix(suffix)
                                                                  for suffix in (".raw", ".doa", ".dca", ".d.json"))
        code, diagnostic = self.command(["encode", str(source), str(output), str(original),
                                         str(coded), str(enc_summary), str(mode), str(profile)], root)
        self.assertEqual(code, 0, diagnostic)
        code, diagnostic = self.command(["decode", str(output), str(decoded), str(decoded_original),
                                         str(decoded_coded), str(dec_summary)], root)
        self.assertEqual(code, 0, diagnostic)
        self.assertEqual(decoded.read_bytes(), expected)
        self.assertEqual(original.read_bytes(), decoded_original.read_bytes())
        self.assertEqual(coded.read_bytes(), decoded_coded.read_bytes())
        enc = json.loads(enc_summary.read_text())
        dec = json.loads(dec_summary.read_text())
        for field in ("frameBytes", "sideBytes", "entropyBytes", "bypassBytes", "coefficientBytes",
                      "disabledFrames", "reference0Frames", "reference1Frames",
                      "predictionClamp", "modularWrap"):
            self.assertEqual(enc[field], dec[field], field)
        return output

    def test_round_trip_matrix_and_spatial_selection(self) -> None:
        source_data, expected = old_fixture()
        correlated_data, correlated_expected = correlated_fixture()
        with tempfile.TemporaryDirectory(prefix="round4-native-") as directory:
            root = Path(directory)
            source = root / "input.rsd"; source.write_bytes(source_data)
            for profile in range(3):
                for mode in range(2):
                    self.pair(root, source, expected, mode, profile)
            correlated = root / "correlated.rsd"; correlated.write_bytes(correlated_data)
            for mode in range(2):
                for profile in (1, 2):
                    output = self.pair(root, correlated, correlated_expected, mode, profile)
                    raw = output.read_bytes()
                    manifest_length = struct.unpack_from("<Q", raw, 12)[0]
                    tables = struct.unpack_from("<I", raw, 28)[0]
                    frame_start = 32 + manifest_length + tables * 37
                    body_length = struct.unpack_from("<I", raw, frame_start)[0]
                    self.assertIn(raw[frame_start + 4 + 3], (1, 2))
                    self.assertGreater(body_length, 4)

    def test_header_selector_coefficient_and_eof_rejection(self) -> None:
        source_data, expected = correlated_fixture()
        with tempfile.TemporaryDirectory(prefix="round4-corrupt-") as directory:
            root = Path(directory)
            source = root / "input.rsd"; source.write_bytes(source_data)
            output = self.pair(root, source, expected, 0, 1)
            original = output.read_bytes()
            manifest_length = struct.unpack_from("<Q", original, 12)[0]
            tables = struct.unpack_from("<I", original, 28)[0]
            frame_start = 32 + manifest_length + tables * 37
            body_length = struct.unpack_from("<I", original, frame_start)[0]
            body_start = frame_start + 4
            self.assertIn(original[body_start + 3], (1, 2))

            def reject(data: bytes, label: str) -> None:
                candidate = root / f"{label}.xch"; candidate.write_bytes(data)
                code, diagnostic = self.command(["decode", str(candidate), str(root / f"{label}.raw"),
                                                 "-", "-", str(root / f"{label}.json")], root)
                self.assertEqual(code, 2, f"{label}: {diagnostic}")

            bad = bytearray(original); bad[10] = 3; reject(bytes(bad), "profile")
            bad = bytearray(original); bad[9] = 2; reject(bytes(bad), "shape")
            bad = bytearray(original); bad[11] = 1; reject(bytes(bad), "reserved")
            bad = bytearray(original); bad[body_start + 3] = 3; reject(bytes(bad), "selector")
            taps = 1 if original[10] == 1 else 5
            bad = bytearray(original)
            struct.pack_into("<h", bad, body_start + 4, 16385)
            reject(bytes(bad), "coefficient-range")
            bad = bytearray(original)
            for index in range(taps):
                struct.pack_into("<h", bad, body_start + 4 + 2 * index, 0)
            reject(bytes(bad), "zero-coefficients")
            reject(original[:body_start + 4 + 1], "truncated-coefficient")
            reject(original[:-1], "truncated")
            reject(original + b"trailing", "trailing")
            bad = bytearray(original)
            bad[body_start + 4 + 2 * taps + 11] ^= 0x80
            reject(bytes(bad), "payload-corruption")

            p0 = self.pair(root, source, expected, 0, 0)
            p0_data = bytearray(p0.read_bytes())
            p0_manifest = struct.unpack_from("<Q", p0_data, 12)[0]
            p0_tables = struct.unpack_from("<I", p0_data, 28)[0]
            p0_frame = 32 + p0_manifest + p0_tables * 37
            p0_data[p0_frame + 4 + 3] = 1
            reject(bytes(p0_data), "disabled-profile-selector")

            rans = self.pair(root, source, expected, 1, 2)
            rans_data = rans.read_bytes()
            rans_manifest = struct.unpack_from("<Q", rans_data, 12)[0]
            rans_tables = struct.unpack_from("<I", rans_data, 28)[0]
            self.assertGreaterEqual(rans_tables, 2)
            table_start = 32 + rans_manifest
            bad_table = bytearray(rans_data)
            first_frequency = struct.unpack_from("<H", bad_table, table_start + 3)[0]
            self.assertGreater(first_frequency, 0)
            struct.pack_into("<H", bad_table, table_start + 3, first_frequency - 1)
            reject(bytes(bad_table), "rans-table-sum")
            duplicate = bytearray(rans_data)
            duplicate[table_start:table_start + 3] = duplicate[table_start + 37:table_start + 40]
            reject(bytes(duplicate), "rans-duplicate-key")


if __name__ == "__main__":
    options = argparse.ArgumentParser(add_help=False)
    options.add_argument("--helper")
    native_args, unittest_args = options.parse_known_args()
    if native_args.helper:
        os.environ["ROUND4_HELPER"] = native_args.helper
    sys.argv = [sys.argv[0], *unittest_args]
    unittest.main()
