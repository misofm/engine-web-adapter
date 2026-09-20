#!/usr/bin/env python3
"""Independent round-02 byte-rANS decoder fixtures and corruption gates.

The fixtures are encoded here from explicit residuals and PCM expectations;
they do not call the round-02 encoder.  The native command contract used by
this test is::

    round2-helper decode INPUT OUTPUT SUMMARY

The helper path is configurable with ``--helper`` or ``ROUND2_HELPER``.  A
separate ASan/UBSan helper can be passed through the same option.  Missing
helpers are a hard error, never a skipped test.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


MAGIC = b"I77ENT02"
PROFILE = 1
L = 1 << 23
S24_MIN = -(1 << 23)
S24_MAX = (1 << 23) - 1
MAX_TABLES = 4 * 31 * 5
MAX_BODY = 4 * 1024 * 1024


def p(fmt: str, *values: int) -> bytes:
    return struct.pack("<" + fmt, *values)


def s24(value: int) -> bytes:
    if not S24_MIN <= value <= S24_MAX:
        raise ValueError(value)
    return p("I", value & 0xFFFFFF)[:3]


def pcm(left: list[int], right: list[int]) -> bytes:
    if len(left) != len(right):
        raise ValueError("channel lengths differ")
    return b"".join(s24(a) + s24(b) for a, b in zip(left, right))


def unpack_s24(data: bytes, offset: int) -> int:
    raw = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
    return raw - (1 << 24) if raw & (1 << 23) else raw


def round1_valid_cases() -> list[tuple[str, bytes, bytes]]:
    """Load only round-1's explicit synthetic cases; no native code is used."""
    import importlib.util
    source = Path(__file__).resolve().parents[1] / "round-01" / "test_native.py"
    spec = importlib.util.spec_from_file_location("round1_synthetic_fixtures", source)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load round-1 fixture module: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.valid_cases()


def parse_round1_record(item: bytes) -> tuple[int, int, list[DiagnosticSubframe]]:
    record_bytes = struct.unpack_from("<I", item, 0)[0]
    if record_bytes != len(item) - 4:
        raise ValueError("round-1 record length")
    body = item[4:]
    _, _, _, _, blocksize, assignment, channels, bps, reserved = struct.unpack_from("<IQQII4B", body)
    if channels != 2 or bps != 24 or reserved:
        raise ValueError("round-1 synthetic envelope")
    offset = 32
    subframes: list[DiagnosticSubframe] = []
    for _ in range(2):
        type_code, wasted, order, precision, shift_raw, method, partition_order, reserved = struct.unpack_from("<8B", body, offset)
        shift = shift_raw - 256 if shift_raw & 0x80 else shift_raw
        count, partition_count = struct.unpack_from("<II", body, offset + 8)
        if reserved:
            raise ValueError("round-1 subframe reserved")
        cursor = offset + 16
        warmups = list(struct.unpack_from(f"<{order}i", body, cursor)) if order else []
        cursor += order * 4
        coefficients: list[int] = []
        if type_code == 3:
            coefficients = list(struct.unpack_from(f"<{order}i", body, cursor)) if order else []
            cursor += order * 4
        parameters: list[int] = []
        raw_widths: list[int] = []
        data_count = count
        if type_code in (2, 3):
            for _partition in range(partition_count):
                parameter, raw_width, reserved16 = struct.unpack_from("<BBH", body, cursor)
                cursor += 4
                if reserved16:
                    raise ValueError("round-1 partition reserved")
                parameters.append(parameter)
                raw_widths.append(raw_width)
        data = list(struct.unpack_from(f"<{data_count}i", body, cursor)) if data_count else []
        cursor += data_count * 4
        subframes.append(DiagnosticSubframe(type_code, wasted, order, precision, shift,
                                             warmups, coefficients, parameters, raw_widths, data))
        offset = cursor
    if offset != len(body):
        raise ValueError("round-1 record payload")
    return blocksize, assignment, subframes


def role_for(assignment: int, channel: int) -> int:
    if assignment == 0:
        return channel
    if assignment == 1:
        return 0 if channel == 0 else 3
    if assignment == 2:
        return 3 if channel == 0 else 1
    if assignment == 3:
        return 2 if channel == 0 else 3
    raise ValueError(assignment)


def compact_rice_subframe(sub: DiagnosticSubframe, blocksize: int,
                          assignment: int, channel: int) -> bytes:
    role = role_for(assignment, channel)
    side = role == 3
    if sub.type == 0:
        kind = "constant"
        original = [value << sub.wasted for value in sub.data]
        encoded = sub.data
        order = 0
    elif sub.type == 1:
        kind = "verbatim"
        original = [value << sub.wasted for value in sub.data]
        encoded = sub.data
        order = 0
    elif sub.type in (2, 3):
        kind = "fixed" if sub.type == 2 else "lpc"
        order = sub.order
        original = [value << sub.wasted for value in sub.warmups] + [0] * (blocksize - order)
        encoded = sub.warmups + sub.data
    else:
        raise ValueError(sub.type)
    if kind in ("constant", "verbatim"):
        return fixed_subframe(original, role=role, method=1, params=[], tables=None,
                              assignment=assignment, kind=kind, wasted=sub.wasted,
                              bps=24, residual_values=encoded)[0]
    # Rice2 k=24 keeps the explicit extrema and side values well below the
    # bounded unary/byte payload limit while preserving a valid compact table.
    params = [24]
    raw_widths = [0]
    return fixed_subframe(original, role=role, method=1, params=params, tables={}, mode=0,
                          assignment=assignment, kind=kind, order=order,
                          coefficients=sub.coefficients, shift=sub.shift,
                          precision=sub.precision, wasted=sub.wasted,
                          residual_values=encoded, raw_widths=raw_widths)[0]


def round1_matrix_fixture() -> Fixture:
    frames: list[bytes] = []
    expected_parts: list[bytes] = []
    total_frames = 0
    for _name, item, expected in round1_valid_cases():
        blocksize, assignment, subframes = parse_round1_record(item)
        compact = tuple(compact_rice_subframe(subframes[channel], blocksize, assignment, channel)
                        for channel in range(2))
        frames.append(frame(blocksize, assignment, compact))
        expected_parts.append(expected)
        total_frames += blocksize
    data, table_start, _ = file_bytes(0, frames, [], total_frames)
    return Fixture(data, b"".join(expected_parts), tables_start=table_start)


def nonzero_raw_fixture() -> Fixture:
    left = [-3, -1, 0, 3]
    right = [2, -2, 1, -1]
    params = [31]
    raw_widths = [5]
    sf_left, meta = fixed_subframe(left, role=0, method=1, params=params, tables={}, mode=0,
                                   raw_widths=raw_widths)
    sf_right, _ = fixed_subframe(right, role=1, method=1, params=params, tables={}, mode=0,
                                 raw_widths=raw_widths)
    item = frame(4, 0, (sf_left, sf_right))
    data, table_start, frame_start = file_bytes(0, [item], [], 4)
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_left) - 8 - meta["entropyBytes"] - meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(left, right), entropy_start, entropy_start + meta["entropyBytes"],
                   side_start, side_bytes, table_start)


def all_raw_escape_fixture(left: list[int], right: list[int], width: int) -> Fixture:
    """Return a context-mode frame whose residuals are all raw escapes.

    There are no ordinary symbols in this case, so the rANS stream must be
    empty even when the raw bypass carries nonzero-width values.
    """
    if len(left) != len(right) or not left:
        raise ValueError("raw escape channel lengths")
    params = [31]
    raw_widths = [width]
    sf_left, left_meta = fixed_subframe(left, role=0, method=1, params=params,
                                        tables={}, mode=1, raw_widths=raw_widths)
    sf_right, _ = fixed_subframe(right, role=1, method=1, params=params,
                                  tables={}, mode=1, raw_widths=raw_widths)
    item = frame(len(left), 0, (sf_left, sf_right))
    data, table_start, frame_start = file_bytes(1, [item], [], len(left))
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_left) - 8 - left_meta["entropyBytes"] - left_meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(left, right), entropy_start,
                   entropy_start + left_meta["entropyBytes"], side_start,
                   side_bytes, table_start)


def folding_extrema_fixture() -> Fixture:
    """Exercise signed residual extrema through an LPC predictor.

    The predictor reaches +2^31 and -2^31 before adding INT32_MIN/MAX,
    producing the explicit output samples 0 and -1 without leaving s24.
    """
    left = [32768, 0]
    right = [-32768, -1]
    residual_left = [32768, -(1 << 31)]
    residual_right = [-(1 << 15), (1 << 31) - 1]
    params = [30]
    sf_left, left_meta = fixed_subframe(
        left, role=0, method=1, params=params, tables=None, mode=0,
        kind="lpc", order=1, coefficients=[8192], shift=-3,
        precision=15, residual_values=residual_left)
    sf_right, _ = fixed_subframe(
        right, role=1, method=1, params=params, tables=None, mode=0,
        kind="lpc", order=1, coefficients=[8192], shift=-3,
        precision=15, residual_values=residual_right)
    item = frame(2, 0, (sf_left, sf_right))
    data, table_start, frame_start = file_bytes(0, [item], [], 2)
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_left) - 8 - left_meta["entropyBytes"] - left_meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(left, right), entropy_start,
                   entropy_start + left_meta["entropyBytes"], side_start,
                   side_bytes, table_start)


def fold(value: int) -> int:
    return 2 * value if value >= 0 else -2 * value - 1


class Bits:
    def __init__(self) -> None:
        self.bits: list[int] = []

    def put(self, value: int, width: int) -> None:
        if width < 0 or value < 0 or value >= (1 << width):
            raise ValueError((value, width))
        self.bits.extend((value >> shift) & 1 for shift in range(width - 1, -1, -1))

    def signed(self, value: int, width: int) -> None:
        self.put(value & ((1 << width) - 1), width)

    def zero_pad(self) -> bytes:
        while len(self.bits) % 8:
            self.bits.append(0)
        out = bytearray()
        for start in range(0, len(self.bits), 8):
            byte = 0
            for bit in self.bits[start:start + 8]:
                byte = (byte << 1) | bit
            out.append(byte)
        return bytes(out)

    @property
    def bit_count(self) -> int:
        return len(self.bits)


@dataclass(frozen=True)
class Table:
    role: int
    k: int
    context: int
    frequencies: tuple[int, ...]

    def __post_init__(self) -> None:
        if len(self.frequencies) != 17 or sum(self.frequencies) != 4096:
            raise ValueError("bad table frequencies")

    @property
    def cumulative(self) -> tuple[int, ...]:
        total = 0
        values = []
        for frequency in self.frequencies:
            values.append(total)
            total += frequency
        return tuple(values)


@dataclass
class Fixture:
    data: bytes
    expected: bytes
    entropy_start: int | None = None
    bypass_start: int | None = None
    side_start: int | None = None
    side_bytes: int | None = None
    tables_start: int | None = None


@dataclass
class DiagnosticSubframe:
    type: int
    wasted: int
    order: int
    precision: int
    shift: int
    warmups: list[int]
    coefficients: list[int]
    parameters: list[int]
    raw_widths: list[int]
    data: list[int]


def manifest(frame_count: int) -> bytes:
    digest = "0" * 64
    value = {
        "bitDepth": 24,
        "channels": 2,
        "chunks": [{
            "bytes": 1,
            "flacSha256": digest,
            "frames": frame_count,
            "offset": 0,
            "packedStartFrame": 0,
            "pcmSha256": digest,
        }],
        "format": "miso_sparse_stem_v1",
        "frames": frame_count,
        "identity": "sha256:" + digest,
        "intervals": [{"frames": frame_count, "packedFrameOffset": 0, "startFrame": 0}],
        "sampleRateHz": 44100,
    }
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def context_of(previous_q: int | None) -> int:
    return 4 if previous_q is None else min(previous_q, 3)


def ordinary_symbols(values: list[int], params: list[int], method: int,
                    blocksize: int, order: int = 0,
                    raw_widths: list[int] | None = None) -> tuple[list[tuple[int, int, int, int]], list[tuple[int, int]]]:
    """Return (role-independent symbol keys) and bypass bit tuples.

    Each symbol tuple is ``(k, context, symbol, actual_q)``.  Partition
    parameters and residuals are intentionally explicit fixture inputs.
    """
    partitions = 1 << (len(params).bit_length() - 1)
    if len(params) != partitions:
        raise ValueError("partition count must be a power of two")
    widths = raw_widths or [0] * len(params)
    if len(widths) != len(params):
        raise ValueError("raw width table")
    width = 4 if method == 0 else 5
    escape = 15 if method == 0 else 31
    partition_size = blocksize >> (len(params).bit_length() - 1)
    residuals = values[order:]
    if len(residuals) != blocksize - order:
        raise ValueError("residual count")
    symbols: list[tuple[int, int, int, int]] = []
    bypass: list[tuple[int, int]] = []
    cursor = 0
    for partition, parameter in enumerate(params):
        if parameter >= (1 << width):
            raise ValueError("parameter width")
        count = partition_size - (order if partition == 0 else 0)
        previous_q: int | None = None
        for residual in residuals[cursor:cursor + count]:
            if parameter == escape:
                width_value = widths[partition]
                if fold(residual) >= (1 << width_value):
                    raise ValueError("raw residual exceeds width")
                continue
            u = fold(residual)
            q, remainder = u >> parameter, u & ((1 << parameter) - 1)
            symbol = min(q, 16)
            symbols.append((parameter, context_of(previous_q), symbol, q))
            if symbol == 16:
                bypass.append((q, 32))
            if parameter:
                bypass.append((remainder, parameter))
            previous_q = q
        cursor += count
    if cursor != len(residuals):
        raise ValueError("partition coverage")
    return symbols, bypass


def make_frequencies(symbols: list[tuple[int, int, int, int]], role: int,
                     *, binary: bool = False) -> list[Table]:
    observed: dict[tuple[int, int, int], set[int]] = {}
    for k, context, symbol, _ in symbols:
        observed.setdefault((role, k, context), set()).add(symbol)
    result = []
    for key in sorted(observed):
        frequencies = [0] * 17
        symbols_for_key = sorted(observed[key])
        if binary:
            # A two-symbol model forces byte-rANS renormalization while still
            # leaving all symbols used by this fixture decodable.
            chosen = sorted(set(symbols_for_key) | {0, 1})
            if len(chosen) != 2:
                chosen = symbols_for_key
            if len(chosen) == 2:
                frequencies[chosen[0]] = 2048
                frequencies[chosen[1]] = 2048
            else:
                frequencies[chosen[0]] = 4096
        else:
            frequencies[symbols_for_key[0]] = 4096 - (len(symbols_for_key) - 1)
            for symbol in symbols_for_key[1:]:
                frequencies[symbol] = 1
        result.append(Table(key[0], key[1], key[2], tuple(frequencies)))
    return result


def table_map(tables: list[Table]) -> dict[tuple[int, int, int], Table]:
    return {(table.role, table.k, table.context): table for table in tables}


def rans_encode(symbols: list[tuple[int, int, int, int]], role: int,
                tables: dict[tuple[int, int, int], Table]) -> bytes:
    state = L
    emitted: list[int] = []
    for k, context, symbol, _ in reversed(symbols):
        table = tables[(role, k, context)]
        frequency = table.frequencies[symbol]
        if frequency <= 0:
            raise ValueError("zero-frequency fixture symbol")
        cumulative = table.cumulative[symbol]
        while state >= ((L >> 12) << 8) * frequency:
            emitted.append(state & 0xFF)
            state >>= 8
        state = (state // frequency) * 4096 + state % frequency + cumulative
    return p("I", state) + bytes(reversed(emitted))


def rice_encode(values: list[int], params: list[int], method: int,
                blocksize: int, order: int = 0,
                raw_widths: list[int] | None = None) -> bytes:
    ordinary_symbols(values, params, method, blocksize, order, raw_widths)
    bits = Bits()
    partitions = len(params)
    partition_size = blocksize >> (partitions.bit_length() - 1)
    residuals = values[order:]
    cursor = 0
    widths = raw_widths or [0] * len(params)
    for partition, parameter in enumerate(params):
        count = partition_size - (order if partition == 0 else 0)
        escape = 15 if method == 0 else 31
        for residual in residuals[cursor:cursor + count]:
            if parameter == escape:
                width = widths[partition]
                bits.put(residual & ((1 << width) - 1) if width else 0, width)
            else:
                u = fold(residual)
                q, remainder = u >> parameter, u & ((1 << parameter) - 1)
                bits.put(0, q)
                bits.put(1, 1)
                bits.put(remainder, parameter)
        cursor += count
    return bits.zero_pad()


def bypass_encode(values: list[int], params: list[int], method: int,
                  blocksize: int, order: int = 0,
                  raw_widths: list[int] | None = None) -> bytes:
    ordinary_symbols(values, params, method, blocksize, order, raw_widths)
    bits = Bits()
    # Bypass follows residual order: raw escape values and ordinary remainder
    # fields share this one bitstream.
    widths = raw_widths or [0] * len(params)
    partitions = len(params)
    partition_size = blocksize >> (partitions.bit_length() - 1)
    residuals = values[order:]
    cursor = 0
    for partition, parameter in enumerate(params):
        count = partition_size - (order if partition == 0 else 0)
        for residual in residuals[cursor:cursor + count]:
            if parameter == (15 if method == 0 else 31):
                width = widths[partition]
                bits.put(residual & ((1 << width) - 1) if width else 0, width)
            else:
                u = fold(residual)
                k = parameter
                q, remainder = u >> k, u & ((1 << k) - 1)
                if min(q, 16) == 16:
                    bits.put(q, 32)
                bits.put(remainder, k)
        cursor += count
    return bits.zero_pad()


def side_info(values: list[int], *, method: int, params: list[int],
              kind: str = "fixed", order: int = 0, wasted: int = 0,
              coefficients: list[int] | None = None, shift: int = 0,
              bps: int = 24, side: bool = False, precision: int = 12,
              stored_warmups: list[int] | None = None,
              stored_data: list[int] | None = None,
              raw_widths: list[int] | None = None) -> tuple[bytes, int]:
    bits = Bits()
    if kind == "constant":
        type_code = 0
    elif kind == "verbatim":
        type_code = 1
    elif kind == "fixed":
        type_code = 8 + order
    elif kind == "lpc":
        type_code = 32 + order - 1
    else:
        raise ValueError(kind)
    if not 0 <= type_code < 64:
        raise ValueError(type_code)
    # FLAC's eight-bit subframe header: reserved zero, six-bit type, wasted
    # flag.  The following unary code is present only when the flag is set.
    bits.put((type_code << 1) | bool(wasted), 8)
    if wasted:
        bits.put(0, wasted - 1)
        bits.put(1, 1)
    depth = bps + int(side) - wasted
    if depth <= 0:
        raise ValueError("depth")
    if kind in ("fixed", "lpc"):
        warmups = stored_warmups if stored_warmups is not None else [value >> wasted for value in values[:order]]
        for value in warmups:
            bits.signed(value, depth)
    if kind == "lpc":
        if coefficients is None or len(coefficients) != order:
            raise ValueError("coefficients")
        if not 1 <= precision <= 16:
            raise ValueError("precision")
        bits.put(precision - 1, 4)
        bits.signed(shift, 5)
        for coefficient in coefficients:
            bits.signed(coefficient, precision)
    data_values = stored_data if stored_data is not None else [value >> wasted for value in values]
    if kind == "constant":
        bits.signed(data_values[0], depth)
    elif kind == "verbatim":
        for value in data_values:
            bits.signed(value, depth)
    else:
        bits.put(method, 2)
        bits.put(len(params).bit_length() - 1, 4)
        width = 4 if method == 0 else 5
        widths = raw_widths or [0] * len(params)
        if len(widths) != len(params):
            raise ValueError("raw width table")
        for index, parameter in enumerate(params):
            bits.put(parameter, width)
            escape = 15 if method == 0 else 31
            if parameter == escape:
                bits.put(widths[index], 5)
    side_bytes = bits.zero_pad()
    return side_bytes, bits.bit_count


def fixed_subframe(values: list[int], *, role: int, method: int,
                   params: list[int], tables: dict[tuple[int, int, int], Table] | None,
                   assignment: int = 0, kind: str = "fixed", order: int = 0,
                   coefficients: list[int] | None = None, shift: int = 0,
                   wasted: int = 0, bps: int = 24,
                   residual_values: list[int] | None = None,
                   precision: int = 12, raw_widths: list[int] | None = None,
                   mode: int = 1) -> tuple[bytes, dict[str, int]]:
    side = assignment == 1 and role == 3 or assignment == 2 and role == 3 or assignment == 3 and role == 3
    side_bytes, side_bits = side_info(values, method=method, params=params, kind=kind,
                                      order=order, wasted=wasted, coefficients=coefficients,
                                      shift=shift, bps=bps, side=side, precision=precision,
                                      stored_warmups=(residual_values[:order] if residual_values is not None else None),
                                      stored_data=(residual_values if kind in ("constant", "verbatim") and residual_values is not None else None),
                                      raw_widths=raw_widths)
    if kind in ("constant", "verbatim"):
        return side_bytes, {"sideBits": side_bits}
    encoded_values = residual_values if residual_values is not None else values
    symbols, _ = ordinary_symbols(encoded_values, params, method, len(values), order, raw_widths)
    if mode == 0:
        entropy = rice_encode(encoded_values, params, method, len(values), order, raw_widths)
        bypass = b""
    else:
        if tables is None:
            raise ValueError("rANS tables required")
        entropy = rans_encode(symbols, role, tables) if symbols else b""
        bypass = bypass_encode(encoded_values, params, method, len(values), order, raw_widths)
        # Add raw escape values to bypass in their original position.  Width
        # zero is the only raw fixture here and therefore remains unchanged.
    payload = side_bytes + p("II", len(entropy), len(bypass)) + entropy + bypass
    return payload, {"sideBits": side_bits, "entropyBytes": len(entropy), "bypassBytes": len(bypass)}


def frame(blocksize: int, assignment: int, subframes: tuple[bytes, bytes]) -> bytes:
    body = p("HBB", blocksize, assignment, 0) + subframes[0] + subframes[1]
    if len(body) > MAX_BODY:
        raise ValueError("frame body too large")
    return p("I", len(body)) + body


def file_bytes(mode: int, frames: list[bytes], tables: list[Table], frame_count: int) -> tuple[bytes, int, int]:
    embedded = manifest(frame_count)
    table_bytes = bytearray()
    for table in sorted(tables, key=lambda item: (item.role, item.k, item.context)):
        table_bytes += p("BBB", table.role, table.k, table.context)
        table_bytes += b"".join(p("H", frequency) for frequency in table.frequencies)
    header = MAGIC + p("BBHQQI", mode, PROFILE, 0, len(embedded), len(frames), len(tables))
    table_start = len(header) + len(embedded)
    frame_start = table_start + len(table_bytes)
    return header + embedded + bytes(table_bytes) + b"".join(frames), table_start, frame_start


def context_fixture() -> Fixture:
    left = [16, 0, 1, 1, 0, 1, 0, 16, 0, 1, 1, 0]
    right = [0] * 12
    params = [0, 30, 0, 30]
    left_symbols, _ = ordinary_symbols(left, params, 1, len(left))
    right_symbols, _ = ordinary_symbols(right, params, 1, len(right))
    tables = make_frequencies(left_symbols, 0) + make_frequencies(right_symbols, 1)
    table_lookup = table_map(tables)
    sf_left, left_meta = fixed_subframe(left, role=0, method=1, params=params, tables=table_lookup)
    sf_right, _ = fixed_subframe(right, role=1, method=1, params=params, tables=table_lookup)
    # A second short frame has no ordinary residual symbols: both raw escape
    # width-zero partitions must decode with entropyBytes=0.
    zeros = [0, 0]
    raw_params = [31]
    sf_raw0, _ = fixed_subframe(zeros, role=0, method=1, params=raw_params, tables=table_lookup)
    sf_raw1, _ = fixed_subframe(zeros, role=1, method=1, params=raw_params, tables=table_lookup)
    frames = [frame(12, 0, (sf_left, sf_right)), frame(2, 0, (sf_raw0, sf_raw1))]
    data, table_start, frame_start = file_bytes(1, frames, tables, 14)
    first_body = frame_start + 4
    side_start = first_body + 4
    side_bytes = len(sf_left) - 8 - left_meta["entropyBytes"] - left_meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    bypass_start = entropy_start + left_meta["entropyBytes"]
    return Fixture(data, pcm(left, right) + pcm(zeros, zeros), entropy_start, bypass_start,
                   side_start, side_bytes, table_start)


def renorm_fixture() -> Fixture:
    values = [index & 1 for index in range(128)]
    right = [0] * len(values)
    params = [0]
    left_symbols, _ = ordinary_symbols(values, params, 1, len(values))
    right_symbols, _ = ordinary_symbols(right, params, 1, len(right))
    tables = make_frequencies(left_symbols, 0, binary=True) + make_frequencies(right_symbols, 1)
    lookup = table_map(tables)
    sf_left, meta = fixed_subframe(values, role=0, method=1, params=params, tables=lookup)
    sf_right, _ = fixed_subframe(right, role=1, method=1, params=params, tables=lookup)
    frames = [frame(len(values), 0, (sf_left, sf_right))]
    data, table_start, frame_start = file_bytes(1, frames, tables, len(values))
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_left) - 8 - meta["entropyBytes"] - meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(values, right), entropy_start, entropy_start + meta["entropyBytes"],
                   side_start, side_bytes, table_start)


def rice_fixture() -> Fixture:
    left = [-10, -11, 7, 12]
    right = [-3, -4, 2, -8]
    mid = [(a + b) // 2 for a, b in zip(left, right)]
    side = [a - b for a, b in zip(left, right)]
    params = [0]
    sf_mid, meta = fixed_subframe(mid, role=2, method=0, params=params, tables=None, mode=0)
    sf_side, _ = fixed_subframe(side, role=3, method=0, params=params, tables=None,
                                assignment=3, mode=0)
    item = frame(4, 3, (sf_mid, sf_side))
    data, table_start, frame_start = file_bytes(0, [item], [], 4)
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_mid) - 8 - meta["entropyBytes"] - meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(left, right), entropy_start, entropy_start + meta["entropyBytes"],
                   side_start, side_bytes, table_start)


def lpc_fixture() -> Fixture:
    # Explicit LPC sequence reused from round-01's independent synthetic case.
    values = [-7, 4, 12, -5, 9, 23, -11, 17, 31, 42]
    right = [0] * len(values)
    coefficients = [3, -2]
    history = values[:2]
    residuals = values[:2]
    for value in values[2:]:
        prediction = (coefficients[0] * history[-1] + coefficients[1] * history[-2]) // 2
        residuals.append(value - prediction)
        history.append(value)
    encoded_values = values[:2] + residuals[2:]
    params = [0]
    symbols, _ = ordinary_symbols(encoded_values, params, 1, len(values), order=2)
    right_symbols, _ = ordinary_symbols(right, params, 1, len(right))
    tables = make_frequencies(symbols, 0) + make_frequencies(right_symbols, 1)
    lookup = table_map(tables)
    sf_left, meta = fixed_subframe(values, role=0, method=1, params=params, tables=lookup,
                                   kind="lpc", order=2, coefficients=coefficients, shift=1,
                                   residual_values=encoded_values)
    sf_right, _ = fixed_subframe(right, role=1, method=1, params=params, tables=lookup)
    item = frame(len(values), 0, (sf_left, sf_right))
    data, table_start, frame_start = file_bytes(1, [item], tables, len(values))
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_left) - 8 - meta["entropyBytes"] - meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(values, right), entropy_start, entropy_start + meta["entropyBytes"],
                   side_start, side_bytes, table_start)


def wasted_extrema_fixture() -> Fixture:
    left = [S24_MIN, 8388606, 0, 2]
    right = [-2, 4, 8388604, 0]
    stored_left = [value // 2 for value in left]
    stored_right = [value // 2 for value in right]
    params = [24]
    left_symbols, _ = ordinary_symbols(stored_left, params, 1, len(left))
    right_symbols, _ = ordinary_symbols(stored_right, params, 1, len(right))
    tables = make_frequencies(left_symbols, 0) + make_frequencies(right_symbols, 1)
    lookup = table_map(tables)
    sf_left, meta = fixed_subframe(left, role=0, method=1, params=params, tables=lookup,
                                   wasted=1, residual_values=stored_left)
    sf_right, _ = fixed_subframe(right, role=1, method=1, params=params, tables=lookup,
                                 wasted=1, residual_values=stored_right)
    item = frame(4, 0, (sf_left, sf_right))
    data, table_start, frame_start = file_bytes(1, [item], tables, 4)
    body = frame_start + 4
    side_start = body + 4
    side_bytes = len(sf_left) - 8 - meta["entropyBytes"] - meta["bypassBytes"]
    entropy_start = side_start + side_bytes + 8
    return Fixture(data, pcm(left, right), entropy_start, entropy_start + meta["entropyBytes"],
                   side_start, side_bytes, table_start)


class NativeRound2Tests(unittest.TestCase):
    helper: Path

    @classmethod
    def setUpClass(cls) -> None:
        parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
        parser.add_argument("--helper")
        args, _ = parser.parse_known_args()
        configured = args.helper or os.environ.get("ROUND2_HELPER")
        cls.helper = Path(configured or "/data/issue-77-lossless/iterations/round-02/round2-helper")
        if not cls.helper.is_file() or not os.access(cls.helper, os.X_OK):
            raise AssertionError(f"native round2 helper not executable: {cls.helper}")

    def decode(self, data: bytes) -> tuple[int, bytes, str]:
        with tempfile.TemporaryDirectory(prefix="round2-native-test-") as directory:
            root = Path(directory)
            source, output, summary = root / "input.ent", root / "output.raw", root / "summary.json"
            source.write_bytes(data)
            result = subprocess.run([str(self.helper), "decode", str(source), str(output), str(summary)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, check=False)
            actual = output.read_bytes() if output.exists() else b""
            return result.returncode, actual, (result.stdout or "") + (result.stderr or "")

    @staticmethod
    def assert_no_sanitizer(test: unittest.TestCase, diagnostic: str) -> None:
        markers = ("AddressSanitizer", "UndefinedBehaviorSanitizer", "runtime error:",
                   "LeakSanitizer", "SUMMARY: UndefinedBehaviorSanitizer")
        test.assertFalse(any(marker in diagnostic for marker in markers), diagnostic)

    def assert_valid(self, fixture: Fixture, label: str) -> None:
        code, actual, diagnostic = self.decode(fixture.data)
        self.assert_no_sanitizer(self, diagnostic)
        self.assertEqual(code, 0, f"{label}: {diagnostic}")
        self.assertEqual(actual, fixture.expected, label)

    def assert_reject(self, data: bytes, label: str) -> None:
        code, _, diagnostic = self.decode(data)
        self.assert_no_sanitizer(self, diagnostic)
        self.assertEqual(code, 2, f"{label}: code={code} diagnostic={diagnostic!r}")

    def assert_reject_or_mismatch(self, data: bytes, expected: bytes, label: str) -> None:
        code, actual, diagnostic = self.decode(data)
        self.assert_no_sanitizer(self, diagnostic)
        self.assertIn(code, (0, 2), f"{label}: code={code} diagnostic={diagnostic!r}")
        if code == 0:
            self.assertNotEqual(actual, expected, label)

    def test_known_context_rans_and_rice_round_trips(self) -> None:
        context = context_fixture()
        self.assertEqual(context.data[context.entropy_start:context.entropy_start + 7],
                         bytes.fromhex("ff1f8000101900"), "pinned rANS state/vector changed")
        self.assert_valid(context, "context rANS known sequence")
        renorm = renorm_fixture()
        self.assertGreater(len(renorm.data[renorm.entropy_start:]), 4)
        self.assert_valid(renorm, "renormalizing rANS known sequence")
        self.assert_valid(rice_fixture(), "Rice control and mid-side parity")
        self.assert_valid(lpc_fixture(), "LPC side information")
        self.assert_valid(wasted_extrema_fixture(), "wasted-bit signed extrema")
        self.assert_valid(round1_matrix_fixture(), "round-1 predictor/stereo compact Rice matrix")
        self.assert_valid(nonzero_raw_fixture(), "nonzero raw escape width")
        raw0 = all_raw_escape_fixture([0, 0, 0, 0], [0, 0, 0, 0], 0)
        self.assertEqual(raw0.entropy_start, raw0.bypass_start,
                         "raw width-zero subframe emitted ordinary rANS bytes")
        self.assert_valid(raw0, "all raw escape width zero")
        raw5 = all_raw_escape_fixture([-3, -1, 0, 3], [2, -2, 1, -1], 5)
        self.assertEqual(raw5.entropy_start, raw5.bypass_start,
                         "nonzero-width raw subframe emitted ordinary rANS bytes")
        self.assert_valid(raw5, "all raw escape nonzero width")
        self.assert_valid(folding_extrema_fixture(), "signed folding LPC extrema")

    def test_structural_tables_state_lengths_and_padding(self) -> None:
        fixture = context_fixture()
        assert fixture.tables_start is not None
        manifest_length = struct.unpack_from("<Q", fixture.data, 12)[0]
        table_size = 3 + 17 * 2

        duplicate = bytearray(fixture.data)
        table = duplicate[fixture.tables_start:fixture.tables_start + table_size]
        # The duplicate key is intentionally adjacent; table count is changed
        # while preserving the first frame bytes.
        duplicate = bytearray(fixture.data[:fixture.tables_start] + table + fixture.data[fixture.tables_start:])
        original_table_count = struct.unpack_from("<I", fixture.data, 28)[0]
        struct.pack_into("<I", duplicate, 28, original_table_count + 1)
        self.assert_reject(bytes(duplicate), "duplicate table")

        oversized = bytearray(fixture.data)
        struct.pack_into("<I", oversized, 28, MAX_TABLES + 1)
        self.assert_reject(bytes(oversized), "oversized table count")

        bad_manifest_length = bytearray(fixture.data)
        struct.pack_into("<Q", bad_manifest_length, 12, 1 << 20 | 1)
        self.assert_reject(bytes(bad_manifest_length), "oversized manifest length")

        bad_header_flags = bytearray(fixture.data)
        struct.pack_into("<H", bad_header_flags, 10, 1)
        self.assert_reject(bytes(bad_header_flags), "nonzero header flags")

        bad_sum = bytearray(fixture.data)
        frequency_values = [
            struct.unpack_from("<H", bad_sum, fixture.tables_start + 3 + 2 * index)[0]
            for index in range(17)
        ]
        nonzero_index = next(index for index, value in enumerate(frequency_values) if value)
        frequency_offset = fixture.tables_start + 3 + 2 * nonzero_index
        struct.pack_into("<H", bad_sum, frequency_offset, frequency_values[nonzero_index] - 1)
        self.assertNotEqual(bytes(bad_sum), fixture.data, "bad table-sum mutation was a no-op")
        self.assertNotEqual(sum(frequency_values) - 1, 4096)
        self.assert_reject(bytes(bad_sum), "table frequencies sum not 4096")

        bad_state = bytearray(fixture.data)
        struct.pack_into("<I", bad_state, fixture.entropy_start, 0)
        self.assert_reject(bytes(bad_state), "invalid rANS state")

        bad_state_upper = bytearray(fixture.data)
        struct.pack_into("<I", bad_state_upper, fixture.entropy_start, 0x80000000)
        self.assert_reject(bytes(bad_state_upper), "rANS state at exclusive upper bound")

        self.assert_reject(fixture.data[:-1], "truncated frame payload")
        self.assert_reject(fixture.data + b"trailing", "trailing bytes")
        self.assert_reject(lpc_fixture().data[:-1], "truncated entropy or bypass payload")

        bad_flags = bytearray(fixture.data)
        # First frame flags are two bytes after the body length and blocksize.
        # Locate the first frame from the manifest/table geometry instead of
        # relying on an incidental byte pattern.
        table_count = struct.unpack_from("<I", fixture.data, 28)[0]
        frame_start = 32 + manifest_length + table_count * table_size
        bad_flags[frame_start + 7] = 1
        self.assert_reject(bytes(bad_flags), "nonzero frame flags")

        bad_body_length = bytearray(fixture.data)
        struct.pack_into("<I", bad_body_length, frame_start, MAX_BODY + 1)
        self.assert_reject(bytes(bad_body_length), "oversized frame body")

        bad_padding = bytearray(fixture.data)
        assert fixture.side_start is not None and fixture.side_bytes is not None
        bad_padding[fixture.side_start + fixture.side_bytes - 1] |= 1
        self.assert_reject(bytes(bad_padding), "nonzero side-info padding")

    def test_altered_payload_and_lpc_metadata_do_not_verify(self) -> None:
        fixture = lpc_fixture()
        self.assert_reject_or_mismatch(fixture.data[:fixture.entropy_start] + bytes([fixture.data[fixture.entropy_start] ^ 1]) + fixture.data[fixture.entropy_start + 1:],
                                       fixture.expected, "altered LPC residual entropy")
        bad = bytearray(fixture.data)
        assert fixture.side_start is not None
        # LPC coefficient bits follow the 8-bit header, order-2 warmups,
        # precision and shift.  Flip one coefficient bit without changing
        # lengths, allowing either structural rejection or hash mismatch.
        coefficient_byte = fixture.side_start + 8
        bad[coefficient_byte] ^= 1
        self.assert_reject_or_mismatch(bytes(bad), fixture.expected, "altered LPC coefficient")

    def test_length_fields_are_bounded_before_reads(self) -> None:
        fixture = context_fixture()
        assert fixture.entropy_start is not None
        bad_entropy_length = bytearray(fixture.data)
        # The two length fields precede the first entropy stream.  Locate them
        # from the fixture's recorded entropy offset and side-info boundary.
        length_offset = fixture.entropy_start - 8
        struct.pack_into("<I", bad_entropy_length, length_offset, MAX_BODY)
        self.assert_reject(bytes(bad_entropy_length), "oversized entropy length")

        bad_bypass_length = bytearray(fixture.data)
        struct.pack_into("<I", bad_bypass_length, length_offset + 4, MAX_BODY)
        self.assert_reject(bytes(bad_bypass_length), "oversized bypass length")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--helper")
    args, remaining = parser.parse_known_args(argv)
    if args.helper:
        os.environ["ROUND2_HELPER"] = args.helper
    result = unittest.main(argv=[sys.argv[0]] + remaining, exit=False)
    return 0 if result.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
