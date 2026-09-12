"""Adversarial checks for the experiment's exact-PCM acceptance gates."""

import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import run


def stereo(left, right):
    return left.to_bytes(3, "little", signed=True) + right.to_bytes(3, "little", signed=True)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root / "source.raw"
        self.packed = self.root / "packed.raw"
        self.active = stereo(-8388608, 8388607) + stereo(1, -1)
        self.dense = bytes(6) + self.active[:6] + bytes(12) + self.active[6:] + bytes(6)
        self.raw.write_bytes(self.dense)
        self.manifest = {
            "format": "miso_sparse_stem_v1", "bitDepth": 24, "channels": 2,
            "sampleRateHz": 44100, "frames": 6,
            "identity": "sha256:" + hashlib.sha256(self.dense).hexdigest(),
            "intervals": [
                {"startFrame": 1, "frames": 1, "packedFrameOffset": 0},
                {"startFrame": 4, "frames": 1, "packedFrameOffset": 1},
            ],
            "chunks": [{"packedStartFrame": 0, "offset": 0, "frames": 2, "bytes": 123}],
        }

    def test_exact_signed_extrema_and_single_lsb_survive_gaps(self):
        self.assertEqual(run.validate_manifest(self.manifest), 2)
        run.pack_active(self.raw, self.packed, self.manifest)
        self.assertEqual(self.packed.read_bytes(), self.active)
        self.assertEqual(run.reconstructed_hash(self.packed, self.manifest),
                         hashlib.sha256(self.dense).hexdigest())

    def test_nonzero_omitted_leading_middle_and_trailing_bytes_rejected(self):
        for byte in [0, 12, 30]:
            with self.subTest(byte=byte):
                corrupted = bytearray(self.dense)
                corrupted[byte] = 1
                self.raw.write_bytes(corrupted)
                with self.assertRaisesRegex(ValueError, "omit nonzero"):
                    run.pack_active(self.raw, self.packed, self.manifest)

    def test_swapped_channels_rejected(self):
        self.packed.write_bytes(b"".join(self.active[n + 3:n + 6] + self.active[n:n + 3]
                                         for n in range(0, len(self.active), 6)))
        with self.assertRaisesRegex(ValueError, "PCM mismatch"):
            run.reconstructed_hash(self.packed, self.manifest)

    def test_truncated_and_trailing_packed_pcm_rejected(self):
        for data in [self.active[:-1], self.active + b"\0"]:
            with self.subTest(length=len(data)):
                self.packed.write_bytes(data)
                with self.assertRaises(ValueError):
                    run.reconstructed_hash(self.packed, self.manifest)

    def test_truncated_and_trailing_original_pcm_rejected(self):
        for data in [self.dense[:-1], self.dense + b"\0"]:
            with self.subTest(length=len(data)):
                self.raw.write_bytes(data)
                with self.assertRaises(ValueError):
                    run.pack_active(self.raw, self.packed, self.manifest)

    def test_overlap_bad_packed_offset_and_chunk_mismatch_rejected(self):
        for target, key, value in [("intervals", "startFrame", 1),
                                   ("intervals", "packedFrameOffset", 0),
                                   ("intervals", "frames", 9),
                                   ("chunks", "frames", 1),
                                   ("chunks", "offset", 1)]:
            with self.subTest(target=target, key=key):
                bad = copy.deepcopy(self.manifest)
                bad[target][-1][key] = value
                with self.assertRaises(ValueError):
                    run.validate_manifest(bad)

    def test_transfer_bounds_and_short_input(self):
        class Bounded(io.BytesIO):
            def read(self, count=-1):
                self_test.assertLessEqual(count, run.COPY_BYTES)
                return super().read(count)
        self_test = self
        with self.assertRaisesRegex(ValueError, "Truncated"):
            run.transfer(Bounded(bytes(run.COPY_BYTES + 7)), run.COPY_BYTES + 8)

    def test_portable_publication_baseline(self):
        catalog = json.loads((run.HERE / "sources.json").read_text())
        self.assertEqual(len(catalog["stems"]), 30)
        self.assertEqual(sum(s["originalTransportBytes"] for s in catalog["stems"]), 431666252)
        self.assertEqual(sum(s["bytes"] for s in catalog["stems"]), 434311756)
        self.assertEqual(sum(s["omittedPcmBytes"] for s in catalog["stems"]), 336328926)
        for source in catalog["stems"]:
            path = run.HERE / source["manifestPath"]
            run.check_file(path, source["manifestBytes"], source["manifestSha256"])
            manifest = json.loads(path.read_bytes())
            self.assertEqual(run.validate_manifest(manifest) * 6, source["activePcmBytes"])
            self.assertEqual(manifest["identity"], source["identity"])
            self.assertEqual(sum(c["bytes"] for c in manifest["chunks"]), source["payloadBytes"])
            self.assertEqual(source["bytes"], 16 + source["manifestBytes"] + source["payloadBytes"])


if __name__ == "__main__":
    unittest.main()
