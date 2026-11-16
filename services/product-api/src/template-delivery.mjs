/** Shared template composition consumes exact approval snapshots, never live unapproved text. */
import {createHash,randomUUID} from 'node:crypto';
import {defaultTemplates,TEMPLATE_STAGES,DELIVERY_TITLES,sourcesFor,composeDeliverable} from '../../../dsh-workbench/core/templates.js';
import {approvedSources} from '../../../dsh-workbench/core/delivery-plan.js';
import {knowledgeView} from '../../../dsh-workbench/core/knowledge.js';
import {boardDirectory} from '../../../dsh-workbench/core/artifacts.js';
import {exportDocument,exportTypes} from './document-export.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),fail=m=>Object.assign(Error(m),{status:409,code:'conflict'});
export function templateCatalog(){return {stages:TEMPLATE_STAGES.map(stage=>({stage,title:DELIVERY_TITLES[stage],templates:defaultTemplates(stage).map(t=>({id:t.id,name:t.name})),sources:sourcesFor(stage)}))};}
export async function templateDelivery({db,project,root,id,state,body,append,publish}){
 if(typeof body.requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId))throw fail('缺少有效请求编号');
 const fingerprint=hash(JSON.stringify({stage:body.stage,templateId:body.templateId,format:body.format}));
 const previous=db.prepare('SELECT * FROM template_exports WHERE task_id=? AND request_id=?').get(id,body.requestId);
 if(previous){if(previous.payload_hash!==fingerprint)throw fail('同一请求不能更换模板或格式');return {artifactId:previous.artifact_id,...JSON.parse(previous.manifest_json),replayed:true};}
 if(!TEMPLATE_STAGES.includes(body.stage)||!['markdown',...Object.keys(exportTypes)].includes(body.format))throw fail('模板类型或交付格式无效');
 const template=defaultTemplates(body.stage).find(t=>t.id===body.templateId);if(!template)throw fail('请选择内置模板');
 const {sources,missing}=await approvedSources(root,id,state,sourcesFor(body.stage));if(missing.length||!sources.length)throw fail('请先阅读并确认来源文档：'+missing.join('、'));
 const index=await knowledgeView(root,id,state),composed=composeDeliverable({stage:body.stage,template,documentTexts:sources,knowledgeNodes:index.nodes,projectName:project.name,date:new Date().toISOString().slice(0,10)});
 const status=composed.gaps.length?'draft':'generated',extension=body.format==='markdown'?'md':body.format,name=(status==='draft'?'草稿-':'')+DELIVERY_TITLES[body.stage]+'.'+extension,markdown=Buffer.from(composed.markdown);
 const bytes=body.format==='markdown'?markdown:await exportDocument(markdown,DELIVERY_TITLES[body.stage]+'.md',body.format);
 const operation=db.prepare("SELECT s.operation_id FROM core_sessions s JOIN operations o ON o.id=s.operation_id WHERE s.task_id=? AND s.kind='work' AND o.state='completed' ORDER BY o.created_at DESC LIMIT 1").get(id);if(!operation)throw fail('缺少该任务的正式执行记录');
 const artifactId='art_'+randomUUID().replaceAll('-',''),relative=boardDirectory(id)+'/delivery/'+randomUUID()+'/'+name,at=new Date().toISOString(),manifest={status,name,format:body.format,gaps:composed.gaps,sources:sources.map(({text,...s})=>s),sha256:hash(bytes),createdAt:at};let event;
 db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO artifact_index VALUES(?,?,?,?,?,1,0,?)').run(artifactId,project.tenant_id,project.id,relative,manifest.sha256,at);db.prepare('INSERT INTO artifact_contents VALUES(?,?,NULL,?,NULL)').run(artifactId,bytes,operation.operation_id);db.prepare('INSERT INTO template_exports VALUES(?,?,?,?,?)').run(id,body.requestId,fingerprint,artifactId,JSON.stringify(manifest));event=append(db,{tenantId:project.tenant_id,projectId:project.id,operationId:operation.operation_id,type:'artifact_version',payload:{artifactId,template:true,status}});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}publish(event);return {artifactId,...manifest};
}
