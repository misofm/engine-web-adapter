"""Independently project frozen RSD records into round-3 original audit bytes."""
import hashlib,json,struct
from pathlib import Path
root=Path('/data/issue-77-lossless/iterations/round-01/full-run3/full')
repo=Path('/home/bl/misofm/engine-web-adapter/research/077-lossless-delivery')
expected=json.loads((repo/'iterations/round-01-evidence/root-verification.json').read_text())
receipts=[]
for row in expected['stems']:
 sid=row['identity'].split(':')[1];p=root/sid/'stem.rsd'
 with p.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==row['recordSha256']
 digest=hashlib.sha256(b'I77FIRA3');size=8
 with p.open('rb') as f:
  magic,manifest_len,records=struct.unpack('<8sQQ',f.read(24));assert magic==b'I77RSD01'
  f.seek(manifest_len,1)
  for _ in range(records):
   n=struct.unpack('<I',f.read(4))[0];assert 32<=n<=1048576
   b=f.read(n);assert len(b)==n
   block=struct.unpack_from('<I',b,24)[0];assignment=b[28]
   projection=bytearray(struct.pack('<HBB',block,assignment,0));pos=32
   for channel in range(2):
    typ,wasted,order,precision,shift,method,partition_order,reserved,count,partitions=struct.unpack_from('<8BII',b,pos);pos+=16
    assert reserved==0
    projection+=struct.pack('<7BI',typ,wasted,order,precision,shift,partition_order,0,count)
    warm_coeff=4*order*(2 if typ==3 else 1)
    projection+=b[pos:pos+warm_coeff];pos+=warm_coeff
    pos+=4*partitions
    projection+=b[pos:pos+4*count];pos+=4*count
   assert pos==n
   digest.update(projection);size+=len(projection)
  assert not f.read(1)
 receipts.append({'identity':row['identity'],'rsdSha256':row['recordSha256'],'recordCount':records,'originalAuditBytes':size,'originalAuditSha256':digest.hexdigest()})
out={'format':'issue77-round3-independent-original-audit-v1','source':'independent Python projection of frozen round-1 RSD bytes; no round-3 transform/encoder used','scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'stems':receipts}
p=Path('/data/issue-77-lossless/iterations/round-03/root-original-audit.json');p.write_text(json.dumps(out,indent=2)+'\n');print('PASS',len(receipts),'stems',sum(r['originalAuditBytes'] for r in receipts),'audit bytes projected')
