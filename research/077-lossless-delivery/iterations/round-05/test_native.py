#!/usr/bin/env python3
"""Independent round-5 integer, pipeline, round-trip, and malformed gates."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

RSD_MAGIC = b"I77RSD01"
S24_MIN = -(1 << 23)
S24_MAX = (1 << 23) - 1
I32_MIN = -(1 << 31)
I32_MAX = (1 << 31) - 1
Q20 = 1 << 20
R4_COEFF_LIMIT = 16384


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


def old_fixture() -> tuple[bytes, bytes]:
    path = Path(__file__).parents[1] / "round-04" / "test_native.py"
    spec = importlib.util.spec_from_file_location("round4_fixture_for_round5", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.old_fixture()


def fixed_subframe(values: list[int]) -> bytes:
    blocksize = len(values)
    header = struct.pack("<8BII", 2, 0, 0, 0, 0, 1, 0, 0, blocksize, 1)
    return header + struct.pack("<BBH", 0, 0, 0) + struct.pack(f"<{blocksize}i", *values)


def rsd_fixture(left: list[int], right: list[int]) -> tuple[bytes, bytes]:
    if len(left) != len(right) or not left:
        raise ValueError("equal nonempty channels required")
    blocksize = len(left)
    manifest_value = {
        "bitDepth": 24,
        "channels": 2,
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


def stacked_fixture() -> tuple[bytes, bytes]:
    left = [32 * (i + 1) for i in range(16)]
    right = [2 * value for value in left]
    return rsd_fixture(left, right)


def trunc_div(numerator: int, denominator: int) -> int:
    sign = -1 if numerator < 0 else 1
    return sign * (abs(numerator) // denominator)


def signed32(value: int) -> int:
    value &= (1 << 32) - 1
    return value - (1 << 32) if value >= (1 << 31) else value


def fir_reference(values: list[int], inverse: bool = False) -> tuple[list[int], tuple[int, int, int, int]]:
    """Exact integer reference for R3 M32/b3/Q20/cadence4."""
    coefficients = [0] * 32
    history = [0] * 32
    head = 0
    energy = 1
    prediction_clamp = coefficient_clamp = modular_wrap = updates = 0
    result: list[int] = []
    for t, value in enumerate(values):
        total = sum(coefficients[j] * history[(head + j) % 32] for j in range(32))
        prediction = total // Q20
        if prediction < I32_MIN:
            prediction = I32_MIN
            prediction_clamp += 1
        elif prediction > I32_MAX:
            prediction = I32_MAX
            prediction_clamp += 1
        if inverse:
            original = signed32(value + prediction)
            difference = original - prediction
            result.append(original)
        else:
            original = value
            difference = original - prediction
            result.append(signed32(original - prediction))
        if difference < I32_MIN or difference > I32_MAX:
            modular_wrap += 1
        if (t & 3) == 3:
            ell = (energy - 1).bit_length()
            denominator = 1 << (ell + 3)
            for j in range(32):
                numerator = difference * history[(head + j) % 32] * Q20
                delta = trunc_div(numerator, denominator)
                coefficient = coefficients[j] + delta
                if coefficient < -Q20:
                    coefficient = -Q20
                    coefficient_clamp += 1
                elif coefficient > Q20:
                    coefficient = Q20
                    coefficient_clamp += 1
                coefficients[j] = coefficient
            updates += 1
        next_head = (head + 31) % 32
        energy -= history[next_head] * history[next_head]
        head = next_head
        history[head] = original
        energy += original * original
    return result, (prediction_clamp, coefficient_clamp, modular_wrap, updates)


def spatial_reference(left: list[int], right: list[int], selector: int,
                      q: tuple[int, ...] = (0, 0, 8192, 0, 0),
                      left_order: int = 0, right_order: int = 0) -> tuple[list[int], list[int]]:
    result_left = list(left)
    result_right = list(right)
    direction = selector & 3
    if direction == 0:
        return result_left, result_right
    reference = result_left if direction == 1 else result_right
    target = result_right if direction == 1 else result_left
    reference_order = left_order if direction == 1 else right_order
    target_order = right_order if direction == 1 else left_order
    for i, value in enumerate(target):
        total = 0
        for coefficient, lag in zip(q, (-2, -1, 0, 1, 2)):
            sample = target_order + i + lag - reference_order
            if 0 <= sample < len(reference):
                total += coefficient * reference[sample]
        prediction = total // 4096
        prediction = max(I32_MIN, min(I32_MAX, prediction))
        target[i] = signed32(value - prediction)
    return result_left, result_right


def parse_driver_lines(output: str) -> dict[str, list[int]]:
    result: dict[str, list[int]] = {}
    for line in output.splitlines():
        fields = line.split()
        if fields:
            result[fields[0]] = [int(value) for value in fields[1:]]
    return result


class NativeRound5Tests(unittest.TestCase):
    helper: Path
    driver: Path

    @classmethod
    def setUpClass(cls) -> None:
        parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
        parser.add_argument("--helper")
        parser.add_argument("--driver")
        args, _ = parser.parse_known_args()
        configured = args.helper or os.environ.get("ROUND5_HELPER")
        cls.helper = Path(configured or "/data/issue-77-lossless/iterations/round-05/round5-helper")
        driver = args.driver or os.environ.get("ROUND5_INTEGER_DRIVER")
        cls.driver = Path(driver or "/data/issue-77-lossless/iterations/round-05/round5-integer-driver")
        if not cls.helper.is_file() or not os.access(cls.helper, os.X_OK):
            raise AssertionError(f"native round5 helper not executable: {cls.helper}")
        if not cls.driver.is_file() or not os.access(cls.driver, os.X_OK):
            raise AssertionError(f"round5 integer driver not executable: {cls.driver}")

    def command(self, args: list[str], cwd: Path) -> tuple[int, str]:
        result = subprocess.run([str(self.helper), *args], cwd=cwd,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, check=False)
        diagnostic = (result.stdout or "") + (result.stderr or "")
        for marker in ("AddressSanitizer", "UndefinedBehaviorSanitizer", "runtime error:",
                       "LeakSanitizer", "SUMMARY: UndefinedBehaviorSanitizer"):
            self.assertNotIn(marker, diagnostic, diagnostic)
        return result.returncode, diagnostic

    def driver_command(self, args: list[str], values: list[int]) -> tuple[int, str]:
        result = subprocess.run([str(self.driver), *args],
                                input=" ".join(str(value) for value in values) + "\n",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, check=False)
        diagnostic = (result.stdout or "") + (result.stderr or "")
        for marker in ("AddressSanitizer", "UndefinedBehaviorSanitizer", "runtime error:",
                       "LeakSanitizer", "SUMMARY: UndefinedBehaviorSanitizer"):
            self.assertNotIn(marker, diagnostic, diagnostic)
        return result.returncode, diagnostic

    def pair(self, root: Path, source: Path, expected: bytes, mode: int, policy: int) -> tuple[Path, dict, dict, str]:
        stem = root / f"m{mode}-p{policy}"
        output, original, coded, enc_summary, plan = (stem.with_suffix(suffix)
                                                       for suffix in (".mix", ".oa", ".ca", ".e.json", ".csv"))
        decoded, decoded_original, decoded_coded, dec_summary = (stem.with_suffix(suffix)
                                                                  for suffix in (".raw", ".doa", ".dca", ".d.json"))
        code, diagnostic = self.command(["encode", str(source), str(output), str(original),
                                         str(coded), str(enc_summary), str(mode), str(policy), str(plan)], root)
        self.assertEqual(code, 0, diagnostic)
        code, diagnostic = self.command(["decode", str(output), str(decoded), str(decoded_original),
                                         str(decoded_coded), str(dec_summary)], root)
        self.assertEqual(code, 0, diagnostic)
        self.assertEqual(decoded.read_bytes(), expected)
        self.assertEqual(original.read_bytes(), decoded_original.read_bytes())
        self.assertEqual(coded.read_bytes(), decoded_coded.read_bytes())
        enc = json.loads(enc_summary.read_text())
        dec = json.loads(dec_summary.read_text())
        self.assertEqual(enc["planRows"], enc["recordCount"])
        self.assertEqual(dec["planRows"], 0)
        rows = plan.read_text().splitlines()
        self.assertEqual(rows[0], "frameOrdinal,blockSize,cheapRiceBytes,temporalRiceBytes,"
                         "stackedRiceBytes,selectedRiceBytes,selectedSelector,coefficientBytes,"
                         "predictiveResiduals,firResiduals,firUpdates")
        self.assertEqual(len(rows) - 1, enc["recordCount"])
        for row_text in rows[1:]:
            row = row_text.split(",")
            selector = int(row[6])
            selected = int(row[5])
            if selector <= 2:
                expected_selected = int(row[2])
            elif selector == 4:
                expected_selected = int(row[3])
            else:
                expected_selected = int(row[4])
            self.assertEqual(selected, expected_selected)
            self.assertEqual(int(row[7]), 10 if selector & 3 else 0)
        for field in ("frameBytes", "sideBytes", "entropyBytes", "bypassBytes", "coefficientBytes",
                      "cheapFrames", "temporalFrames", "stackedFrames", "spatialFrames", "firFrames",
                      "reference0Frames", "reference1Frames", "predictiveResiduals", "firResiduals",
                      "firUpdates", "firPredictionClamp", "firCoefficientClamp", "firModularWrap",
                      "spatialPredictionClamp", "spatialModularWrap"):
            self.assertEqual(enc[field], dec[field], field)
        return output, enc, dec, plan.read_text()

    def test_round_trip_matrix_and_stacked_pipeline(self) -> None:
        source_data, expected = old_fixture()
        stacked_data, stacked_expected = stacked_fixture()
        with tempfile.TemporaryDirectory(prefix="round5-native-") as directory:
            root = Path(directory)
            source = root / "input.rsd"
            source.write_bytes(source_data)
            for policy in range(3):
                for mode in range(2):
                    self.pair(root, source, expected, mode, policy)
            stacked = root / "stacked.rsd"
            stacked.write_bytes(stacked_data)
            output, encoded, _, plan_text = self.pair(root, stacked, stacked_expected, 0, 1)
            row = plan_text.splitlines()[1].split(",")
            self.assertEqual(int(row[6]), 5)
            self.assertGreater(int(row[4]), 0)
            self.assertLess(int(row[4]), int(row[3]))
            self.assertEqual(encoded["stackedFrames"], 1)
            self.assertEqual(encoded["firFrames"], 1)
            self.assertEqual(encoded["spatialFrames"], 1)
            self.assertEqual(encoded["firUpdates"], 8)
            self.assertTrue(output.is_file())

    def test_integer_reference_and_all_legal_selectors(self) -> None:
        vectors = [I32_MIN, -123456789, -17, -1, 0, 1, 31, 32,
                   123456789, I32_MAX, 0, -77, 901, -1203, 4096, -8192,
                   0, 3, -5, 8, -13, 21, -34, 55, -89, 144, -233, 377,
                   -610, 987, -1597, 2584, -4181, 6765]
        encoded, expected_counts = fir_reference(vectors, False)
        recovered, inverse_counts = fir_reference(encoded, True)
        code, output = self.driver_command(["fir", str(len(vectors))], vectors)
        self.assertEqual(code, 0, output)
        lines = parse_driver_lines(output)
        self.assertEqual(lines["forward"], encoded)
        self.assertEqual(lines["recovered"], vectors)
        self.assertEqual(lines["counters"], list(expected_counts))
        self.assertEqual(lines["inverse_counters"], list(inverse_counts))
        stress = [1, 1, 1, I32_MAX, I32_MIN]
        stress_encoded, stress_counts = fir_reference(stress, False)
        self.assertEqual(stress_encoded, [1, 1, 1, I32_MAX, 1])
        self.assertEqual(stress_counts, (1, 3, 1, 1))
        code, output = self.driver_command(["fir", str(len(stress))], stress)
        self.assertEqual(code, 0, output)
        lines = parse_driver_lines(output)
        self.assertEqual(lines["forward"], stress_encoded)
        self.assertEqual(lines["recovered"], stress)
        self.assertEqual(lines["counters"], list(stress_counts))
        for selector in (0, 1, 2, 4, 5, 6):
            if selector in (2, 6):
                left = [2 * (i + 1) * 32 for i in range(16)]
                right = [(i + 1) * 32 for i in range(16)]
            else:
                left = [(i + 1) * 32 for i in range(16)]
                right = [2 * value for value in left]
            spatial_left, spatial_right = spatial_reference(left, right, selector)
            if selector & 4:
                coded_left, _ = fir_reference(spatial_left, False)
                coded_right, _ = fir_reference(spatial_right, False)
            else:
                coded_left, coded_right = spatial_left, spatial_right
            code, output = self.driver_command(["selector", str(selector), "16"], left + right)
            self.assertEqual(code, 0, output)
            lines = parse_driver_lines(output)
            self.assertEqual(lines.get("selector", [])[:2], [selector, 1])
            self.assertEqual(lines["coded_left"], coded_left)
            self.assertEqual(lines["coded_right"], coded_right)

        # A direct five-tap LPC pipeline exercises order alignment, all
        # lookahead/edge-zero cases, non-center coefficients, and FIR reset
        # independently on two subframes.
        left = [10, -3, 2, -1, 0, 4, -5, 8, -13, 21, -34, 55]
        right = [-7, 6, -5, 4, -3, 2, -1, 0, 1, -2, 3, -4]
        q = (1024, -512, 4096, 256, -128)
        spatial_left, spatial_right = spatial_reference(left, right, 5, q, 2, 1)
        coded_left, _ = fir_reference(spatial_left, False)
        coded_right, _ = fir_reference(spatial_right, False)
        code, output = self.driver_command(
            ["pipeline", "5", "12", "2", "1", "3", "3", *map(str, q)], left + right)
        self.assertEqual(code, 0, output)
        lines = parse_driver_lines(output)
        self.assertEqual(lines["coded_left"], coded_left)
        self.assertEqual(lines["coded_right"], coded_right)
        self.assertEqual(lines["selector"][:2], [5, 1])
        self.assertEqual(lines["selector"][2:4], [6, 6])

        # Both legal coefficient limits remain representable when edge
        # features are zero, so the decoder's strict bound is tested at the
        # boundary as well as above it.
        code, output = self.driver_command(
            ["pipeline", "1", "1", "0", "0", "2", "2", "16384", "-16384", "0", "0", "0"],
            [0, 0])
        self.assertEqual(code, 0, output)

        # Spatial prediction can clamp while the signed32 lifting wraps; the
        # inverse must report and undo the same boundary behavior.
        code, output = self.driver_command(
            ["pipeline", "1", "1", "0", "0", "2", "2", "0", "0", "8192", "0", "0"],
            [I32_MAX, I32_MIN])
        self.assertEqual(code, 0, output)
        lines = parse_driver_lines(output)
        self.assertEqual(lines["coded_left"], [I32_MAX])
        self.assertEqual(lines["coded_right"], [1])
        self.assertEqual(lines["selector"][2:10], [0, 0, 1, 1, 1, 1, 0, 0])

    def test_threshold_boundaries_and_malformed_streams(self) -> None:
        for gain in (0, 1, 31, 32, 33):
            code, output = self.driver_command(
                ["threshold", "1", "100", str(101 - gain), str(100 - gain)], [])
            self.assertEqual(code, 0, output)
            self.assertEqual(int(output.split()[1]), 0 if gain == 0 else 5)
            code, output = self.driver_command(
                ["threshold", "2", "100", str(101 - gain), str(100 - gain)], [])
            self.assertEqual(code, 0, output)
            self.assertEqual(int(output.split()[1]), 5 if gain > 32 else 0)
        for policy in (1, 2):
            code, output = self.driver_command(
                ["threshold", str(policy), "100", "90", "90"], [])
            self.assertEqual(code, 0, output)
            self.assertEqual(int(output.split()[1]), 4 if policy == 1 else 0)
        data, expected = stacked_fixture()
        with tempfile.TemporaryDirectory(prefix="round5-malformed-") as directory:
            root = Path(directory)
            source = root / "input.rsd"
            source.write_bytes(data)
            output, _, _, _ = self.pair(root, source, expected, 0, 1)
            original = output.read_bytes()
            manifest_length = struct.unpack_from("<Q", original, 12)[0]
            tables = struct.unpack_from("<I", original, 28)[0]
            frame_start = 32 + manifest_length + tables * 37
            body_length = struct.unpack_from("<I", original, frame_start)[0]
            body_start = frame_start + 4

            def reject(data_value: bytes, label: str) -> None:
                candidate = root / f"{label}.mix"
                candidate.write_bytes(data_value)
                raw = root / f"{label}.raw"
                code, diagnostic = self.command(["decode", str(candidate), str(raw), "-", "-",
                                                 str(root / f"{label}.json")], root)
                self.assertEqual(code, 2, f"{label}: {diagnostic}")
                self.assertFalse(raw.exists(), label)

            def reject_or_digest_mismatch(data_value: bytes, label: str) -> None:
                candidate = root / f"{label}.mix"
                candidate.write_bytes(data_value)
                raw = root / f"{label}.raw"
                code, diagnostic = self.command(["decode", str(candidate), str(raw), "-", "-",
                                                 str(root / f"{label}.json")], root)
                self.assertIn(code, (0, 2), f"{label}: {diagnostic}")
                if code == 0:
                    self.assertNotEqual(raw.read_bytes(), expected, label)

            for offset, value, label in ((9, 2, "shape"), (10, 3, "policy"), (11, 1, "spatial"),
                                         (body_start + 3, 3, "direction3"),
                                         (body_start + 3, 7, "reserved-selector"),
                                         (body_start + 3, 8, "reserved-high-selector")):
                bad = bytearray(original)
                bad[offset] = value
                reject(bytes(bad), label)
            bad = bytearray(original)
            bad[10] = 0
            bad[body_start + 3] = 4
            reject(bytes(bad), "fir-under-policy0")
            reject(original[:-1], "truncated")
            reject(original + b"trailing", "trailing")
            reject(original[:body_start + 4 + 3], "missing-coefficients")
            bad = bytearray(original)
            for index in range(5):
                struct.pack_into("<h", bad, body_start + 4 + index * 2, 0)
            reject(bytes(bad), "zero-coefficients")
            bad = bytearray(original)
            struct.pack_into("<h", bad, body_start + 4 + 2 * 2, R4_COEFF_LIMIT + 1)
            reject(bytes(bad), "coefficient-range")

            # Both mutations are legal pipeline values, so successful decode
            # must still fail the intended canonical PCM identity.
            bad = bytearray(original)
            bad[body_start + 3] = 6
            reject_or_digest_mismatch(bytes(bad), "legal-selector-mutation")
            bad = bytearray(original)
            struct.pack_into("<h", bad, body_start + 4 + 2 * 2, 4096)
            reject_or_digest_mismatch(bytes(bad), "legal-coefficient-mutation")

            # Header length/count mutations must not make a partial stream
            # look complete.  The manifest is opaque to the native decoder,
            # but its authenticated length remains part of the framing.
            bad = bytearray(original)
            struct.pack_into("<Q", bad, 12, manifest_length + 1)
            reject(bytes(bad), "manifest-length")
            bad = bytearray(original)
            struct.pack_into("<Q", bad, 20, 2)
            reject(bytes(bad), "record-count")

            # Insert an uncharged coefficient before the first subframe.  The
            # body length is updated so this exercises the exact coefficient
            # boundary rather than simple EOF truncation.
            bad = bytearray(original)
            coefficient_end = body_start + 4 + 10
            bad[coefficient_end:coefficient_end] = b"\x01\x00"
            struct.pack_into("<I", bad, frame_start, body_length + 2)
            reject(bytes(bad), "extra-coefficient")

            constant_data, constant_expected = old_fixture()
            constant_source = root / "constant.rsd"
            constant_source.write_bytes(constant_data)
            constant_output, _, _, _ = self.pair(root, constant_source, constant_expected, 0, 1)
            constant_bytes = bytearray(constant_output.read_bytes())
            constant_manifest = struct.unpack_from("<Q", constant_bytes, 12)[0]
            constant_tables = struct.unpack_from("<I", constant_bytes, 28)[0]
            constant_frame = 32 + constant_manifest + constant_tables * 37
            constant_bytes[constant_frame + 4 + 3] = 4
            reject(bytes(constant_bytes), "fir-with-no-predictive-residuals")
            constant_bytes = bytearray(constant_output.read_bytes())
            constant_bytes[constant_frame + 4 + 3] = 1
            constant_body_length = struct.unpack_from("<I", constant_bytes, constant_frame)[0]
            constant_body_start = constant_frame + 4
            constant_bytes[constant_body_start + 4:constant_body_start + 4] = struct.pack(
                "<5h", 0, 0, 8192, 0, 0)
            struct.pack_into("<I", constant_bytes, constant_frame, constant_body_length + 10)
            reject(bytes(constant_bytes), "spatial-ineligible")

            # Exercise the RANS table and payload boundaries on an actual R5
            # artifact, in addition to Rice-side framing mutations above.
            rans_output, _, _, _ = self.pair(root, source, expected, 1, 1)
            rans_bytes = rans_output.read_bytes()
            rans_manifest = struct.unpack_from("<Q", rans_bytes, 12)[0]
            rans_table_count = struct.unpack_from("<I", rans_bytes, 28)[0]
            self.assertGreater(rans_table_count, 0)
            table_start = 32 + rans_manifest
            bad_table = bytearray(rans_bytes)
            frequencies = [struct.unpack_from("<H", bad_table, table_start + 3 + 2 * i)[0]
                           for i in range(17)]
            nonzero = next(i for i, frequency in enumerate(frequencies) if frequency)
            struct.pack_into("<H", bad_table, table_start + 3 + 2 * nonzero,
                             frequencies[nonzero] - 1)
            reject(bytes(bad_table), "rans-table-sum")
            bad_manifest = bytearray(rans_bytes)
            struct.pack_into("<Q", bad_manifest, 12, (1 << 20) + 1)
            reject(bytes(bad_manifest), "oversized-manifest")
            bad_tables = bytearray(rans_bytes)
            struct.pack_into("<I", bad_tables, 28, 4 * 31 * 5 + 1)
            reject(bytes(bad_tables), "oversized-table-count")
            bad_role = bytearray(rans_bytes)
            bad_role[table_start] = 4
            reject(bytes(bad_role), "out-of-range-table-role")
            bad_k = bytearray(rans_bytes)
            bad_k[table_start + 1] = 31
            reject(bytes(bad_k), "out-of-range-table-k")
            bad_context = bytearray(rans_bytes)
            bad_context[table_start + 2] = 5
            reject(bytes(bad_context), "out-of-range-table-context")
            if rans_table_count >= 2:
                second_key = bytes(rans_bytes[table_start + 37:table_start + 40])
                duplicate = bytearray(rans_bytes)
                duplicate[table_start:table_start + 3] = second_key
                reject(bytes(duplicate), "duplicate-table-key")
                unsorted = bytearray(rans_bytes)
                first_table = bytes(unsorted[table_start:table_start + 37])
                second_table = bytes(unsorted[table_start + 37:table_start + 74])
                unsorted[table_start:table_start + 37] = second_table
                unsorted[table_start + 37:table_start + 74] = first_table
                reject(bytes(unsorted), "unsorted-table-keys")

            rans_frame_start = 32 + rans_manifest + rans_table_count * 37
            rans_body_length = struct.unpack_from("<I", rans_bytes, rans_frame_start)[0]
            rans_body_start = rans_frame_start + 4
            # Prefix + ten coefficient bytes + three-byte side header + two
            # length fields reaches the entropy stream for this fixed fixture.
            side_start = rans_body_start + 4 + 10
            side_bytes = 3
            lengths = side_start + side_bytes
            entropy_bytes, _ = struct.unpack_from("<II", rans_bytes, lengths)
            entropy_start = lengths + 8
            payload_byte = entropy_start
            self.assertLess(payload_byte, rans_body_start + rans_body_length)
            bad_payload = bytearray(rans_bytes)
            bad_payload[payload_byte] ^= 0x40
            candidate = root / "rans-payload.mixed"
            candidate.write_bytes(bad_payload)
            raw = root / "rans-payload.raw"
            code, diagnostic = self.command(["decode", str(candidate), str(raw), "-", "-",
                                             str(root / "rans-payload.json")], root)
            self.assertIn(code, (0, 2), diagnostic)
            if code == 0:
                self.assertNotEqual(raw.read_bytes(), expected)
            bad_state = bytearray(rans_bytes)
            struct.pack_into("<I", bad_state, entropy_start, 0x80000000)
            reject(bytes(bad_state), "invalid-initial-rans-state")
            bad_terminal = bytearray(rans_bytes)
            bad_terminal[entropy_start + entropy_bytes - 1] ^= 1
            reject(bytes(bad_terminal), "invalid-terminal-rans-state")
            bad_padding = bytearray(rans_bytes)
            bad_padding[side_start + side_bytes - 1] |= 1
            reject(bytes(bad_padding), "nonzero-side-padding")
            bad_frame_length = bytearray(rans_bytes)
            struct.pack_into("<I", bad_frame_length, rans_frame_start, 4 * 1024 * 1024 + 1)
            reject(bytes(bad_frame_length), "oversized-frame-body")
            bad_subframe_length = bytearray(rans_bytes)
            struct.pack_into("<I", bad_subframe_length, lengths, 4 * 1024 * 1024 + 1)
            reject(bytes(bad_subframe_length), "oversized-subframe-entropy")
            bad_escape = bytearray(rans_bytes)
            put_bits(bad_escape, side_start * 8 + 14, 5, 31)
            reject(bytes(bad_escape), "round5-raw-escape")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--helper")
    parser.add_argument("--driver")
    native_args, unittest_args = parser.parse_known_args()
    if native_args.helper:
        os.environ["ROUND5_HELPER"] = native_args.helper
    if native_args.driver:
        os.environ["ROUND5_INTEGER_DRIVER"] = native_args.driver
    sys.argv = [sys.argv[0], *unittest_args]
    unittest.main()
