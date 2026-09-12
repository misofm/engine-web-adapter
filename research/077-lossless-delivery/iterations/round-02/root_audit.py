import hashlib,json,struct,time
from pathlib import Path
B=Path('/home/bl/misofm/engine-web-adapter/research/077-lossless-delivery')
E=B/'iterations/round-02-evidence'
W=Path('/data/issue-77-lossless/iterations/round-02/final-full2')
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def check(p,n,h):
 assert p.stat().st_size==n,(p,'size')
 assert sha(p)==h,(p,'sha')
def take(f,n,digest):
 while n:
  x=f.read(min(n,1048576));assert x
  digest.update(x);n-=len(x)
def zeros(d,n):
 z=bytes(1048576)
 while n:d.update(z[:min(n,len(z))]);n-=min(n,len(z))
def norm(c):
 s=sum(c);a=[i for i,n in enumerate(c) if n];left=4096-len(a)
 f=[0]*17
 for i in a:f[i]=1+left*c[i]//s
 for i in sorted(a,key=lambda i:(-(left*c[i]%s),i))[:4096-sum(f)]:f[i]+=1
 return f
start=time.monotonic();r=json.loads((E/'results.json').read_text());freeze=json.loads((E/'freeze.json').read_text())
assert sha(W/'results.json')==sha(E/'results.json');assert sha(W/'freeze.json')==r['freezeSha256']==sha(E/'freeze.json')
for key,p in [('runnerSha256',B/'iterations/round-02/round2.py'),('nativeSha256',B/'iterations/round-02/native/round2.c'),('round1NativeDependencySha256',B/'iterations/round-01/native/round1.c'),('scopeSha256',B/'iterations/round-02-scope.md')]:assert sha(p)==freeze[key],key
for key in ['helper','library']:assert sha(Path(freeze[key]['path']))==freeze[key]['sha256']
r1=json.loads(Path('/data/issue-77-lossless/iterations/round-01/full-run3/results.json').read_text());hist={s['identity']:s['stats']['conthist'] for s in r1['stems']}
rows=[];tables=0;chunks=0
for row in r['stems']:
 ident=row['identity'];sid=ident.split(':')[1];d=W/'full'/sid;mbytes=(B/'manifests'/f'{sid}.json').read_bytes();m=json.loads(mbytes)
 rsd=Path(freeze['recordsRoot'])/sid/'stem.rsd';check(rsd,row['rsdBytes'],row['rsdSha256'])
 mode_receipts={}
 for mode,mn in row['modes'].items():
  p=d/f'{mode}.ent';check(p,mn['outputBytes'],mn['outputSha256']);summ=mn['encodeSummary'];assert summ==mn['decodeSummary']
  assert mn['outputBytes']==32+len(mbytes)+summ['tableBytes']+summ['frameBytes']
  assert summ['frameBytes']==8*summ['frameCount']+summ['sideBytes']+8*summ['predictiveSubframes']+summ['entropyBytes']+summ['bypassBytes']
  with p.open('rb') as f:
   magic,imode,profile,flags,mlen,recs,nt=struct.unpack('<8sBBHQQI',f.read(32));assert (magic,imode,profile,flags,mlen,recs,nt)==(b'I77ENT02',int(mode=='rans'),1,0,len(mbytes),mn['recordCount'],summ['tableCount']);assert f.read(mlen)==mbytes
   previous=None
   for _ in range(nt):
    role,k,prev,*freq=struct.unpack('<BBB17H',f.read(37));key=(role,k,prev);assert previous is None or previous<key;previous=key
    base=((role*32+k)*5+prev)*17;assert freq==norm(hist[ident][base:base+17]);tables+=1
   frames=0
   while raw:=f.read(4):
    assert len(raw)==4;n=struct.unpack('<I',raw)[0];assert 4<=n<=4194304;assert len(f.read(n))==n;frames+=1
   assert frames==recs
  for suffix in ['encode.audit','decode.audit']:check(d/f'{mode}.{suffix}',mn['auditBytes'],mn['auditSha256'])
  pcm=d/f'{mode}.raw';check(pcm,row['activePcmBytes'],row['packedPcmSha256'])
  with pcm.open('rb') as f:
   for ch in m['chunks']:
    h=hashlib.sha256();take(f,ch['frames']*6,h);assert h.hexdigest()==ch['pcmSha256'];chunks+=1
   assert not f.read(1)
  h=hashlib.sha256();end=0;packed=0
  with pcm.open('rb') as f:
   for interval in m['intervals']:
    assert interval['startFrame']>=end and interval['packedFrameOffset']==packed
    zeros(h,(interval['startFrame']-end)*6);take(f,interval['frames']*6,h);end=interval['startFrame']+interval['frames'];packed+=interval['frames']
   zeros(h,(m['frames']-end)*6);assert not f.read(1)
  assert h.hexdigest()==sid
  mode_receipts[mode]={'fileBytes':p.stat().st_size,'fileSha256':mn['outputSha256'],'packedPcmSha256':row['packedPcmSha256'],'canonicalPcmSha256':sid,'auditSha256':mn['auditSha256'],'tableCount':summ['tableCount'],'accountingPassed':True}
 assert row['modes']['rice']['auditSha256']==row['modes']['rans']['auditSha256']
 rows.append({'identity':ident,'modes':mode_receipts})
 print(len(rows),sid[:8],flush=True)
tf=json.loads((E/'timing-freeze.json').read_text());baseline=[]
assert sha(B/'iterations/round-02/timing.py')==tf['timingSha256']
for key in ['helper','flac']:assert sha(Path(tf[key]['path']))==tf[key]['sha256']
for sid in tf['pilots']:
 directory=Path(tf['corpus'])/sid/'flac8e-30s';candidate=json.loads((directory/'manifest.json').read_text());receipts=[]
 for i,ch in enumerate(candidate['chunks']):
  p=directory/f'{i}.flac';check(p,ch['bytes'],ch['flacSha256']);receipts.append({'bytes':ch['bytes'],'sha256':ch['flacSha256']})
 baseline.append({'identity':'sha256:'+sid,'candidateManifestSha256':sha(directory/'manifest.json'),'chunks':receipts})
 for mode in ['rice','rans']:assert sha(Path(tf['pilotWork'])/'pilot'/sid/f'{mode}.ent')==tf['compressedArtifacts'][sid][mode]
receipt={'format':'issue77-round2-root-audit-v1','auditScriptSha256':sha(Path(__file__)),'work':str(W),'resultsSha256':sha(E/'results.json'),'freezeSha256':sha(E/'freeze.json'),'stemCount':len(rows),'artifactCount':len(rows)*2,'chunkHashChecks':chunks,'normalizedContextTablesChecked':tables,'allChecksPassed':True,'elapsedSeconds':time.monotonic()-start,'stems':rows,'timingBaselineChunkVerification':baseline}
out=E/'root-verification.json';out.write_text(json.dumps(receipt,indent=2)+'\n');print(out,receipt['elapsedSeconds'])
