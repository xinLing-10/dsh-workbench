import test from 'node:test';
import assert from 'node:assert/strict';
import {parseKnowledgeMap,mapTarget,verifyMapTarget} from '../learning-map.js';
import {retrieveLearningMemory} from '../learning-memory.js';
const evidence={sources:[{id:'S1',path:'README.md',hash:'old',lines:3}],gaps:[]};
const raw=()=>({knowledgeMap:{concepts:[{key:'request',title:'请求',description:'告诉服务希望做什么',kind:'general',requires:[],refs:[]},{key:'page',title:'页面',description:'接收预约时间',kind:'project',requires:['request'],refs:[{sourceId:'S1',start:1,end:2}]}],features:[{title:'预约',description:'选择时间提交预约',concepts:['page'],steps:['选择时间','提交请求'],refs:[{sourceId:'S1',start:1,end:2}]}]}});
test('knowledge map ties concepts and prerequisites to bounded source references',()=>{
 const m=parseKnowledgeMap(JSON.stringify(raw()),evidence,['README.md']);assert.equal(m.concepts[1].requires[0],m.concepts[0].id);assert.equal(m.features[0].refs[0].hash,'old');
});
test('knowledge map rejects cycles, unknown keys and out of range evidence',()=>{
 for(const change of [r=>r.knowledgeMap.concepts[0].requires=['page'],r=>r.knowledgeMap.concepts[1].requires=['unknown'],r=>r.knowledgeMap.features[0].refs[0].end=40]){const r=raw();change(r);assert.throws(()=>parseKnowledgeMap(JSON.stringify(r),evidence,['README.md']));}
});
test('recommended entry needs explicit matching source scope and fresh content',()=>{
 const knowledgeMap=parseKnowledgeMap(JSON.stringify(raw()),evidence,['README.md']),learning={knowledgeMap};
 const body={action:'learning-feature',mapId:knowledgeMap.id,nodeId:knowledgeMap.features[0].id,paths:['README.md']};
 assert.throws(()=>mapTarget(learning,body),/确认/);
 const target=mapTarget(learning,{...body,confirmedSources:true});verifyMapTarget(target,evidence);
 assert.throws(()=>verifyMapTarget(target,{sources:[{...evidence.sources[0],hash:'new'}]}),/变化/);
 assert.throws(()=>mapTarget(learning,{...body,confirmedSources:true,paths:['other.js']}),/范围/);
});
test('retrieval uses relevant older exchanges and strips their obsolete source IDs',()=>{
 const history=[{id:'u',role:'user',text:'接口是什么'},{id:'a',role:'assistant',text:'接口负责沟通 [S1:L1]。',evidence,time:'2026-11-01'},...Array.from({length:14},(_,i)=>({id:'x'+i,role:'user',text:'其他话题'}))];
 const m=retrieveLearningMemory({helpfulMessages:['a']},'接口如何接收请求',history);
 assert.equal(m.exchanges.length,1);assert.ok(!m.exchanges[0].answer.includes('[S1:'));assert.equal(m.exchanges[0].helpful,true);
 assert.equal(retrieveLearningMemory({memoryEnabled:false},'接口',history).exchanges.length,0);
});
test('corrected observations override and exclude their obsolete feedback exchange',()=>{
 const history=[{id:'u',role:'user',text:'服务是数据库'},{id:'a',role:'assistant',text:'你把服务当成了数据库',evidence},...Array.from({length:14},()=>({role:'user',text:'其他'}))];
 const m=retrieveLearningMemory({observations:[{id:'o',messageId:'u',title:'服务',conceptId:'service',understood:[],misconceptions:[{claim:'混淆',quote:'数据库'}],next:'旧建议',corrected:true,correction:'我只是举例'}]},'服务与数据库',history);
 assert.equal(m.observations.length,1);assert.deepEqual(m.observations[0].misconceptions,[]);assert.equal(m.exchanges.length,0);
});
test('memory retrieval is bounded even with many matching observations',()=>{
 const observations=Array.from({length:50},(_,i)=>({id:String(i),title:'接口',understood:[],misconceptions:[],next:'复习',corrected:false}));
 assert.equal(retrieveLearningMemory({observations},'接口是什么').observations.length,5);
});
