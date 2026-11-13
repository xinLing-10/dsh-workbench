import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { managedPath, boardDirectory } from './artifacts.js';
import { learningContext, containsSensitive } from './learning.js';
import { executionPolicy } from './execution-policy.js';
const hash=data=>createHash('sha256').update(data).digest('hex');
export async function createPractice(root,id,body) {
  if(body.confirmed!==true)throw new Error('请先确认只在学习副本中练习，不执行代码或修改原项目。');
  const context=await learningContext(root,id,body.paths);
  if(!context.sources.length)throw new Error('请先选择至少一份可用项目资料。');
  const practice={id:randomUUID(),createdAt:new Date().toISOString(),goal:typeof body.goal==='string'?body.goal.trim().slice(0,800):'尝试解释一个函数，或修改一条提示文字，并说明原因。',files:[],gaps:context.gaps};
  // Validate every source before creating any output, then write only within the new unique practice directory.
  const copies=[];
  for(const source of context.sources) {
    const bytes=await readFile(await managedPath(root,source.path));
    if(hash(bytes)!==source.hash)throw new Error('项目资料刚刚变化，请重新创建副本。');
    copies.push({source,bytes});
  }
  for(const {source,bytes} of copies) {
    const path=`${boardDirectory(id)}/learning/practices/${practice.id}/files/${source.path}`;
    const target=await managedPath(root,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
    practice.files.push({originalPath:source.path,path,baselineHash:source.hash});
  }
  return practice;
}
function fileOf(learning,body) {
  const practice=learning?.practice;
  if(!practice || practice.id!==body.practiceId)throw new Error('练习副本已变化，请重新选择文件。');
  const file=practice.files.find(f=>f.originalPath===body.path);
  if(!file)throw new Error('只能编辑本次学习副本清单中的文件。');
  return file;
}
export async function openPractice(root,learning,body) {
  await executionPolicy(root);
  const file=fileOf(learning,body);
  const bytes=await readFile(await managedPath(root,file.path));
  if(bytes.length>128*1024 || containsSensitive(bytes.toString('utf8')))throw new Error('副本文件过大或疑似含凭据，无法读取。');
  return {path:file.originalPath,content:bytes.toString('utf8'),hash:hash(bytes),baselineHash:file.baselineHash};
}
export async function savePractice(root,learning,body) {
  const current=await openPractice(root,learning,body);
  if(current.hash!==body.baseHash)throw new Error('练习文件已变化，请重新打开后再保存。');
  if(typeof body.content!=='string' || body.content.length>16000 || containsSensitive(body.content))throw new Error('练习内容须不超过 16,000 字符，不能含凭据。');
  const file=fileOf(learning,body),target=await managedPath(root,file.path),temporary=target+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,body.content,{flag:'wx'});await rename(temporary,target);
  return {...current,content:body.content,hash:hash(Buffer.from(body.content))};
}
export async function practiceContext(root,learning,body) {
  const file=await openPractice(root,learning,body);
  const lines=file.content.split(/\r?\n/);let used=0;
  const excerpt=[];
  for(const [i,line] of lines.entries()){const text=`${i+1}: ${line}`;if(used+text.length>16000)break;excerpt.push(text);used+=text.length+1;}
  return {capturedAt:new Date().toISOString(),sources:[{id:'S1',path:`学习副本/${file.path}`,hash:file.hash,lines:excerpt.length,truncated:excerpt.length<lines.length,text:excerpt.join('\n')}],gaps:['这是所选文件的学习副本，不是完整可运行环境。没有执行代码，不能据此认定测试通过。']};
}
