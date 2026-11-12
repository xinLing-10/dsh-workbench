#!/usr/bin/env python3
"""Build a source-only deployment archive; never package home, credentials or project data."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT=Path(__file__).resolve().parent.parent
EXCLUDED={'node_modules','.git','.dsh','__pycache__','instances','backups'}
def release_files(root):
    files=[]
    for name in ['README.md','AGENTS.md','.dockerignore','.gitignore']:
        files.append(root/name)
    for directory in ['dsh-workbench','spec-analyst-preset','stage-presets','deploy']:
        for path in (root/directory).rglob('*'):
            rel=path.relative_to(root)
            if EXCLUDED.intersection(rel.parts) or any(p.startswith('.env') for p in rel.parts):continue
            if path.suffix in {'.log','.pem','.key','.pyc'} or path.name=='.DS_Store':continue
            if path.is_symlink():raise ValueError('Unexpected symlink in release: '+str(rel))
            if path.is_file():files.append(path)
    return sorted(files)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    output=args.output.resolve()
    if output.is_relative_to(ROOT):raise ValueError('Write the archive outside the source directory')
    paths=release_files(ROOT)
    try:commit=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:commit='working-copy'
    manifest={'version':json.loads((ROOT/'dsh-workbench/package.json').read_text())['version'],'sourceCommit':commit,
              'files':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
    if output.exists():raise FileExistsError(output)
    with tarfile.open(output,'w:gz') as archive:
        for path in paths:archive.add(path,arcname='dsh-workbench/'+str(path.relative_to(ROOT)),recursive=False)
        payload=(json.dumps(manifest,indent=2)+'\n').encode()
        entry=tarfile.TarInfo('dsh-workbench/release-manifest.json');entry.size=len(payload);entry.mode=0o644
        archive.addfile(entry,io.BytesIO(payload))
    print(f'Created {output} ({len(paths)} source files). Verify with tar -tzf before uploading.')
if __name__=='__main__':main()
