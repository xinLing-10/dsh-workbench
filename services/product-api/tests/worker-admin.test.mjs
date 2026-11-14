import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../src/db.mjs';
const run=promisify(execFile);
test('offline administration protects credentials and leaves existing secret files intact',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'worker-admin-test-'));
  const path=join(dir,'control.sqlite');const secretFile=join(dir,'worker.secret');
  const db=openDatabase(path);
  db.exec("INSERT INTO tenants VALUES ('ten_admin','test','2026-01-01'); INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES('prj_admin','ten_admin','test','ws','2026-01-01','2026-01-01')");db.close();
  const cli=(...args)=>run(process.execPath,[fileURLToPath(new URL('../worker-admin.mjs',import.meta.url)),...args],{env:{...process.env,PRODUCT_API_DB:path}});
  try{
    const created=await cli('register','wrk_admin','ten_admin',secretFile);
    const secret=(await readFile(secretFile,'utf8')).trim();
    assert.equal(created.stdout.includes(secret),false);
    assert.equal((await stat(secretFile)).mode & 0o777,0o600);
    assert.equal((await stat(path)).mode & 0o777,0o600);
    await assert.rejects(cli('register','wrk_other','ten_admin',secretFile));
    assert.equal((await readFile(secretFile,'utf8')).trim(),secret);
    const lease=JSON.parse((await cli('lease','wrk_admin','prj_admin')).stdout);
    assert.equal(lease.generation,1);
    await cli('revoke',lease.id);
    assert.equal(JSON.parse((await cli('lease','wrk_admin','prj_admin')).stdout).generation,2);
    await cli('disable','wrk_admin');
    await assert.rejects(cli('lease','wrk_admin','prj_admin'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
