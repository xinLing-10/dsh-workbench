/** Import selected, validated text snapshots atomically into a fresh project subdirectory. */
import {mkdirSync,writeFileSync,readFileSync,realpathSync,lstatSync,existsSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateSource} from './project-sources.mjs';
const fail = message => Object.assign(new Error(message), {status:409,code:'conflict'});
export function importProjectFiles({db,projectId,directory,files,consent}) {
 if(consent!==true)throw fail('请明确授权导入服务器项目副本');
 if(!Array.isArray(files)||!files.length||files.length>50||new Set(files.map(f=>f.path)).size!==files.length)throw fail('请选择1—50份不同资料');
 if(db.prepare("SELECT 1 FROM operations WHERE project_id=? AND state IN ('queued','running','waiting','stopping','uncertain')").get(projectId))throw fail('请先停止并核对当前任务，再导入项目');
 if(lstatSync(directory).isSymbolicLink()||realpathSync(directory)!==directory)throw fail('项目工作区路径异常');
 const selected=files.map(f=>{
  const row=db.prepare('SELECT path,content,sha256 FROM project_sources WHERE project_id=? AND path=?').get(projectId,f.path);
  if(!row||row.sha256!==f.sha256)throw fail('资料版本已变化，请刷新后重试');return validateSource(row);
 });
 if(selected.reduce((n,f)=>n+f.bytes,0)>524288)throw fail('导入资料超过512KB');
 const manifest=selected.map(f=>({path:f.path,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
 const target=join(directory,'imported-project'),proof=join(target,'import-manifest.json');
 if(existsSync(target)) {
  if(lstatSync(target).isSymbolicLink()||!existsSync(proof)||lstatSync(proof).isSymbolicLink()||JSON.stringify(JSON.parse(readFileSync(proof)))!==JSON.stringify(manifest))throw fail('已有导入目录，请新建项目以免覆盖修改');
  for(const f of manifest){const p=join(target,f.path);if(realpathSync(p)!==p||createHash('sha256').update(readFileSync(p)).digest('hex')!==f.sha256)throw fail('导入后的文件已修改，不能覆盖');}
  return {directory:'imported-project',files:manifest,replayed:true};
 }
 const staging=join(directory,'manager-import-'+randomUUID());mkdirSync(staging,{mode:0o700});
 try {
  for(const f of selected){const p=join(staging,f.path),parent=p.slice(0,p.lastIndexOf('/'));mkdirSync(parent,{recursive:true,mode:0o700});writeFileSync(p,f.content,{mode:0o600,flag:'wx'});}
  writeFileSync(join(staging,'import-manifest.json'),JSON.stringify(manifest),{mode:0o600,flag:'wx'});
  renameSync(staging,target);
 }finally{rmSync(staging,{recursive:true,force:true});}
 return {directory:'imported-project',files:manifest,replayed:false};
}
