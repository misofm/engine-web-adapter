#!/usr/bin/env python3
"""Independent integer and small-fixture checks for round-4 spatial prediction.

The C driver is included only to expose the native static routines.  Expected
feature alignment, modular transforms, scalar/orthogonal fits, and Rice costs
are computed here independently with Python integers and small analytic cases.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
from pathlib import Path

I32_MIN = -(1 << 31)
I32_MAX = (1 << 31) - 1
U32_MASK = (1 << 32) - 1
Q12 = 4096
Q12_LIMIT = 16384
PROFILES = {0: (), 1: (0,), 2: (-2, -1, 0, 1, 2)}


def fail(message: str) -> None:
    raise AssertionError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def signed_u32(value: int) -> int:
    value &= U32_MASK
    return value if value < (1 << 31) else value - (1 << 32)


def floor_q12(value: int) -> int:
    return value // Q12


def feature(reference: list[int], reference_order: int, target_order: int,
            index: int, lag: int) -> int:
    position = target_order + index + lag - reference_order
    return reference[position] if 0 <= position < len(reference) else 0


def transform_reference(reference: list[int], reference_order: int,
                         target: list[int], target_order: int,
                         lags: tuple[int, ...], q: tuple[int, ...]) -> tuple[list[int], list[int], dict[str, int]]:
    encoded: list[int] = []
    recovered: list[int] = []
    counters = {"predictionClamp": 0, "modularWrap": 0}
    for index, original in enumerate(target):
        total = sum(coefficient * feature(reference, reference_order, target_order,
                                          index, lag)
                    for lag, coefficient in zip(lags, q))
        prediction = floor_q12(total)
        if prediction < I32_MIN:
            prediction = I32_MIN
            counters["predictionClamp"] += 1
        elif prediction > I32_MAX:
            prediction = I32_MAX
            counters["predictionClamp"] += 1
        difference = original - prediction
        if difference < I32_MIN or difference > I32_MAX:
            counters["modularWrap"] += 1
        encoded.append(signed_u32(original - prediction))
        recovered.append(signed_u32(encoded[-1] + prediction))
    return encoded, recovered, counters


def run(driver: Path, args: list[str]) -> dict:
    completed = subprocess.run([str(driver), *args], text=True,
                               capture_output=True, check=False)
    require(completed.returncode == 0,
            f"driver failed ({completed.returncode}) for {' '.join(args)}: "
            f"{completed.stderr.strip()}")
    require("AddressSanitizer" not in completed.stderr and
            "runtime error:" not in completed.stderr,
            f"sanitizer diagnostic for {' '.join(args)}: {completed.stderr}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        fail(f"invalid driver JSON for {' '.join(args)}: {error}: {completed.stdout[:200]}")


def ints(values: list[int]) -> list[str]:
    return [str(value) for value in values]


def test_profiles(driver: Path) -> int:
    require(run(driver, ["profile", "0"]) == {"valid": 1, "taps": 0, "lags": []},
            "disabled profile contract")
    require(run(driver, ["profile", "1"]) == {"valid": 1, "taps": 1, "lags": [0]},
            "scalar profile contract")
    require(run(driver, ["profile", "2"]) == {"valid": 1, "taps": 5,
                                                  "lags": [-2, -1, 0, 1, 2]},
            "five-tap profile contract")
    require(run(driver, ["profile", "3"])["valid"] == 0, "unknown profile accepted")
    return 4


def test_floor_and_features(driver: Path) -> int:
    floor_values = [-Q12 - 1, -Q12, -Q12 + 1, -1, 0, 1, Q12 - 1, Q12, Q12 + 1]
    expected = [value // Q12 for value in floor_values]
    require(run(driver, ["floor", *ints(floor_values)]) == {"values": expected},
            "signed floor mismatch")
    cases = [
        (0, [10, 20, 30], 0, 3, -2, 0, 0),
        (2, [10, 20, 30], 4, 2, -2, 0, 10),
        (4, [10, 20, 30], 0, 2, 2, 1, 0),
        (1, [10, 20, 30], 3, 2, 0, 1, 0),
        (0, [10, 20, 30], 0, 3, 2, 0, 30),
    ]
    checks = 1
    for reference_order, reference, target_order, target_count, lag, index, expected_value in cases:
        target = [0] * target_count
        actual = run(driver, ["feature", str(reference_order), str(len(reference)),
                              str(target_order), str(target_count), str(lag), str(index),
                              *ints(reference), *ints(target)])
        require(actual == {"valid": 1, "value": expected_value},
                f"feature alignment mismatch: {cases}")
        checks += 1
    return checks


def test_transforms(driver: Path, rng: random.Random) -> int:
    checks = 0
    vectors = [
        (0, 0, [1, -2, 3, -4, 5], [7, -8, 9, -10, 11], (0,), (4097,)),
        (2, 4, [I32_MAX, -1, 0, I32_MIN, 3], [I32_MIN, 1, I32_MAX, -2, 4],
         (-2, -1, 0, 1, 2), (16384, -8193, 4097, -2049, 8191)),
        (4, 1, [I32_MIN, I32_MAX], [I32_MAX, I32_MIN, 0], (0,), (-16384,)),
        (0, 0, [], [], (0,), (4096,)),
    ]
    for reference_order, target_order, reference, target, lags, q in vectors:
        expected_encoded, expected_recovered, expected_counters = transform_reference(
            reference, reference_order, target, target_order, lags, q)
        actual = run(driver, ["transform", "2", str(len(lags)), *ints(list(lags)),
                              *ints(list(q)), str(reference_order), str(len(reference)),
                              str(target_order), str(len(target)), *ints(reference), *ints(target)])
        require(actual["encoded"] == expected_encoded and actual["recovered"] == expected_recovered,
                f"transform mismatch: {reference=} {target=} {lags=} {q=}")
        require(actual["forwardCounters"] == expected_counters and
                actual["inverseCounters"] == expected_counters,
                f"transform counters mismatch: {actual}")
        checks += 1
    for _ in range(80):
        reference_order = rng.randrange(0, 6)
        target_order = rng.randrange(0, 6)
        reference = [rng.choice([I32_MIN, I32_MAX, -1, 0, 1, rng.randrange(-100000, 100001)])
                     for _ in range(rng.randrange(0, 12))]
        target = [rng.choice([I32_MIN, I32_MAX, -1, 0, 1, rng.randrange(-100000, 100001)])
                  for _ in range(rng.randrange(0, 12))]
        lags = tuple(rng.choice([-2, -1, 0, 1, 2]) for _ in range(rng.randrange(1, 6)))
        q = tuple(rng.randrange(-Q12_LIMIT, Q12_LIMIT + 1) for _ in lags)
        expected_encoded, expected_recovered, expected_counters = transform_reference(
            reference, reference_order, target, target_order, lags, q)
        actual = run(driver, ["transform", "2", str(len(lags)), *ints(list(lags)),
                              *ints(list(q)), str(reference_order), str(len(reference)),
                              str(target_order), str(len(target)), *ints(reference), *ints(target)])
        require(actual["encoded"] == expected_encoded and actual["recovered"] == expected_recovered,
                f"seeded transform mismatch at iteration {_}")
        require(actual["forwardCounters"] == expected_counters and
                actual["inverseCounters"] == expected_counters,
                f"seeded transform counters mismatch at iteration {_}")
        checks += 1
    return checks


def scalar_quantized(expected_ratio: int, sample_scale: int) -> int:
    trace = sample_scale * sample_scale
    ridge = trace * (2.0 ** -16)
    coefficient = (sample_scale * (expected_ratio * sample_scale)) / (trace + ridge)
    magnitude = int(abs(coefficient) * Q12 + 0.5)
    return -magnitude if coefficient < 0 else magnitude


def test_fits(driver: Path) -> int:
    checks = 0
    reference = [1, 2, 3, 4, 5, 6, 7, 8]
    for ratio in (2, -2, 4, -4):
        target = [ratio * value for value in reference]
        actual = run(driver, ["fit", "1", "0", str(len(reference)), "0", str(len(target)),
                              *ints(reference), *ints(target)])
        require(actual["valid"] == 1 and actual["failure"] == 0,
                f"scalar fit rejected ratio {ratio}: {actual}")
        require(actual["q"] == [scalar_quantized(ratio, 1)],
                f"scalar fit quantization ratio {ratio}: {actual}")
        checks += 1
    # x=2^29 and y=65537 place the positive coefficient at the Q12
    # half-step after the fixed 2^-16 ridge; the negative case checks ties
    # away from zero and the signed limit is covered by the ratio tests.
    for target_value, expected_q in ((65537, 1), (-65537, -1)):
        actual = run(driver, ["fit", "1", "0", "1", "0", "1", "536870912",
                              str(target_value)])
        require(actual["q"] == [expected_q] and actual["valid"] == 1,
                f"Q12 half-tie quantization mismatch: {actual}")
        checks += 1
    reference = [0, 0, 1, 0, 0]
    target = [4, -2, 7, -3, 5]
    actual = run(driver, ["fit", "2", "2", "5", "2", "5", *ints(reference), *ints(target)])
    # The impulse makes the five columns orthogonal.  Ridge changes each
    # integer coefficient by less than half a Q12 unit for these values.
    require(actual["valid"] == 1 and actual["failure"] == 0 and
            actual["q"] == [16384, -12288, 16384, -8192, 16384],
            f"orthogonal five-tap fit mismatch: {actual}")
    checks += 1
    zero = run(driver, ["fit", "2", "0", "8", "0", "8", *(["0"] * 16)])
    require(zero["valid"] == 0 and zero["degenerate"] == 1 and zero["failure"] == 0,
            f"zero-feature fit was not degenerate: {zero}")
    checks += 1
    duplicate = run(driver, ["fit", "2", "0", "12", "0", "12",
                             *ints([3] * 12), *ints([6] * 12)])
    require(duplicate["failure"] == 0 and all(-Q12_LIMIT <= value <= Q12_LIMIT
                                               for value in duplicate["q"]),
            f"rank-deficient ridge fit failed: {duplicate}")
    repeat = run(driver, ["fit", "2", "0", "12", "0", "12",
                          *ints([3] * 12), *ints([6] * 12)])
    require(repeat == duplicate, "rank-deficient fit is not deterministic")
    checks += 2
    return checks


def rice_cost(values: list[int], order: int, partition_order: int) -> tuple[int, list[int]]:
    blocksize = len(values) + order
    partitions = 1 << partition_order
    require(blocksize % partitions == 0, "invalid test partition shape")
    partition_size = blocksize // partitions
    start = 0
    costs: list[int] = []
    parameters: list[int] = []
    for partition in range(partitions):
        count = partition_size - (order if partition == 0 else 0)
        samples = values[start:start + count]
        start += count
        folded = [(2 * value if value >= 0 else -2 * value - 1) & U32_MASK for value in samples]
        choices = [count * (k + 1) + sum(value >> k for value in folded) for k in range(31)]
        k = min(range(31), key=lambda item: (choices[item], item))
        costs.append(choices[k])
        parameters.append(k)
    require(start == len(values), "partition coverage mismatch")
    return (sum(costs) + 7) // 8, parameters


def test_scores_and_selection(driver: Path, rng: random.Random) -> int:
    checks = 0
    vectors = [
        (0, 0, [0, 1, -1, 2, -2, 3, -3, 4], [1] * 8),
        (0, 1, list(range(-8, 8)), list(range(8, -8, -1))),
        (4, 1, [I32_MIN, 0, I32_MAX, -1, 1, 2, -2, 3],
         [I32_MAX, 0, I32_MIN, 1, -1, -2, 2, -3]),
        (0, 0,
         [19, -10, -10, -3, -6, -15, 0, 7, -9, 10, 17, -6, 11, -9, 10, -11],
         [6, -13, -10, 4, -1, -13, -14, -2, -15, 13, 11, -2, 8, -18, 7, -15]),
        (4, 0, [], []),  # warmup-only: no residuals to fit or code
    ]
    for order, partition_order, left, right in vectors:
        disabled = run(driver, ["disabled_compare", str(order), str(partition_order),
                                str(len(left)), *ints(left), *ints(right)])
        require(disabled["equal"] == 1 and disabled["round2Bytes"] == disabled["round4Bytes"] and
                disabled["round4Selector"] == 0,
                f"disabled R4 did not match R3 P0: {disabled}")
        checks += 1
        if not left:
            actual = run(driver, ["plan", "1", str(order), str(partition_order), "0"])
            require(actual["selector"] == 0 and actual["counters"]["disabled"] == 1,
                    f"warmup-only plan was not disabled: {actual}")
            checks += 1
            continue
        expected_left, left_k = rice_cost(left, order, partition_order)
        expected_right, right_k = rice_cost(right, order, partition_order)
        actual = run(driver, ["score", str(order), str(partition_order), str(len(left)),
                              *ints(left), *ints(right)])
        require(actual["leftBytes"] == expected_left and actual["rightBytes"] == expected_right and
                actual["score"] == expected_left + expected_right and
                actual["leftK"] == left_k[0] and actual["rightK"] == right_k[0],
                f"Rice score mismatch: {actual} expected {expected_left=} {expected_right=}")
        choices = run(driver, ["choices", "1", str(order), str(partition_order), str(len(left)),
                                *ints(left), *ints(right)])
        plan = run(driver, ["plan", "1", str(order), str(partition_order), str(len(left)),
                             *ints(left), *ints(right)])
        candidates = [(0, choices["disabled"]["score"], choices["disabled"]["serializedBytes"])]
        for direction in choices["directions"]:
            if direction["valid"]:
                candidates.append((direction["direction"] + 1, direction["chargedScore"],
                                   direction["serializedBytes"]))
                require(direction["chargedScore"] >= direction["score"] + 2,
                        f"coefficient charge missing: {direction}")
        best = min(candidates, key=lambda item: (item[1], item[0]))
        if len(left) == 16 and left[0] == 19:
            require(all(direction["valid"] and direction["chargedScore"] == choices["disabled"]["score"]
                        for direction in choices["directions"]),
                    f"constructed off/on tie changed: {choices}")
            require(best[0] == 0, f"disabled tie preference changed: {plan}")
        require(plan["selector"] == best[0] and plan["riceBytes"] == best[1],
                f"selection mismatch: {plan} candidates={candidates}")
        if best[0] != 0:
            chosen = next(item for item in candidates if item[0] == best[0])
            require(chosen[2] <= candidates[0][2],
                    f"charged Rice winner serialized longer than disabled: {candidates}")
        checks += 3
    # Seeded score/selection coverage, including partition transitions.
    for _ in range(40):
        order = rng.randrange(0, 5)
        partition_order = rng.randrange(0, 3)
        partitions = 1 << partition_order
        blocksize = partitions * rng.randrange(max(1, order), 9)
        count = blocksize - order
        left = [rng.choice([-20, -2, -1, 0, 1, 2, 20]) for _ in range(count)]
        right = [rng.choice([-20, -2, -1, 0, 1, 2, 20]) for _ in range(count)]
        expected_left, left_k = rice_cost(left, order, partition_order)
        expected_right, right_k = rice_cost(right, order, partition_order)
        actual = run(driver, ["score", str(order), str(partition_order), str(count),
                              *ints(left), *ints(right)])
        require(actual["score"] == expected_left + expected_right and
                actual["leftK"] == left_k[0] and actual["rightK"] == right_k[0],
                f"seeded Rice mismatch at {_}: {actual}")
        checks += 1
    return checks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--sanitized", action="store_true")
    args = parser.parse_args()
    helper = args.helper.resolve()
    require(helper.is_file() and helper.stat().st_mode & 0o111,
            f"configured spatial helper is missing or not executable: {helper}")
    repo = Path(__file__).resolve().parents[4]
    native_source = repo / "research/077-lossless-delivery/iterations/round-04/native/round4.c"
    driver_source = repo / "research/077-lossless-delivery/iterations/round-04/native/round4_spatial_driver.c"
    flac_library = Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")
    test_source = Path(__file__).resolve()
    rng = random.Random(0x77040001)
    counts = {
        "profiles": test_profiles(helper),
        "features": test_floor_and_features(helper),
        "transforms": test_transforms(helper, rng),
        "fits": test_fits(helper),
        "scoresAndSelection": test_scores_and_selection(helper, rng),
    }
    receipt = {
        "format": "issue77-round4-spatial-tests-v1",
        "helper": str(helper),
        "helperSha256": sha(helper),
        "source": str(native_source.relative_to(repo)),
        "sourceSha256": sha(native_source),
        "driver": str(driver_source.relative_to(repo)),
        "driverSha256": sha(driver_source),
        "testSource": str(test_source.relative_to(repo)),
        "testSourceSha256": sha(test_source),
        "libFLAC": str(flac_library),
        "libFLACSha256": sha(flac_library),
        "compileCommand": (
            "gcc -std=c11 -O1 -g -fno-omit-frame-pointer -fno-fast-math "
            "-ffp-contract=off -fsanitize=address,undefined -Wall -Wextra "
            "-Wconversion -Wshadow -I/data/issue-77-lossless/tooling/flac-1.5.0/include "
            "research/077-lossless-delivery/iterations/round-04/native/round4_spatial_driver.c "
            "/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm "
            f"-o {helper}"
            if args.sanitized else
            "gcc -std=c11 -O2 -fno-fast-math -ffp-contract=off -Wall -Wextra "
            "-Wconversion -Wshadow -I/data/issue-77-lossless/tooling/flac-1.5.0/include "
            "research/077-lossless-delivery/iterations/round-04/native/round4_spatial_driver.c "
            "/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm "
            f"-o {helper}"
        ),
        "seed": "0x77040001",
        "sanitized": args.sanitized,
        "counts": counts,
        "totalChecks": sum(counts.values()),
        "result": "pass",
        "sanitizerDiagnostics": False,
    }
    print(json.dumps(receipt, sort_keys=True))
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, subprocess.SubprocessError) as error:
        print(f"round4 spatial tests: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
