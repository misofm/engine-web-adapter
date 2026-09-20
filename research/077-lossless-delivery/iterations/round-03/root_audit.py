"""Independent round-3 artifact, original-record transcript, and PCM audit."""
import argparse,hashlib,json,struct,time
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True);args=parser.parse_args()
B=Path('/home/bl/misofm/engine-web-adapter/research/077-lossless-delivery');W=args.work
P=Path('/data/issue-77-lossless/iterations/round-03/root-original-audit.json')
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def check(p,n,h):
 assert p.stat().st_size==n,(p,'size');assert sha(p)==h,(p,'sha')
def take(f,n,d):
 while n:
  x=f.read(min(n,1048576));assert x;d.update(x);n-=len(x)
def zeros(d,n):
 z=bytes(1048576)
 while n:k=min(n,len(z));d.update(z[:k]);n-=k
start=time.monotonic();pilot=(W/'pilot-results.json').exists();rp=W/('pilot-results.json' if pilot else 'results.json');r=json.loads(rp.read_text());f=json.loads((W/'freeze.json').read_text());assert r['freezeSha256']==sha(W/'freeze.json')
for key,path in [('nativeSha256','round-03/native/round3.c'),('runnerSha256','round-03/round3.py'),('scopeSha256','round-03-scope.md'),('round1NativeSha256','round-01/native/round1.c'),('round2NativeSha256','round-02/native/round2.c'),('round2RunnerSha256','round-02/round2.py')]:assert sha(B/'iterations'/path)==f[key],key
assert sha(Path(f['helper']['path']))==f['helper']['sha256'];assert sha(P)==f['independentOriginalAuditSha256']
orig={x['identity']:x for x in json.loads(P.read_text())['stems']};rows=[];chunks=files=0
for row in r['stems']:
 sid=row['identity'].split(':')[1];manifest=(B/'manifests'/f'{sid}.json').read_bytes();m=json.loads(manifest);stem=W/('pilot' if pilot else 'full')/sid;reference=orig[row['identity']];checked={}
 for profile,modes in row['profiles'].items():
  for mode,v in modes.items():
   key=f'p{profile}-{mode}';p=stem/f'{key}.fir';s=v['encodeSummary'];assert s==v['decodeSummary'];check(p,v['outputBytes'],v['outputSha256'])
   assert p.stat().st_size==32+len(manifest)+s['tableBytes']+s['frameBytes']
   assert s['frameBytes']==8*s['frameCount']+s['sideBytes']+8*s['predictiveSubframes']+s['entropyBytes']+s['bypassBytes']
   with p.open('rb') as source:
    magic,mode_id,shape,prof,reserved,mlen,nrec,nt=struct.unpack('<8sBBBBQQI',source.read(32));assert (magic,mode_id,shape,prof,reserved,mlen,nrec,nt)==(b'I77FIR03',int(mode=='rans'),1,int(profile),0,len(manifest),reference['recordCount'],s['tableCount']);assert source.read(mlen)==manifest
    previous=None
    for _ in range(nt):
     role,k,ctx,*freq=struct.unpack('<BBB17H',source.read(37));table=(role,k,ctx);assert role<4 and k<31 and ctx<5 and sum(freq)==4096;assert previous is None or table>previous;previous=table
    records=0
    while raw:=source.read(4):
     assert len(raw)==4;length=struct.unpack('<I',raw)[0];assert 4<=length<=4194304;assert len(source.read(length))==length;records+=1
    assert records==nrec
   for suffix in ['original.audit','decode.original.audit']:check(stem/f'{key}.{suffix}',reference['originalAuditBytes'],reference['originalAuditSha256'])
   assert v['originalAuditSha256']==reference['originalAuditSha256']
   for suffix in ['coded.audit','decode.coded.audit']:check(stem/f'{key}.{suffix}',v['auditBytes'],v['codedAuditSha256'])
   pcm=stem/f'{key}.raw';check(pcm,row['activePcmBytes'],row['packedPcmSha256'])
   with pcm.open('rb') as source:
    for chunk in m['chunks']:
     h=hashlib.sha256();take(source,chunk['frames']*6,h);assert h.hexdigest()==chunk['pcmSha256'];chunks+=1
    assert not source.read(1)
   h=hashlib.sha256();end=packed=0
   with pcm.open('rb') as source:
    for interval in m['intervals']:
     assert interval['startFrame']>=end and interval['packedFrameOffset']==packed
     zeros(h,(interval['startFrame']-end)*6);take(source,interval['frames']*6,h);end=interval['startFrame']+interval['frames'];packed+=interval['frames']
    zeros(h,(m['frames']-end)*6);assert not source.read(1)
   assert h.hexdigest()==sid
   checked[key]={'fileBytes':v['outputBytes'],'fileSha256':v['outputSha256'],'originalAuditSha256':reference['originalAuditSha256'],'codedAuditSha256':v['codedAuditSha256'],'canonicalPcmSha256':sid};files+=1
  assert modes['rice']['codedAuditSha256']==modes['rans']['codedAuditSha256']
 rows.append({'identity':row['identity'],'artifacts':checked});print(len(rows),sid[:8],flush=True)
if pilot and f["profiles"] == [0,1,2,3,4]:
 sel=json.loads((W/'selection.json').read_text());candidates=[{'profile':p,'ransBytes':sum(x['profiles'][str(p)]['rans']['outputBytes'] for x in r['stems'])} for p in range(1,5)];candidates.sort(key=lambda x:(x['ransBytes'],x['profile']));assert sel['profiles']==candidates;assert sel['selectedProfile']==r['selectedProfile']==candidates[0]['profile'];assert sel['pilotResultsSha256']==sha(rp)
receipt={'format':'issue77-round3-root-audit-v1','work':str(W),'pilot':pilot,'scriptSha256':sha(Path(__file__)),'resultsSha256':sha(rp),'freezeSha256':sha(W/'freeze.json'),'independentOriginalAuditSha256':sha(P),'artifactCount':files,'chunkHashChecks':chunks,'allChecksPassed':True,'elapsedSeconds':time.monotonic()-start,'stems':rows}
(W/'root-verification.json').write_text(json.dumps(receipt,indent=2)+'\n');print('PASS',files,'artifacts',chunks,'chunk digests')
