"""Independent round-4 artifact/PCM audit and actual Rice frame-cost comparison."""
import argparse
import csv
import hashlib
import json
import struct
import time
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
R3 = Path('/data/issue-77-lossless/iterations/round-03/full-final/full')
ORIGINAL = BASE / 'iterations/round-03-evidence/root-original-audit.json'
BLOCK = 1024 * 1024


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def check(path, size, digest):
    assert path.stat().st_size == size, (path, 'size')
    assert sha(path) == digest, (path, 'sha256')


def consume(source, count, digest):
    while count:
        data = source.read(min(count, BLOCK))
        assert data
        digest.update(data)
        count -= len(data)


def zeros(digest, count):
    data = bytes(BLOCK)
    while count:
        n = min(count, BLOCK)
        digest.update(data[:n])
        count -= n


def frames(path, manifest, profile, mode, spatial):
    result = []
    after_magic = hashlib.sha256()
    coefficient_bytes = 0
    selectors = [0, 0, 0]
    with path.open('rb') as source:
        header = source.read(32)
        magic, imode, shape, iprofile, flags, mlen, count, tables = struct.unpack('<8sBBBBQQI', header)
        assert magic == (b'I77XCH04' if spatial else b'I77FIR03')
        assert (imode, shape, iprofile, flags, mlen) == (int(mode == 'rans'), 1, profile, 0, len(manifest))
        assert tables <= 620 and (mode != 'rice' or tables == 0)
        embedded = source.read(mlen)
        assert embedded == manifest
        after_magic.update(header[8:] + embedded)
        previous = None
        for _ in range(tables):
            raw = source.read(37)
            role, k, ctx, *freq = struct.unpack('<BBB17H', raw)
            key = (role, k, ctx)
            assert role < 4 and k < 31 and ctx < 5 and sum(freq) == 4096
            assert previous is None or previous < key
            previous = key
            after_magic.update(raw)
        while raw_length := source.read(4):
            assert len(raw_length) == 4
            length = struct.unpack('<I', raw_length)[0]
            assert 4 <= length <= 4194304
            body = source.read(length)
            assert len(body) == length
            block, assignment, selector = struct.unpack_from('<HBB', body)
            assert block > 0 and assignment <= 3
            assert selector <= (2 if spatial else 0)
            assert profile != 0 or selector == 0
            taps = (1 if profile == 1 else 5) if spatial and selector else 0
            coeff = struct.unpack_from(f'<{taps}h', body, 4) if taps else ()
            assert all(-16384 <= value <= 16384 for value in coeff)
            assert not selector or any(coeff)
            coefficient_bytes += 2 * taps
            selectors[selector] += 1
            result.append({'bytes': length + 4, 'block': block, 'assignment': assignment,
                           'selector': selector, 'coefficients': list(coeff),
                           'bodySha256': hashlib.sha256(body).hexdigest()})
            after_magic.update(raw_length + body)
        assert len(result) == count
    return result, after_magic.hexdigest(), coefficient_bytes, selectors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    work = args.work.resolve()
    started = time.monotonic()
    pilot = (work / 'pilot-results.json').exists()
    result_path = work / ('pilot-results.json' if pilot else 'results.json')
    result = json.loads(result_path.read_text())
    frozen = json.loads((work / 'freeze.json').read_text())
    assert result['freezeSha256'] == sha(work / 'freeze.json')
    dependencies = {'nativeSha256': 'round-04/native/round4.c', 'runnerSha256': 'round-04/round4.py',
                    'scopeSha256': 'round-04-scope.md', 'round3NativeSha256': 'round-03/native/round3.c',
                    'round2NativeSha256': 'round-02/native/round2.c', 'round2RunnerSha256': 'round-02/round2.py',
                    'round1NativeSha256': 'round-01/native/round1.c'}
    for key, relative in dependencies.items():
        assert frozen[key] == sha(BASE / 'iterations' / relative), key
    for key, relative in {
        'round3EvidenceSha256': 'iterations/round-03-evidence/full-results.json',
        'round3FreezeSha256': 'iterations/round-03-evidence/full-freeze.json',
        'sourcesSha256': 'sources.json', 'baselineEvidenceSha256': 'evidence/results.json',
        'r1VerificationSha256': 'iterations/round-01-evidence/verification.json',
        'r1RootVerificationSha256': 'iterations/round-01-evidence/root-verification.json',
    }.items():
        assert frozen[key] == sha(BASE / relative), key
    assert frozen['helper']['sha256'] == sha(Path(frozen['helper']['path']))
    assert frozen['independentOriginalAuditSha256'] == sha(ORIGINAL)
    original = {row['identity']: row for row in json.loads(ORIGINAL.read_text())['stems']}
    r3_result = json.loads((BASE / 'iterations/round-03-evidence/full-results.json').read_text())
    r3_rows = {row['identity']: row for row in r3_result['stems']}
    rows, frame_rows = [], []
    artifact_count = chunk_count = 0
    for row in result['stems']:
        identity = row['identity']
        sid = identity.split(':')[1]
        root = work / result['runKind'] / sid
        manifest = (BASE / 'manifests' / f'{sid}.json').read_bytes()
        parsed = json.loads(manifest)
        reference = original[identity]
        for p, mode in ((0, 'rice'), (0, 'rans'), (3, 'rice')):
            value = r3_rows[identity]['profiles'][str(p)][mode]
            check(R3 / sid / f'p{p}-{mode}.fir', value['outputBytes'], value['outputSha256'])
        baseline = {mode: frames(R3 / sid / f'p0-{mode}.fir', manifest, 0, mode, False)
                    for mode in ('rice', 'rans')}
        temporal = frames(R3 / sid / 'p3-rice.fir', manifest, 3, 'rice', False)[0]
        checked = {}
        for profile_text, modes in row['profiles'].items():
            profile = int(profile_text)
            for mode, value in modes.items():
                key = f'p{profile}-{mode}'
                path = root / f'{key}.xch'
                check(path, value['outputBytes'], value['outputSha256'])
                enc, dec = value['encodeSummary'], value['decodeSummary']
                for name in enc:
                    if name not in ('fitDegenerate', 'fitFailures', 'coefficientClipping'):
                        assert enc[name] == dec[name], (key, name)
                assert path.stat().st_size == 32 + len(manifest) + enc['tableBytes'] + enc['frameBytes']
                assert enc['frameBytes'] == (8 * enc['frameCount'] + enc['coefficientBytes'] +
                       enc['sideBytes'] + 8 * enc['predictiveSubframes'] + enc['entropyBytes'] + enc['bypassBytes'])
                actual, after_magic, coeff_bytes, selectors = frames(path, manifest, profile, mode, True)
                assert len(actual) == reference['recordCount'] == enc['frameCount']
                assert len(actual) == len(baseline[mode][0]) == len(temporal)
                assert coeff_bytes == enc['coefficientBytes']
                assert selectors == [enc['disabledFrames'], enc['reference0Frames'], enc['reference1Frames']]
                if profile == 0:
                    assert after_magic == baseline[mode][1], (sid, mode, 'disabled control')
                if mode == 'rice':
                    for ordinal, (item, control, fir) in enumerate(zip(actual, baseline[mode][0], temporal)):
                        assert (item['block'], item['assignment']) == (control['block'], control['assignment'])
                        assert item['bytes'] <= control['bytes'], (sid, ordinal, 'Rice frame grew')
                        if item['selector'] == 0:
                            assert item['bodySha256'] == control['bodySha256']
                        frame_rows.append({'identity': identity, 'profile': profile, 'frame': ordinal,
                            'blocksize': item['block'], 'assignment': item['assignment'],
                            'selector': item['selector'], 'coefficientBytes': 2 * len(item['coefficients']),
                            'coefficientsQ12': '/'.join(map(str, item['coefficients'])),
                            'disabledRiceBytes': control['bytes'], 'spatialRiceBytes': item['bytes'],
                            'pureFirRiceBytes': fir['bytes']})
                for suffix in ('original.audit', 'decode.original.audit'):
                    check(root / f'{key}.{suffix}', reference['originalAuditBytes'], reference['originalAuditSha256'])
                assert value['originalAuditSha256'] == reference['originalAuditSha256']
                for suffix in ('coded.audit', 'decode.coded.audit'):
                    check(root / f'{key}.{suffix}', value['auditBytes'], value['codedAuditSha256'])
                pcm = root / f'{key}.raw'
                check(pcm, row['activePcmBytes'], row['packedPcmSha256'])
                with pcm.open('rb') as source:
                    for chunk in parsed['chunks']:
                        digest = hashlib.sha256()
                        consume(source, chunk['frames'] * 6, digest)
                        assert digest.hexdigest() == chunk['pcmSha256']
                        chunk_count += 1
                    assert not source.read(1)
                digest, end, packed = hashlib.sha256(), 0, 0
                with pcm.open('rb') as source:
                    for interval in parsed['intervals']:
                        assert interval['startFrame'] >= end and interval['packedFrameOffset'] == packed
                        zeros(digest, (interval['startFrame'] - end) * 6)
                        consume(source, interval['frames'] * 6, digest)
                        end = interval['startFrame'] + interval['frames']
                        packed += interval['frames']
                    zeros(digest, (parsed['frames'] - end) * 6)
                    assert not source.read(1)
                assert digest.hexdigest() == sid
                checked[key] = {'bytes': value['outputBytes'], 'sha256': value['outputSha256'],
                                'originalAuditSha256': reference['originalAuditSha256'],
                                'codedAuditSha256': value['codedAuditSha256'], 'canonicalPcmSha256': sid,
                                'selectorCounts': selectors, 'coefficientBytes': coeff_bytes}
                artifact_count += 1
            assert modes['rice']['codedAuditSha256'] == modes['rans']['codedAuditSha256']
        rows.append({'identity': identity, 'artifacts': checked})
        print(len(rows), sid[:8], flush=True)
    if pilot and frozen['profiles'] == [0, 1, 2]:
        selection = json.loads((work / 'selection.json').read_text())
        candidates = [{'profile': p, 'ransBytes': sum(r['profiles'][str(p)]['rans']['outputBytes']
                       for r in result['stems'])} for p in (1, 2)]
        candidates.sort(key=lambda x: (x['ransBytes'], x['profile']))
        assert selection['profiles'] == candidates
        assert selection['selectedProfile'] == result['selectedProfile'] == candidates[0]['profile']
        assert selection['pilotResultsSha256'] == sha(result_path)
    costs = work / 'root-frame-costs.csv'
    with costs.open('w', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=list(frame_rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(frame_rows)
    receipt = {'format': 'issue77-round4-root-audit-v1', 'work': str(work), 'pilot': pilot,
               'scriptSha256': sha(Path(__file__)), 'resultsSha256': sha(result_path),
               'freezeSha256': sha(work / 'freeze.json'), 'originalAuditReferenceSha256': sha(ORIGINAL),
               'artifactCount': artifact_count, 'chunkHashChecks': chunk_count,
               'riceFrameChecks': len(frame_rows), 'frameCostsSha256': sha(costs),
               'allChecksPassed': True, 'elapsedSeconds': time.monotonic() - started, 'stems': rows}
    (work / 'root-verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('PASS', artifact_count, 'artifacts;', len(frame_rows), 'Rice frame checks')


if __name__ == '__main__':
    main()
