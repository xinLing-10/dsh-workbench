#!/bin/sh
set -eu
umask 077
mkdir -p "$DSH_HOME"
stamp=$(find /opt/workbench -type f -exec sha256sum {} + | sort | sha256sum | cut -d ' ' -f 1)
if [ ! -f "$DSH_HOME/workbench-image" ] || [ "$(cat "$DSH_HOME/workbench-image")" != "$stamp" ]; then
  dsh plugin --profile web add link:/opt/workbench/dsh-workbench link:/opt/workbench/spec-analyst-preset link:/opt/workbench/stage-presets
  node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.DSH_HOME+'/profiles/web/package.json';
const doc=JSON.parse(readFileSync(file));
doc.dsh ??= {}; doc.dsh.profile ??= {};
const bundles=doc.dsh.profile.bundles ??= [];
for (const name of ['dsh-workbench','@local/dsh-spec-analyst-preset','@local/dsh-stage-presets']) if(!bundles.includes(name)) bundles.push(name);
writeFileSync(file,JSON.stringify(doc,null,2)+'\n');
JS
  printf '%s' "$stamp" > "$DSH_HOME/workbench-image"
fi
# DSH rejects wildcard bind addresses. Use this container's concrete IPv4.
bind_ip=$(node --input-type=module -e "import os from 'node:os'; const ip=Object.values(os.networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal)?.address; if(!ip)process.exit(1); console.log(ip)")
set -- dsh web --no-open --host "$bind_ip" --port 3080
if [ -n "${WORKBENCH_PUBLIC_URL:-}" ]; then
  authority=$(node -e 'const {isIP}=require("node:net"); const u=new URL(process.env.WORKBENCH_PUBLIC_URL); const ipHttp=process.env.WORKBENCH_ALLOW_IP_HTTP==="1"&&u.protocol==="http:"&&isIP(u.hostname)===4&&Number(u.port)>=1024&&Number(u.port)<=65535; if((u.protocol!=="https:"&&!ipHttp)||u.pathname!=="/"||u.username||u.password||u.search||u.hash)process.exit(1); console.log(u.host)')
  set -- "$@" --public-url "$WORKBENCH_PUBLIC_URL" --trusted-host "$authority"
fi
exec "$@"
