#!/usr/bin/env python3
"""Provision an independent Compose project per invited user. No volume deletion."""
import argparse, ipaddress, json, os, re, subprocess
from pathlib import Path
from urllib.parse import urlsplit

def configuration(name, port, image, url='', allow_ip_http=False):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}',name): raise ValueError('Invalid instance name')
    if not 1024 <= port <= 65535: raise ValueError('Invalid port')
    if url:
        u=urlsplit(url)
        ip_http = False
        if allow_ip_http and u.scheme=='http' and u.hostname and u.port and 1024 <= u.port <= 65535:
            try: ip_http = isinstance(ipaddress.ip_address(u.hostname), ipaddress.IPv4Address)
            except ValueError: pass
        if (u.scheme!='https' and not ip_http) or not u.hostname or u.path not in ('','/') or u.query or u.fragment or u.username or u.password: raise ValueError('Use an HTTPS origin, or explicitly allow an HTTP IPv4 origin with a nonprivileged port')
    service={'image':image,'init':False,'restart':'unless-stopped','user':'1000:1000','read_only':True,
      'working_dir':'/workspace','ports':[f'127.0.0.1:{port}:3080'],
      'environment':{'WORKBENCH_PUBLIC_URL':url},'volumes':['home:/home/node','workspace:/workspace'],
      'tmpfs':['/tmp:rw,noexec,nosuid,size=512m,mode=1777'],'cap_drop':['ALL'],
      'security_opt':['no-new-privileges:true'],'pids_limit':256,'mem_limit':'1024m','cpus':1,
      'stop_grace_period':'60s','logging':{'driver':'json-file','options':{'max-size':'10m','max-file':'3'}}}
    if allow_ip_http and url.startswith('http:'): service['environment']['WORKBENCH_ALLOW_IP_HTTP']='1'
    return {'name':'dsh-'+name,'services':{'workbench':service},'volumes':{'home':{},'workspace':{}},'networks':{'default':{}}}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['create','up','stop','status','logs'])
    p.add_argument('name');p.add_argument('--port',type=int,default=3081)
    p.add_argument('--image',default='dsh-workbench:1.18.0');p.add_argument('--url',default='')
    p.add_argument('--allow-ip-http',action='store_true',help='Explicit opt-in for source-restricted personal HTTP IPv4 validation; no TLS')
    p.add_argument('--directory',default='/srv/dsh-instances')
    a=p.parse_args();config=configuration(a.name,a.port,a.image,a.url,a.allow_ip_http)
    base=Path(a.directory).resolve();folder=base/a.name;file=folder/'compose.json'
    if a.action=='create':
        base.mkdir(parents=True,exist_ok=True)
        for other in base.glob('*/compose.json'):
            for s in json.loads(other.read_text())['services'].values():
                if f'127.0.0.1:{a.port}:3080' in s.get('ports',[]): raise ValueError('Port already assigned')
        folder.mkdir(mode=0o700)
        file.write_text(json.dumps(config,indent=2)+'\n');file.chmod(0o600)
        print(f'Created {a.name}: {file}. Configure model in DSH UI after launch.');return
    if not file.is_file() or folder.is_symlink(): raise ValueError('Instance not found')
    args={'up':['up','-d'],'stop':['stop'],'status':['ps'],'logs':['logs','--tail','60']}[a.action]
    subprocess.run(['docker','compose','-f',str(file),*args],check=True)
if __name__=='__main__':main()
