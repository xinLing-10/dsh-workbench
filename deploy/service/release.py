#!/usr/bin/env python3
"""Package only standalone service source. Never include runtime data or credentials."""
import argparse, hashlib, io, json, tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
EXCLUDED={'node_modules','.git','.dsh','control-data','tests','probes','__pycache__','.cache'}
def files(root):
    selected=[]
    for folder in ['apps/manager-web','packages/manager-core','packages/manager-contracts','services/product-api','services/worker-bridge','dsh-workbench','spec-analyst-preset','stage-presets','deploy/service']:
        for p in (root/folder).rglob('*'):
            rel=p.relative_to(root)
            if EXCLUDED.intersection(rel.parts) or any(x.startswith('.env') for x in rel.parts):continue
            if p.is_symlink():raise ValueError('Symlink in source release: '+str(rel))
            if not p.is_file() or p.name=='.DS_Store' or p.suffix in {'.sqlite','.db','.log','.pem','.key','.pyc'} or p.name.endswith('.test.mjs') or p.name=='test.mjs':continue
            selected.append(p)
    return sorted(set(selected))
def build(root,output):
    if output.exists() or output.resolve().is_relative_to(root.resolve()):raise ValueError('Use a new output file outside source tree')
    entries=files(root)
    if not (root/'services/product-api/server.mjs') in entries:raise ValueError('Missing API entrypoint')
    manifest={'format':1,'product':'standalone-manager','files':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in entries}}
    with tarfile.open(output,'w:gz') as archive:
        for p in entries:archive.add(p,arcname='manager-service/'+str(p.relative_to(root)),recursive=False)
        payload=(json.dumps(manifest,indent=2)+'\n').encode();item=tarfile.TarInfo('manager-service/service-release.json');item.size=len(payload);item.mode=0o644;archive.addfile(item,io.BytesIO(payload))
    return {'files':len(entries),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'bytes':output.stat().st_size}
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True,type=Path);args=parser.parse_args();print(json.dumps(build(ROOT,args.output)))
