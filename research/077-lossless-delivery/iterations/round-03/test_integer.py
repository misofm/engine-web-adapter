#!/usr/bin/env python3
"""Independent bigint checks for the round-3 Q20 FIR and Rice search.

The native fixture driver reports every state transition.  This file computes
the same contract with Python integers and compares predictions, modular
errors, restored residuals, coefficient/history/energy state, counters, and
the exhaustive 31-choice Rice costs.  It deliberately does not import the C
implementation or reuse its arithmetic helpers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys


I32_MIN = -(1 << 31)
I32_MAX = (1 << 31) - 1
U32_MASK = (1 << 32) - 1
Q20 = 1 << 20
Q20_LIMIT = Q20
PROFILES = {0: (0, 0), 1: (8, 3), 2: (8, 5), 3: (32, 3), 4: (32, 5)}
COPY_BYTES = 1024 * 1024


def fail(message: str) -> None:
    raise AssertionError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(COPY_BYTES):
            digest.update(block)
    return digest.hexdigest()


def signed_u32(value: int) -> int:
    value &= U32_MASK
    return value if value < (1 << 31) else value - (1 << 32)


def trunc_zero(numerator: int, denominator: int) -> int:
    magnitude = abs(numerator) // denominator
    return -magnitude if numerator < 0 else magnitude


def reference_trace(values: list[int], profile: int, *, inverse_errors: bool = False) -> dict:
    m, b = PROFILES[profile]
    coefficients = [0] * m
    history = [0] * m
    head = 0
    energy = 1
    counters = {"predictionClamp": 0, "coefficientClamp": 0,
                "modularWrap": 0, "updates": 0}
    steps = []
    for t, item in enumerate(values):
        prediction_sum = sum(coefficients[j] * history[(head + j) % m] for j in range(m))
        prediction = prediction_sum // Q20
        if prediction < I32_MIN:
            prediction = I32_MIN
            counters["predictionClamp"] += 1
        elif prediction > I32_MAX:
            prediction = I32_MAX
            counters["predictionClamp"] += 1
        if inverse_errors:
            original = signed_u32((item & U32_MASK) + (prediction & U32_MASK))
            encoded = item
        else:
            original = item
            encoded = signed_u32((original & U32_MASK) - (prediction & U32_MASK))
        difference = original - prediction
        if difference < I32_MIN or difference > I32_MAX:
            counters["modularWrap"] += 1
        if m and t % 4 == 3:
            ell = (energy - 1).bit_length()
            denominator = 1 << (ell + b)
            for j in range(m):
                index = (head + j) % m
                numerator = difference * history[index] * Q20
                delta = trunc_zero(numerator, denominator)
                coefficient = coefficients[j] + delta
                if coefficient < -Q20_LIMIT:
                    coefficient = -Q20_LIMIT
                    counters["coefficientClamp"] += 1
                elif coefficient > Q20_LIMIT:
                    coefficient = Q20_LIMIT
                    counters["coefficientClamp"] += 1
                coefficients[j] = coefficient
            counters["updates"] += 1
        if m:
            next_head = (head + m - 1) % m
            old = history[next_head]
            energy -= old * old
            head = next_head
            history[head] = original
            energy += original * original
        steps.append({"prediction": prediction, "encoded": encoded,
                      "recovered": original, "difference": difference,
                      "head": head, "energy": energy,
                      "coefficients": coefficients.copy(),
                      "history": [history[(head + j) % m] for j in range(m)]})
    return {"kind": "trace", "profile": profile, "steps": steps, "counters": counters}


def exhaustive_k(values: list[int], order: int, partition_order: int) -> list[int]:
    blocksize = len(values) + order
    partitions = 1 << partition_order
    require(blocksize % partitions == 0, "reference partition shape is not divisible")
    partition_size = blocksize // partitions
    result = []
    start = 0
    for partition in range(partitions):
        count = partition_size - (order if partition == 0 else 0)
        samples = values[start:start + count]
        start += count
        costs = []
        for k in range(31):
            costs.append(len(samples) * (k + 1) +
                         sum(((((value << 1) if value >= 0 else -2 * value - 1) & U32_MASK) >> k)
                             for value in samples))
        result.append(min(range(31), key=lambda k: (costs[k], k)))
    require(start == len(values), f"reference partition coverage {start} != {len(values)}")
    return result


def run(driver: Path, args: list[str]) -> dict:
    completed = subprocess.run([str(driver), *args], text=True, capture_output=True, check=False)
    require(completed.returncode == 0,
            f"native fixture failed ({completed.returncode}): {completed.stderr.strip()}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        fail(f"native fixture emitted invalid JSON: {error}: {completed.stdout[:200]}")


def compare_trace(driver: Path, values: list[int], profile: int) -> None:
    expected = reference_trace(values, profile)
    actual = run(driver, ["trace", str(profile), *map(str, values)])
    for step in actual["steps"]:
        step["energy"] = int(step["energy"])
    require(actual == expected,
            f"trace mismatch profile={profile} length={len(values)} values={values}")
    transformed = run(driver, ["transform", str(profile), *map(str, values)])
    expected_errors = [step["encoded"] for step in expected["steps"]]
    expected_recovered = [step["recovered"] for step in expected["steps"]]
    require(transformed["encoded"] == expected_errors,
            f"forward transform mismatch profile={profile}")
    require(transformed["recovered"] == expected_recovered,
            f"forward recovery mismatch profile={profile}")
    require(transformed["encodeCounters"] == expected["counters"],
            f"forward counters mismatch profile={profile}")
    inverse = reference_trace(expected_errors, profile, inverse_errors=True)
    require(transformed["decodeCounters"] == inverse["counters"],
            f"inverse counters mismatch profile={profile}")


def compare_choose(driver: Path, values: list[int], order: int, partition_order: int) -> None:
    expected = exhaustive_k(values, order, partition_order)
    actual = run(driver, ["choose", str(order), str(partition_order), *map(str, values)])
    require(actual["parameters"] == expected,
            f"k search mismatch order={order} partition={partition_order} values={values}")
    require(actual["method"] == 1, "round-3 k search did not select Rice2")


def vectors() -> list[list[int]]:
    extrema = [I32_MIN, I32_MAX, -1, 0, 1, I32_MAX, I32_MIN, 0,
               I32_MIN, I32_MAX, 7, -7, 3, -3, 0, 0]
    return [
        [], [0], [0, 0, 0], [0, 0, 0, 0], [0] * 7, [0] * 8,
        [1], [-1], [1, -1] * 4, list(range(-8, 9)),
        [I32_MIN], [I32_MAX], extrema,
        [I32_MAX] * 16, [I32_MIN] * 16,
        [I32_MAX, I32_MIN] * 32,
        [0, 0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0],
        [-1, -1, -1, -1, 1, 1, 1, 1] * 4,
    ]


def find_stress_vectors() -> dict[str, list[int]]:
    rng = random.Random(0x77030001)
    candidates = vectors()
    for _ in range(400):
        length = rng.randrange(8, 97)
        candidates.append([rng.choice([I32_MIN, I32_MAX, -1, 0, 1,
                                       rng.randrange(I32_MIN, I32_MAX + 1)])
                          for _ in range(length)])
    found: dict[str, list[int]] = {}
    for profile in (1, 2, 3, 4):
        for values in candidates:
            counters = reference_trace(values, profile)["counters"]
            for key in ("predictionClamp", "coefficientClamp", "modularWrap"):
                if counters[key] and key not in found:
                    found[key] = values
        if len(found) == 3:
            break
    require(len(found) == 3, f"stress search did not find all clamp/wrap paths: {found.keys()}")
    return found


def build_driver(args: argparse.Namespace) -> Path:
    args.build_dir.mkdir(parents=True, exist_ok=True)
    source = args.source.read_text()
    needle = "int main(int argc, char **argv) {"
    require(source.count(needle) == 1, "round3 source main shape changed")
    generated = args.build_dir / "round3_integer_source.c"
    source = source.replace('#include "../../round-02/native/round2.c"',
                            '#include "/home/bl/misofm/engine-web-adapter/research/077-lossless-delivery/iterations/round-02/native/round2.c"')
    generated.write_text(source.replace(needle,
                                        "int round3_integer_embedded_main(int argc, char **argv) {", 1))
    output = args.build_dir / ("round3-integer-san" if args.sanitized else "round3-integer")
    compiler = ["gcc", "-std=c11", "-O1" if args.sanitized else "-O2"]
    if args.sanitized:
        compiler += ["-g", "-fno-omit-frame-pointer", "-fsanitize=address,undefined"]
    compiler += ["-Wall", "-Wextra", "-Wconversion", "-Wshadow",
                 "-I" + str(args.build_dir),
                 "-I/data/issue-77-lossless/tooling/flac-1.5.0/include",
                 str(args.driver), "/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a",
                 "-lm", "-o", str(output)]
    completed = subprocess.run(compiler, text=True, capture_output=True, check=False)
    require(completed.returncode == 0,
            f"fixture driver build failed:\n{completed.stdout}\n{completed.stderr}")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--source", type=Path,
                        default=Path("research/077-lossless-delivery/iterations/round-03/native/round3.c"))
    parser.add_argument("--driver", type=Path,
                        default=Path("research/077-lossless-delivery/iterations/round-03/native/round3_integer_driver.c"))
    parser.add_argument("--sanitized", action="store_true")
    args = parser.parse_args()
    args.build_dir = args.build_dir.resolve()
    args.source = args.source.resolve()
    args.driver = args.driver.resolve()
    driver = build_driver(args)
    for profile in range(5):
        for values in vectors():
            compare_trace(driver, values, profile)
    stress = find_stress_vectors()
    for values in stress.values():
        for profile in (1, 2, 3, 4):
            compare_trace(driver, values, profile)
    rng = random.Random(0x77030002)
    choose_cases = [
        ([], 0, 0), ([0] * 8, 0, 0), ([I32_MIN], 0, 0),
        ([I32_MAX] * 8, 0, 0), ([0, 0, 0, 0], 4, 1),
        ([1, -1, 2, -2, 3, -3, 4, -4], 0, 2),
    ]
    for _ in range(300):
        order = rng.randrange(0, 5)
        partition_order = rng.randrange(0, 4)
        partitions = 1 << partition_order
        blocksize = partitions * rng.randrange(max(1, order), 65)
        count = blocksize - order
        values = [rng.choice([I32_MIN, I32_MAX, -1, 0, 1,
                              rng.randrange(I32_MIN, I32_MAX + 1)]) for _ in range(count)]
        choose_cases.append((values, order, partition_order))
    for values, order, partition_order in choose_cases:
        compare_choose(driver, values, order, partition_order)
    round1_source = Path("research/077-lossless-delivery/iterations/round-01/native/round1.c")
    round2_source = Path("research/077-lossless-delivery/iterations/round-02/native/round2.c")
    flac_library = Path("/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a")
    summary = {"format": "issue77-round3-integer-tests-v1", "driver": str(driver),
               "driverSha256": sha(driver), "sourceSha256": sha(args.source),
               "driverSourceSha256": sha(args.driver), "sanitized": args.sanitized,
               "round1DependencySha256": sha(round1_source),
               "round2DependencySha256": sha(round2_source),
               "flacLibrarySha256": sha(flac_library),
               "traceProfiles": 5, "traceVectors": 5 * len(vectors()),
               "stressPaths": sorted(stress), "chooseCases": len(choose_cases),
               "seed": "0x77030001/0x77030002", "result": "pass"}
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, subprocess.SubprocessError) as error:
        print(f"round3 integer tests: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
