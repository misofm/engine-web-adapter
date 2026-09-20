"""Independent R5 frame/plan/transcript/PCM audit over frozen R3/R4 controls."""
import argparse
import collections
import csv
import hashlib
import json
import struct
import time
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
SCRATCH = Path('/data/issue-77-lossless/iterations')
R3 = SCRATCH / 'round-03/full-final/full'
R4 = SCRATCH / 'round-04/full-final3/full'
ORIGINAL = BASE / 'iterations/round-03-evidence/root-original-audit.json'
BLOCK = 1024 * 1024
PLAN_FIELDS = ['frameOrdinal', 'blockSize', 'cheapRiceBytes', 'temporalRiceBytes',
               'stackedRiceBytes', 'selectedRiceBytes', 'selectedSelector',
               'coefficientBytes', 'predictiveResiduals', 'firResiduals', 'firUpdates']
PILOTS = {'sha256:' + sid for sid in (
    'ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1',
    '8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0',
    'fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda',
    '68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f')}


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def check(path, size, digest):
    assert path.stat().st_size == size, (path, 'size')
    assert sha(path) == digest, (path, 'sha256')


def read(source, size):
    value = source.read(size)
    assert len(value) == size, ('truncated', source.name, size)
    return value


def consume(source, count, digest):
    while count:
        data = read(source, min(count, BLOCK))
        digest.update(data)
        count -= len(data)


def zeros(digest, count):
    data = bytes(BLOCK)
    while count:
        length = min(count, BLOCK)
        digest.update(data[:length])
        count -= length


def artifact_frames(path, manifest, profile, mode, version):
    result, selectors = [], collections.Counter()
    content_hash = hashlib.sha256()
    with path.open('rb') as source:
        header = read(source, 32)
        magic, imode, shape, iprofile, flags, mlen, count, tables = struct.unpack('<8sBBBBQQI', header)
        assert magic == {3: b'I77FIR03', 4: b'I77XCH04', 5: b'I77MIX05'}[version]
        assert (imode, shape, iprofile, flags, mlen) == (
            int(mode == 'rans'), 1, profile, 2 if version == 5 else 0, len(manifest))
        assert mlen <= BLOCK and tables <= 620 and (mode != 'rice' or tables == 0)
        embedded = read(source, mlen)
        assert embedded == manifest
        content_hash.update(embedded)
        previous = None
        for _ in range(tables):
            raw = read(source, 37)
            role, k, context, *frequencies = struct.unpack('<BBB17H', raw)
            key = (role, k, context)
            assert role < 4 and k < 31 and context < 5 and sum(frequencies) == 4096
            assert previous is None or previous < key
            previous = key
            content_hash.update(raw)
        for _ in range(count):
            raw_length = read(source, 4)
            length = struct.unpack('<I', raw_length)[0]
            assert 4 <= length <= 4 * BLOCK
            body = read(source, length)
            block, assignment, selector = struct.unpack_from('<HBB', body)
            legal = (0,) if version == 3 else (0, 1, 2) if version == 4 else (0, 1, 2, 4, 5, 6)
            assert block > 0 and assignment <= 3 and selector in legal
            if version == 5 and profile == 0:
                assert selector < 4
            direction = selector & 3
            taps = (1 if profile == 1 else 5) if version == 4 and direction else 5 if direction else 0
            coeff = struct.unpack_from(f'<{taps}h', body, 4) if taps else ()
            assert all(-16384 <= value <= 16384 for value in coeff)
            assert not direction or any(coeff)
            normalized = body[:3] + bytes([0]) + body[4:]
            result.append({'bytes': length + 4, 'block': block, 'assignment': assignment,
                           'selector': selector, 'coefficients': list(coeff),
                           'bodySha256': hashlib.sha256(body).hexdigest(),
                           'temporalBodySha256': hashlib.sha256(normalized).hexdigest()})
            selectors[selector] += 1
            content_hash.update(raw_length + body)
        assert not source.read(1)
    return result, content_hash.hexdigest(), selectors


def audit_frames(path, count, version):
    """Hash each coded subframe independently, excluding pipeline selectors."""
    result = []
    with path.open('rb') as source:
        assert read(source, 8) == b'I77AUD02'
        for _ in range(count):
            block, assignment, selector = struct.unpack('<HBB', read(source, 4))
            direction = selector & 3 if version >= 4 else 0
            coefficients = read(source, 10) if direction else b''
            counts, updates, sub_hashes = [], [], []
            for _channel in range(2):
                raw = read(source, 12)
                kind, wasted, order, precision, shift, method, partition_order, reserved, n = struct.unpack('<8BI', raw)
                assert kind <= 3 and reserved == 0 and n <= 65535 and order <= 32 and partition_order <= 15
                digest = hashlib.sha256(raw)
                consume(source, order * 4 + (order * 4 if kind == 3 else 0), digest)
                consume(source, (2 * (1 << partition_order)) if kind in (2, 3) else 0, digest)
                consume(source, n * 4, digest)
                sub_hashes.append(digest.hexdigest())
                counts.append(n if kind in (2, 3) else 0)
                updates.append(n // 4 if kind in (2, 3) else 0)
            result.append({'block': block, 'assignment': assignment, 'selector': selector,
                           'coefficients': coefficients.hex(), 'subHashes': sub_hashes,
                           'predictiveResiduals': sum(counts), 'firUpdates': sum(updates)})
        assert not source.read(1)
    return result


def verify_pcm(path, row, manifest):
    check(path, row['activePcmBytes'], row['packedPcmSha256'])
    with path.open('rb') as source:
        for chunk in manifest['chunks']:
            digest = hashlib.sha256()
            consume(source, chunk['frames'] * 6, digest)
            assert digest.hexdigest() == chunk['pcmSha256']
        assert not source.read(1)
    digest, end, packed = hashlib.sha256(), 0, 0
    with path.open('rb') as source:
        for interval in manifest['intervals']:
            assert interval['startFrame'] >= end and interval['packedFrameOffset'] == packed
            zeros(digest, (interval['startFrame'] - end) * 6)
            consume(source, interval['frames'] * 6, digest)
            end = interval['startFrame'] + interval['frames']
            packed += interval['frames']
        zeros(digest, (manifest['frames'] - end) * 6)
        assert not source.read(1)
    assert digest.hexdigest() == row['identity'].split(':')[1]


def verify_plan(path, policy, actual, cheap, temporal, coded, cheap_coded, temporal_coded):
    with path.open(newline='') as source:
        reader = csv.DictReader(source)
        assert reader.fieldnames == PLAN_FIELDS
        rows = list(reader)
    assert len(rows) == len(actual) == len(cheap) == len(temporal) == len(coded)
    totals = collections.Counter()
    for i, (raw, frame, cframe, tframe, sub, csub, tsub) in enumerate(
            zip(rows, actual, cheap, temporal, coded, cheap_coded, temporal_coded)):
        values = {k: None if v == 'NA' else int(v) for k, v in raw.items()}
        assert all(v is None or v >= 0 for v in values.values())
        assert values['frameOrdinal'] == i and values['blockSize'] == frame['block'] == cframe['block'] == tframe['block']
        assert frame['block'] == sub['block'] == csub['block'] == tsub['block']
        assert frame['assignment'] == cframe['assignment'] == tframe['assignment'] == sub['assignment'] == csub['assignment'] == tsub['assignment']
        assert values['cheapRiceBytes'] == cframe['bytes']
        assert frame['selector'] == sub['selector'] == values['selectedSelector']
        assert values['coefficientBytes'] == 2 * len(frame['coefficients'])
        assert sub['coefficients'] == struct.pack(f"<{len(frame['coefficients'])}h", *frame['coefficients']).hex()
        n = sub['predictiveResiduals']
        assert values['predictiveResiduals'] == n == csub['predictiveResiduals'] == tsub['predictiveResiduals']
        assert values['firResiduals'] == (n if frame['selector'] & 4 else 0)
        assert values['firUpdates'] == (sub['firUpdates'] if frame['selector'] & 4 else 0)
        c, t, h = (values[k] for k in ('cheapRiceBytes', 'temporalRiceBytes', 'stackedRiceBytes'))
        if policy == 0 or n == 0:
            assert t is None and h is None
            expected_selector, cost = cframe['selector'], c
        else:
            assert t == tframe['bytes'] and h is not None
            if cframe['selector'] == 0:
                assert h == t
            if t <= h:
                expensive_selector, expensive_cost = 4, t
            else:
                expensive_selector, expensive_cost = cframe['selector'] | 4, h
            threshold = 0 if policy == 1 else 32
            if c > expensive_cost and c - expensive_cost > threshold:
                expected_selector, cost = expensive_selector, expensive_cost
            else:
                expected_selector, cost = cframe['selector'], c
        assert frame['selector'] == expected_selector
        assert values['selectedRiceBytes'] == cost <= c
        if frame['selector'] < 4:
            assert sub['subHashes'] == csub['subHashes'] and sub['coefficients'] == csub['coefficients']
        elif frame['selector'] == 4:
            assert sub['subHashes'] == tsub['subHashes']
        else:
            assert sub['coefficients'] == csub['coefficients']
            direction = (frame['selector'] & 3) - 1
            assert sub['subHashes'][direction] == tsub['subHashes'][direction]
        totals['frameChecks'] += 1
        totals['cheapFrames'] += frame['selector'] < 4
        totals['temporalFrames'] += frame['selector'] == 4
        totals['stackedFrames'] += frame['selector'] in (5, 6)
        totals['firFrames'] += bool(frame['selector'] & 4)
        totals['spatialFrames'] += bool(frame['selector'] & 3)
        totals['reference0Frames'] += (frame['selector'] & 3) == 1
        totals['reference1Frames'] += (frame['selector'] & 3) == 2
        for key in ('coefficientBytes', 'predictiveResiduals', 'firResiduals', 'firUpdates'):
            totals[key] += values[key]
        totals['selectedRiceBytes'] += cost
    return rows, dict(totals)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    work = args.work.resolve()
    started = time.monotonic()
    result_path = work / ('pilot-results.json' if (work / 'pilot-results.json').exists() else 'results.json')
    result = json.loads(result_path.read_text())
    frozen = json.loads((work / 'freeze.json').read_text())
    results_sha, freeze_sha = sha(result_path), sha(work / 'freeze.json')
    assert result['format'] == 'issue77-round5-results-v1'
    assert frozen['format'] == 'issue77-round5-freeze-v1'
    assert result['runKind'] == frozen['runKind'] in ('pilot', 'sanitized-pilot', 'full')
    assert result['freezeSha256'] == sha(work / 'freeze.json')
    for label, value in frozen['files'].items():
        check(Path(value['path']), value['bytes'], value['sha256'])
    for stem, entries in frozen['inputFiles'].items():
        for label, value in entries.items():
            check(Path(value['path']), value['bytes'], value['sha256'])
    for field, relative in {'nativeSha256': 'round-05/native/round5.c',
                            'runnerSha256': 'round-05/round5.py',
                            'scopeSha256': 'round-05-scope.md'}.items():
        assert frozen[field] == sha(BASE / 'iterations' / relative), field
    assert frozen['helper']['sha256'] == sha(Path(frozen['helper']['path']))
    original = {r['identity']: r for r in json.loads(ORIGINAL.read_text())['stems']}
    assert frozen['files']['originalAudit']['sha256'] == sha(ORIGINAL)
    for version in (3, 4):
        assert frozen['prior'][f'round{version}ResultsSha256'] == sha(
            BASE / f'iterations/round-0{version}-evidence/full-results.json')
    prior = {v: {r['identity']: r for r in json.loads((BASE / f'iterations/round-0{v}-evidence/full-results.json').read_text())['stems']}
             for v in (3, 4)}
    expected_ids = set(original) if result['runKind'] == 'full' else PILOTS
    expected_policies = [1, 2] if result['runKind'] == 'sanitized-pilot' else [0, 1, 2]
    assert frozen['policies'] == expected_policies
    assert {r['identity'] for r in result['stems']} == expected_ids
    assert len(result['stems']) == result['stemCount'] == len(expected_ids)
    receipts, artifact_count, chunk_count, frame_checks = [], 0, 0, 0
    for row in result['stems']:
        assert set(row['policies']) == {str(p) for p in expected_policies}
        identity = row['identity']
        sid = identity.split(':')[1]
        root = work / result['runKind'] / sid
        manifest_bytes = (BASE / 'manifests' / f'{sid}.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        reference = original[identity]
        controls = {}
        for version, directory, profile in ((3, R3, 3), (4, R4, 2)):
            controls[version] = {}
            for mode in ('rice', 'rans'):
                value = prior[version][identity]['profiles'][str(profile)][mode]
                suffix = 'fir' if version == 3 else 'xch'
                path = directory / sid / f'p{profile}-{mode}.{suffix}'
                check(path, value['outputBytes'], value['outputSha256'])
                frames = artifact_frames(path, manifest_bytes, profile, mode, version)
                audit = directory / sid / f'p{profile}-{mode}.coded.audit'
                check(audit, value['auditBytes'], value['codedAuditSha256'])
                transcript = audit_frames(audit, len(frames[0]), version)
                controls[version][mode] = (frames, transcript)
        checked = {}
        for policy_text, modes in row['policies'].items():
            policy = int(policy_text)
            assert set(modes) == {'rice', 'rans'}
            for mode, value in modes.items():
                key = f'p{policy}-{mode}'
                path = root / f'{key}.mix'
                check(path, value['outputBytes'], value['outputSha256'])
                enc, dec = value['encodeSummary'], value['decodeSummary']
                assert enc['format'] == 'issue77-round5-summary-v1'
                assert enc['mode'] == int(mode == 'rans') and enc['policy'] == policy
                assert enc['recordCount'] == enc['inputRecordCount'] == enc['frameCount'] == reference['recordCount']
                for name in enc:
                    if name not in ('planRows', 'fitDegenerate', 'fitFailures', 'coefficientClipping'):
                        assert enc[name] == dec[name], (key, name)
                assert enc['planRows'] == enc['frameCount'] and dec['planRows'] == 0
                assert path.stat().st_size == 32 + len(manifest_bytes) + enc['tableBytes'] + enc['frameBytes']
                assert enc['frameBytes'] == (8 * enc['frameCount'] + enc['coefficientBytes'] + enc['sideBytes'] +
                       8 * enc['predictiveSubframes'] + enc['entropyBytes'] + enc['bypassBytes'])
                actual, content_hash, selectors = artifact_frames(path, manifest_bytes, policy, mode, 5)
                assert len(actual) == reference['recordCount'] == enc['frameCount']
                if policy == 0:
                    assert content_hash == controls[4][mode][0][1], (sid, mode, 'cheap control')
                for suffix in ('original.audit', 'decode.original.audit'):
                    check(root / f'{key}.{suffix}', reference['originalAuditBytes'], reference['originalAuditSha256'])
                assert value['originalAuditSha256'] == reference['originalAuditSha256']
                for suffix in ('coded.audit', 'decode.coded.audit'):
                    check(root / f'{key}.{suffix}', value['auditBytes'], value['codedAuditSha256'])
                coded = audit_frames(root / f'{key}.coded.audit', len(actual), 5)
                plan_path = root / f'{key}.plan.csv'
                check(plan_path, value['planBytes'], value['planSha256'])
                plans, counters = verify_plan(plan_path, policy, actual, controls[4]['rice'][0][0],
                    controls[3]['rice'][0][0], coded, controls[4][mode][1], controls[3][mode][1])
                for name, total in counters.items():
                    if name not in ('frameChecks', 'selectedRiceBytes'):
                        assert enc[name] == total, (key, name, enc[name], total)
                if mode == 'rice':
                    for i, frame in enumerate(actual):
                        assert frame['bytes'] == int(plans[i]['selectedRiceBytes'])
                        if frame['selector'] < 4:
                            assert frame['bodySha256'] == controls[4]['rice'][0][0][i]['bodySha256']
                        elif frame['selector'] == 4:
                            assert frame['temporalBodySha256'] == controls[3]['rice'][0][0][i]['bodySha256']
                verify_pcm(root / f'{key}.raw', row, manifest)
                chunk_count += len(manifest['chunks'])
                frame_checks += len(actual)
                checked[key] = {'bytes': value['outputBytes'], 'sha256': value['outputSha256'],
                    'planSha256': value['planSha256'], 'originalAuditSha256': reference['originalAuditSha256'],
                    'codedAuditSha256': value['codedAuditSha256'], 'canonicalPcmSha256': sid,
                    'planCounters': counters}
                artifact_count += 1
            assert modes['rice']['codedAuditSha256'] == modes['rans']['codedAuditSha256']
            assert modes['rice']['planSha256'] == modes['rans']['planSha256']
        receipts.append({'identity': identity, 'artifacts': checked})
        print(len(receipts), sid[:8], flush=True)
    assert artifact_count == len(expected_ids) * len(expected_policies) * 2
    for policy in expected_policies:
        for mode in ('rice', 'rans'):
            assert result['totals'][f'p{policy}-{mode}']['outputBytes'] == sum(
                r['policies'][str(policy)][mode]['outputBytes'] for r in result['stems'])
    assert sha(result_path) == results_sha and sha(work / 'freeze.json') == freeze_sha
    for label, value in frozen['files'].items():
        check(Path(value['path']), value['bytes'], value['sha256'])
    for stem, entries in frozen['inputFiles'].items():
        for label, value in entries.items():
            check(Path(value['path']), value['bytes'], value['sha256'])
    receipt = {'format': 'issue77-round5-root-audit-v1', 'work': str(work), 'runKind': result['runKind'],
               'scriptSha256': sha(Path(__file__)), 'resultsSha256': sha(result_path),
               'freezeSha256': sha(work / 'freeze.json'), 'originalAuditReferenceSha256': sha(ORIGINAL),
               'artifactCount': artifact_count, 'chunkHashChecks': chunk_count, 'framePlanChecks': frame_checks,
               'allChecksPassed': True, 'elapsedSeconds': time.monotonic() - started,
               'completedUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'stems': receipts}
    (work / 'root-verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('PASS', artifact_count, 'artifacts;', frame_checks, 'frame/plan checks')


if __name__ == '__main__':
    main()
