#!/usr/bin/env python3
"""Synthetic and adversarial gates for the round-01 native record decoder.

The fixtures in this file are deliberately written independently of libFLAC.
Each expected PCM sequence is explicit; the small residual builders only
serialize a selected predictor representation for that sequence.  The native
decoder is therefore tested against known PCM rather than against a second
implementation of the decoder.

Usage:

    python3 test_native.py [--helper /path/to/round1-helper]

The helper may also be supplied with ROUND1_HELPER.  No files are left in the
repository: every record and decoded PCM file is made in a TemporaryDirectory.
Point --helper at a separately compiled ASan/UBSan helper to run the same
synthetic gates under sanitizers; the default path is intended for ordinary
optimized runs.
"""

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


MAGIC = b"I77RSD01"
MAX_RECORD = 1024 * 1024
S24_MIN = -(1 << 23)
S24_MAX = (1 << 23) - 1
ESCAPE_RICE2 = 31


def _p(fmt: str, *values: int) -> bytes:
    return struct.pack("<" + fmt, *values)


def _s24(value: int) -> bytes:
    if not S24_MIN <= value <= S24_MAX:
        raise ValueError(f"outside signed 24-bit range: {value}")
    return _p("I", value & 0xFFFFFF)[:3]


def pcm_bytes(left: list[int], right: list[int]) -> bytes:
    if len(left) != len(right):
        raise ValueError("channel lengths differ")
    return b"".join(_s24(l) + _s24(r) for l, r in zip(left, right))


def _stored(values: list[int], wasted: int) -> list[int]:
    if wasted < 0:
        raise ValueError("negative wasted bits")
    divisor = 1 << wasted
    if any(value % divisor for value in values):
        raise ValueError("wasted bits require every sample to be divisible")
    return [value // divisor for value in values]


def _fixed_prediction(history: list[int], order: int) -> int:
    if order == 0:
        return 0
    if order == 1:
        return history[-1]
    if order == 2:
        return 2 * history[-1] - history[-2]
    if order == 3:
        return 3 * history[-1] - 3 * history[-2] + history[-3]
    if order == 4:
        return 4 * history[-1] - 6 * history[-2] + 4 * history[-3] - history[-4]
    raise ValueError("fixed order must be 0..4")


def _lpc_prediction(history: list[int], coefficients: list[int], shift: int) -> int:
    value = sum(coefficient * history[-1 - index]
                for index, coefficient in enumerate(coefficients))
    if shift >= 0:
        # Python // is floor division, which is the FLAC arithmetic shift for
        # negative values and makes the expected value independent of C shifts.
        return value // (1 << shift)
    return value * (1 << -shift)


def _residuals(values: list[int], order: int, kind: str,
               coefficients: list[int] | None = None, shift: int = 0) -> tuple[list[int], list[int]]:
    if order > len(values):
        raise ValueError("predictor order exceeds block")
    warmup = values[:order]
    residuals: list[int] = []
    history = list(warmup)
    for value in values[order:]:
        if kind == "fixed":
            prediction = _fixed_prediction(history, order)
        elif kind == "lpc":
            if coefficients is None or len(coefficients) != order:
                raise ValueError("LPC coefficient count does not match order")
            prediction = _lpc_prediction(history, coefficients, shift)
        else:
            raise ValueError(f"unknown residual predictor: {kind}")
        residuals.append(value - prediction)
        history.append(value)
    return warmup, residuals


def sf_constant(values: list[int], wasted: int = 0) -> bytes:
    if not values or any(value != values[0] for value in values):
        raise ValueError("constant subframe values differ")
    stored = _stored(values, wasted)
    return (_p("8B", 0, wasted, 0, 0, 0, 255, 0, 0) +
            _p("II", 1, 0) + _p("i", stored[0]))


def sf_verbatim(values: list[int], wasted: int = 0) -> bytes:
    stored = _stored(values, wasted)
    return (_p("8B", 1, wasted, 0, 0, 0, 255, 0, 0) +
            _p("II", len(stored), 0) +
            b"".join(_p("i", value) for value in stored))


def sf_residual(values: list[int], *, kind: str, order: int,
                method: int = 0, partition_order: int = 0,
                parameters: list[int] | None = None,
                raw_widths: list[int] | None = None, wasted: int = 0,
                coefficients: list[int] | None = None, shift: int = 0) -> bytes:
    stored = _stored(values, wasted)
    warmup, residuals = _residuals(stored, order, kind, coefficients, shift)
    partitions = 1 << partition_order
    if parameters is None:
        parameters = [0] * partitions
    if raw_widths is None:
        raw_widths = [0] * partitions
    if len(parameters) != partitions or len(raw_widths) != partitions:
        raise ValueError("partition table length does not match partition order")
    if kind == "fixed":
        type_code, precision = 2, 0
    elif kind == "lpc":
        type_code = 3
        if coefficients is None:
            raise ValueError("LPC coefficients are required")
        precision = 12
    else:
        raise ValueError("residual subframe kind must be fixed or lpc")
    if not -128 <= shift <= 127:
        raise ValueError("shift does not fit serialized signed byte")
    out = bytearray(_p("8B", type_code, wasted, order, precision, shift & 0xFF,
                       method, partition_order, 0))
    out += _p("II", len(residuals), partitions)
    out += b"".join(_p("i", value) for value in warmup)
    if kind == "lpc":
        out += b"".join(_p("i", coefficient) for coefficient in coefficients or [])
    out += b"".join(_p("BBH", parameter, raw_width, 0)
                     for parameter, raw_width in zip(parameters, raw_widths))
    out += b"".join(_p("i", residual) for residual in residuals)
    return bytes(out)


def _manifest(frame_count: int) -> bytes:
    """Return a compact, deterministic sparse-stem manifest for a fixture."""
    zero_hash = "0" * 64
    value = {
        "bitDepth": 24,
        "channels": 2,
        "chunks": [{
            "bytes": 1,
            "flacSha256": zero_hash,
            "frames": frame_count,
            "offset": 0,
            "packedStartFrame": 0,
            "pcmSha256": zero_hash,
        }],
        "format": "miso_sparse_stem_v1",
        "frames": frame_count,
        "identity": "sha256:" + zero_hash,
        "intervals": [{"frames": frame_count, "packedFrameOffset": 0, "startFrame": 0}],
        "sampleRateHz": 44100,
    }
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def record(subframes: tuple[bytes, bytes], blocksize: int, assignment: int = 0,
           *, chunk: int = 0, packed: int = 0, offset: int = 1,
           frame_bytes: int = 1, reserved: int = 0) -> bytes:
    if blocksize <= 0:
        raise ValueError("blocksize must be positive")
    body = (_p("IQQII", chunk, packed, offset, frame_bytes, blocksize) +
            _p("4B", assignment, 2, 24, reserved) + subframes[0] + subframes[1])
    return _p("I", len(body)) + body


def record_file(records: list[bytes]) -> bytes:
    frame_count = 0
    normalized: list[bytes] = []
    packed = 0
    for index, item in enumerate(records):
        if len(item) < 4 + 32:
            raise ValueError("record is shorter than its prefix")
        frame_count += struct.unpack_from("<I", item, 4 + 24)[0]
        # A multi-record diagnostic stream is one contiguous packed chunk.
        # Normalize the synthetic record cursors here so every transition is
        # checked by the native decoder.  Standalone records retain their
        # caller-supplied values because no transition is involved.
        if len(records) > 1:
            mutable = bytearray(item)
            body = 4
            blocksize = struct.unpack_from("<I", mutable, body + 24)[0]
            struct.pack_into("<Q", mutable, body + 4, packed)
            struct.pack_into("<Q", mutable, body + 12, index + 1)
            normalized.append(bytes(mutable))
            packed += blocksize
        else:
            normalized.append(item)
    manifest = _manifest(frame_count)
    return MAGIC + _p("QQ", len(manifest), len(records)) + manifest + b"".join(normalized)


def _case(name: str, left: list[int], right: list[int], sf0: bytes, sf1: bytes,
          assignment: int = 0) -> tuple[str, bytes, bytes]:
    item = record((sf0, sf1), len(left), assignment)
    return name, item, pcm_bytes(left, right)


def valid_cases() -> list[tuple[str, bytes, bytes]]:
    cases: list[tuple[str, bytes, bytes]] = []

    cases.append(_case("constant", [7, 7, 7], [-4, -4, -4],
                       sf_constant([7, 7, 7]), sf_constant([-4, -4, -4])))
    cases.append(_case("verbatim_extrema_lsb", [S24_MIN, S24_MAX, -1, 0, 1],
                       [S24_MAX, S24_MIN, 2, -2, 0],
                       sf_verbatim([S24_MIN, S24_MAX, -1, 0, 1]),
                       sf_verbatim([S24_MAX, S24_MIN, 2, -2, 0])))

    fixed_sequences = {
        # Eight samples keep partition order 2 structurally valid: blocksize
        # is divisible by four and partition zero still covers any warmups.
        0: ([0, 1, -1, 2, -2, 3, -4, 5], [5, 4, 6, 3, 7, 2, 8, 1]),
        1: ([3, 3, 4, 6, 9, 13, 18, 24],
            [-2, -2, -1, 1, 4, 8, 13, 19]),
        2: ([1, 4, 9, 16, 25, 36, 49, 64], [8, 5, 4, 5, 8, 13, 20, 29]),
        3: ([-5, -2, 4, 13, 25, 40, 58, 79, 103, 130],
            [6, 4, 3, 4, 7, 12, 19, 28, 39, 52]),
        4: ([1, 2, 4, 8, 16, 31, 57, 96, 146, 211, 295, 400],
            [400, 295, 211, 146, 96, 57, 31, 16, 8, 4, 2, 1]),
    }
    for order, (left, right) in fixed_sequences.items():
        partition_order = 1 if order else 2
        partitions = 1 << partition_order
        # Parameters are metadata for this diagnostic record; residuals are
        # still stored explicitly.  The table includes different k values.
        params = list(range(partitions))
        cases.append(_case(
            f"fixed{order}", left, right,
            sf_residual(left, kind="fixed", order=order,
                        partition_order=partition_order, parameters=params),
            sf_residual(right, kind="fixed", order=order,
                        partition_order=partition_order, parameters=params)))

    lpc_left = [-7, 4, 12, -5, 9, 23, -11, 17, 31, 42]
    lpc_right = [11, -3, 8, 20, -4, -16, 7, 19, -2, 12]
    cases.append(_case(
        "lpc", lpc_left, lpc_right,
        sf_residual(lpc_left, kind="lpc", order=2, coefficients=[3, -2], shift=1,
                    partition_order=1, parameters=[1, 2]),
        sf_residual(lpc_right, kind="lpc", order=2, coefficients=[-2, 1], shift=-1,
                    partition_order=1, parameters=[1, 2])))

    # All four assignments use explicit left/right PCM.  LEFT_SIDE,
    # RIGHT_SIDE, and MID_SIDE include a negative odd side value (-7).
    stereo_left = [-10, -11, 7, 12]
    stereo_right = [-3, -4, 2, -8]
    side = [left - right for left, right in zip(stereo_left, stereo_right)]
    mid = [(left + right) // 2 for left, right in zip(stereo_left, stereo_right)]
    cases.append(_case("stereo_independent", stereo_left, stereo_right,
                       sf_verbatim(stereo_left), sf_verbatim(stereo_right), 0))
    cases.append(_case("stereo_left_side", stereo_left, stereo_right,
                       sf_verbatim(stereo_left), sf_verbatim(side), 1))
    cases.append(_case("stereo_right_side", stereo_left, stereo_right,
                       sf_verbatim(side), sf_verbatim(stereo_right), 2))
    cases.append(_case("stereo_mid_side", stereo_left, stereo_right,
                       sf_verbatim(mid), sf_verbatim(side), 3))

    wasted_left = [S24_MIN, 8388606, 0, 2]
    wasted_right = [-2, 4, 8388604, 0]
    cases.append(_case("wasted_bits", wasted_left, wasted_right,
                       sf_residual(wasted_left, kind="fixed", order=0, wasted=1),
                       sf_residual(wasted_right, kind="fixed", order=0, wasted=1)))

    # Rice2 with a raw-escape partition of width zero is valid when the two
    # residuals in that partition are zero.  The four partitions deliberately
    # carry differing k values and exercise short partition zero handling.
    partition_left = [0, 0, 1, -1, 2, -2, 0, 0]
    partition_right = [0, 0, -1, 1, 3, -3, 0, 0]
    rice2_params = [0, 1, 2, ESCAPE_RICE2]
    rice2_raw = [0, 0, 0, 0]
    cases.append(_case(
        "rice2_rawescape_width0_partitions", partition_left, partition_right,
        sf_residual(partition_left, kind="fixed", order=0, method=1,
                    partition_order=2, parameters=rice2_params, raw_widths=rice2_raw),
        sf_residual(partition_right, kind="fixed", order=0, method=1,
                    partition_order=2, parameters=rice2_params, raw_widths=rice2_raw)))

    cases.append(_case("short_block_constant", [S24_MIN], [S24_MAX],
                       sf_constant([S24_MIN]), sf_constant([S24_MAX])))
    short_left = [5, 9]
    short_right = [-7, -2]
    cases.append(_case("short_block_fixed_order1", short_left, short_right,
                       sf_residual(short_left, kind="fixed", order=1),
                       sf_residual(short_right, kind="fixed", order=1)))
    return cases


def _header_offsets(data: bytes) -> tuple[int, int]:
    manifest_length = struct.unpack_from("<Q", data, 8)[0]
    return 24 + manifest_length, 24 + manifest_length + 4


def _single_case(name: str) -> tuple[bytes, bytes]:
    for candidate, item, expected in valid_cases():
        if candidate == name:
            return record_file([item]), expected
    raise KeyError(name)


class NativeDecoderTests(unittest.TestCase):
    helper: Path

    @classmethod
    def setUpClass(cls) -> None:
        parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
        parser.add_argument("--helper")
        args, _ = parser.parse_known_args()
        configured = args.helper or os.environ.get("ROUND1_HELPER")
        cls.helper = Path(configured or "/data/issue-77-lossless/iterations/round-01/round1-helper")
        if not cls.helper.is_file() or not os.access(cls.helper, os.X_OK):
            raise AssertionError(f"native helper not executable: {cls.helper}")

    def _decode(self, data: bytes) -> tuple[int, bytes, str]:
        with tempfile.TemporaryDirectory(prefix="round1-native-test-") as directory:
            root = Path(directory)
            records = root / "fixture.rsd"
            output = root / "output.raw"
            summary = root / "decode.json"
            records.write_bytes(data)
            completed = subprocess.run(
                [str(self.helper), "decode", str(records), str(output), str(summary)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            output_bytes = output.read_bytes() if output.exists() else b""
            diagnostic = (completed.stdout or "") + (completed.stderr or "")
            return completed.returncode, output_bytes, diagnostic

    @staticmethod
    def _assert_no_sanitizer_diagnostic(diagnostic: str, label: str) -> None:
        markers = (
            "AddressSanitizer",
            "UndefinedBehaviorSanitizer",
            "runtime error:",
            "LeakSanitizer",
            "SUMMARY: UndefinedBehaviorSanitizer",
        )
        present = [marker for marker in markers if marker in diagnostic]
        if present:
            raise AssertionError(f"{label} emitted sanitizer diagnostic(s): {present}: {diagnostic}")

    def _assert_valid(self, data: bytes, expected: bytes, label: str) -> None:
        code, actual, diagnostic = self._decode(data)
        self._assert_no_sanitizer_diagnostic(diagnostic, label)
        self.assertEqual(code, 0, f"{label} rejected: {diagnostic}")
        self.assertEqual(actual, expected, f"{label} PCM mismatch")

    def _assert_clean_reject(self, data: bytes, label: str) -> None:
        code, _, diagnostic = self._decode(data)
        self._assert_no_sanitizer_diagnostic(diagnostic, label)
        self.assertEqual(code, 2, f"{label} did not cleanly reject (code={code}): {diagnostic}")

    def _assert_bad_or_hash_mismatch(self, data: bytes, expected: bytes, label: str) -> None:
        code, actual, diagnostic = self._decode(data)
        self._assert_no_sanitizer_diagnostic(diagnostic, label)
        self.assertIn(code, (0, 2), f"{label} failed unclearly (code={code}): {diagnostic}")
        if code == 0:
            self.assertNotEqual(actual, expected,
                                f"{label} was accepted with verified PCM")

    def test_valid_synthetic_modes_and_transitions(self) -> None:
        cases = valid_cases()
        data = record_file([item for _, item, _ in cases])
        expected = b"".join(pcm for _, _, pcm in cases)
        self._assert_valid(data, expected, "synthetic mode matrix")

    def test_truncation_and_trailing_bytes_rejected(self) -> None:
        data, expected = _single_case("verbatim_extrema_lsb")
        self._assert_clean_reject(data[:-1], "truncation")
        self._assert_clean_reject(data + b"trailing", "trailing bytes")
        self.assertGreater(len(expected), 0)

    def test_oversized_record_rejected(self) -> None:
        data, expected = _single_case("constant")
        _, first_record = _header_offsets(data)
        mutated = bytearray(data)
        struct.pack_into("<I", mutated, first_record - 4, MAX_RECORD + 1)
        self._assert_clean_reject(bytes(mutated), "oversized record length")
        self.assertGreater(len(expected), 0)

    def test_inconsistent_sample_and_partition_fields_rejected(self) -> None:
        data, _ = _single_case("constant")
        _, first_record = _header_offsets(data)
        # The first subframe starts after the 32-byte record frame prefix.
        sf0 = first_record + 32
        bad_count = bytearray(data)
        struct.pack_into("<I", bad_count, sf0 + 8, 2)
        self._assert_clean_reject(bytes(bad_count), "inconsistent constant sample count")

        fixed, _ = _single_case("fixed2")
        _, fixed_record = _header_offsets(fixed)
        fixed_sf0 = fixed_record + 32
        bad_partitions = bytearray(fixed)
        # partition_count is the second u32 in the 16-byte subframe header.
        old = struct.unpack_from("<I", bad_partitions, fixed_sf0 + 12)[0]
        struct.pack_into("<I", bad_partitions, fixed_sf0 + 12, old + 1)
        self._assert_clean_reject(bytes(bad_partitions), "inconsistent partition count")

        bad_order = bytearray(fixed)
        bad_order[fixed_sf0 + 2] = 5
        self._assert_clean_reject(bytes(bad_order), "predictor order beyond fixed order")

    def test_reserved_fields_rejected(self) -> None:
        data, _ = _single_case("fixed0")
        _, first_record = _header_offsets(data)
        sf0 = first_record + 32

        bad_record_reserved = bytearray(data)
        bad_record_reserved[first_record + 31] = 1
        self._assert_clean_reject(bytes(bad_record_reserved), "nonzero record reserved field")

        bad_subframe_reserved = bytearray(data)
        bad_subframe_reserved[sf0 + 7] = 1
        self._assert_clean_reject(bytes(bad_subframe_reserved), "nonzero subframe reserved field")

        bad_partition_reserved = bytearray(data)
        # fixed0 has partition order 2 and no warmups/coefficients.  Its first
        # partition entry begins directly after the 16-byte subframe header.
        bad_partition_reserved[sf0 + 16 + 2] = 1
        self._assert_clean_reject(bytes(bad_partition_reserved), "nonzero partition reserved field")

    def test_predictor_partition_and_escape_metadata_rejected(self) -> None:
        fixed, _ = _single_case("fixed4")
        _, fixed_record = _header_offsets(fixed)
        fixed_sf0 = fixed_record + 32

        # Fixed predictors are defined only for orders 0..4.  Keep count
        # consistent with the mutated order so this exercises the predictor
        # order bound rather than only the sample-count check.
        bad_fixed_order = bytearray(fixed)
        bad_fixed_order[fixed_sf0 + 2] = 5
        struct.pack_into("<I", bad_fixed_order, fixed_sf0 + 8, 7)
        self._assert_clean_reject(bytes(bad_fixed_order), "fixed order 5")

        # For blocksize 12/order 4, partition order 2 would make the first
        # partition contain only three slots, fewer than the four warmups.
        bad_first_partition = bytearray(fixed)
        bad_first_partition[fixed_sf0 + 6] = 2
        struct.pack_into("<I", bad_first_partition, fixed_sf0 + 12, 4)
        self._assert_clean_reject(bytes(bad_first_partition),
                                  "partition zero shorter than predictor warmup")

        lpc, _ = _single_case("lpc")
        _, lpc_record = _header_offsets(lpc)
        lpc_sf0 = lpc_record + 32

        # LPC order zero is not a valid LPC predictor.  Keep the declared
        # sample count equal to the blocksize while probing the order bound.
        bad_lpc_order = bytearray(lpc)
        bad_lpc_order[lpc_sf0 + 2] = 0
        struct.pack_into("<I", bad_lpc_order, lpc_sf0 + 8, 9)
        self._assert_clean_reject(bytes(bad_lpc_order), "LPC order zero")

        # Twelve-bit LPC coefficients are signed, so 2048 is outside the
        # representable coefficient range for this otherwise valid fixture.
        bad_coefficient = bytearray(lpc)
        coefficient = lpc_sf0 + 16 + 2 * 4
        struct.pack_into("<i", bad_coefficient, coefficient, 2048)
        self._assert_clean_reject(bytes(bad_coefficient),
                                  "LPC coefficient outside declared precision")

        raw_escape, _ = _single_case("rice2_rawescape_width0_partitions")
        _, raw_record = _header_offsets(raw_escape)
        raw_sf0 = raw_record + 32
        # The last (raw escape width 0) partition starts at residual six;
        # any nonzero residual cannot fit a zero-bit signed field.
        bad_zero_width_residual = bytearray(raw_escape)
        residual_start = raw_sf0 + 16 + 4 * 4
        struct.pack_into("<i", bad_zero_width_residual, residual_start + 6 * 4, 1)
        self._assert_clean_reject(bytes(bad_zero_width_residual),
                                  "nonzero residual in raw escape width zero")

        # A blocksize must be divisible by its partition count.  fixed0 is an
        # eight-sample, four-partition fixture; changing only the blocksize to
        # seven makes the stream structurally inconsistent.
        bad_divisibility = bytearray(_single_case("fixed0")[0])
        _, div_record = _header_offsets(bytes(bad_divisibility))
        div_sf0 = div_record + 32
        struct.pack_into("<I", bad_divisibility, div_record + 24, 7)
        struct.pack_into("<I", bad_divisibility, div_sf0 + 8, 7)
        self._assert_clean_reject(bytes(bad_divisibility),
                                  "blocksize not divisible by partition count")

    def test_altered_lpc_coefficient_and_residual_never_verify(self) -> None:
        data, expected = _single_case("lpc")
        _, first_record = _header_offsets(data)
        sf0 = first_record + 32
        # LPC header (16), two warmups (8), then two i32 coefficients.
        coefficient = sf0 + 16 + 2 * 4
        bad_coefficient = bytearray(data)
        bad_coefficient[coefficient] ^= 1
        self._assert_bad_or_hash_mismatch(bytes(bad_coefficient), expected,
                                          "altered LPC coefficient")

        # The first residual follows the two coefficients and two partition
        # table entries (16 + warmups + coeffs + 8).
        residual = sf0 + 16 + 2 * 4 + 2 * 4 + 2 * 4
        bad_residual = bytearray(data)
        bad_residual[residual] ^= 1
        self._assert_bad_or_hash_mismatch(bytes(bad_residual), expected,
                                          "altered residual")

    def test_invalid_lpc_shift_and_predictor_overflow_rejected(self) -> None:
        data, _ = _single_case("lpc")
        _, first_record = _header_offsets(data)
        sf0 = first_record + 32
        invalid_shift = bytearray(data)
        # Signed serialized shift is outside FLAC's five-bit [-16, 15] range.
        invalid_shift[sf0 + 4] = 16
        self._assert_clean_reject(bytes(invalid_shift),
                                  "LPC shift outside five-bit range")

        raw_escape, _ = _single_case("rice2_rawescape_width0_partitions")
        _, raw_record = _header_offsets(raw_escape)
        raw_sf0 = raw_record + 32
        invalid_raw_width = bytearray(raw_escape)
        # Rice2 partition 3 is the raw-escape partition.  Its entry is after
        # the 16-byte subframe header and three preceding four-byte entries.
        invalid_raw_width[raw_sf0 + 16 + 3 * 4 + 1] = 32
        self._assert_clean_reject(bytes(invalid_raw_width),
                                  "raw escape width 32")

        # A maliciously shaped LPC record with two INT32_MAX warmups and
        # coefficients overflows the checked i64 predictor sum before the
        # eventual 24-bit range check.  It must not produce verified output.
        overflow = bytearray(data)
        warmup = sf0 + 16
        coefficient = sf0 + 16 + 2 * 4
        struct.pack_into("<ii", overflow, warmup, 0x7FFFFFFF, 0x7FFFFFFF)
        struct.pack_into("<ii", overflow, coefficient, 0x7FFFFFFF, 0x7FFFFFFF)
        expected = _single_case("lpc")[1]
        self._assert_bad_or_hash_mismatch(bytes(overflow), expected,
                                          "LPC predictor overflow")


def main(argv: list[str] | None = None) -> int:
    # unittest consumes --helper only through setUpClass's parse_known_args;
    # remove it here so unittest does not interpret it as a test selector.
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--helper")
    args, remaining = parser.parse_known_args(argv)
    if args.helper:
        os.environ["ROUND1_HELPER"] = args.helper
    unittest_argv = [sys.argv[0]] + remaining
    return 0 if unittest.main(argv=unittest_argv, exit=False).result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
