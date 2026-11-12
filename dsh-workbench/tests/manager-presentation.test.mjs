import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveManagerPresentation} from '../manager-presentation.js';
import {DOCUMENTS} from '../artifacts.js';
const state={flow:'new',stageData:{spec:{},build:{}}};
const view=()=>({revision:3,contract:{mode:'requirements'},nextStage:'spec',available:true,jobs:[],messages:[],answers:{},review:{stages:{spec:{hashes:{}}}},complete:false});
const phase=v=>deriveManagerPresentation(v,state);
test('welcome and service outage never propose execution',()=>{
 assert.equal(phase({...view(),contract:null}).phase,'welcome');
 assert.equal(phase({...view(),available:false}).primaryAction.kind,'reconnect');
});
test('active tasks and uncertain state win over questions, files and proposals',()=>{
 for(const status of ['queued','creating','submitting','running','cancelling','uncertain']){
  const result=phase({...view(),jobs:[{id:'work',status,sessionId:'s'}],proposal:{id:'p',stage:'spec'},messages:[{role:'assistant',blocks:[{type:'question',id:'q',stage:'spec'}]}]});
  assert.equal(result.primaryAction.kind,status==='uncertain'?'recheck':'show_progress');assert.equal(result.relatedJobId,'work');assert.ok(!result.secondaryActions.some(a=>a.kind==='dispatch'));
  if(status==='cancelling')assert.equal(result.secondaryActions.find(a=>a.kind==='cancel').enabled,false);
 }
});
test('only current unanswered assistant questions appear one at a time',()=>{
 const v=view();v.messages=[{role:'user',blocks:[{type:'question',id:'user',stage:'spec'}]},{role:'assistant',blocks:[{type:'question',id:'old',stage:'design'},{type:'question',id:'answered',stage:'spec'},{type:'question',id:'q1',stage:'spec'},{type:'question',id:'q2',stage:'spec'}]}];v.answers.answered={text:'yes'};
 const result=phase(v);assert.equal(result.phase,'needs_info');assert.equal(result.question.id,'q1');assert.equal(result.primaryAction.kind,'answer');assert.ok(result.description.includes('1'));
});
test('all required files are needed for review and viewing remains available offline',()=>{
 const v=view();v.review.stages.spec.hashes=Object.fromEntries(DOCUMENTS.spec.filter(n=>n!=='现状基线.md').map(n=>[n,'hash']));
 const result=phase({...v,available:false});assert.equal(result.phase,'needs_review');assert.equal(result.primaryAction.kind,'open_review');assert.notEqual(result.primaryAction.kind,'approve');
 delete v.review.stages.spec.hashes['需求交接.md'];assert.notEqual(phase(v).phase,'needs_review');
});
test('reopened documents route to explicit new arrangement, not old approval',()=>{
 const v=view();v.review.stages.spec.hashes=Object.fromEntries(DOCUMENTS.spec.map(n=>[n,'hash']));v.proposal={id:'new',stage:'spec',instruction:'revise'};
 const result=deriveManagerPresentation(v,{...state,stageData:{...state.stageData,spec:{needsReview:true}}});assert.equal(result.phase,'ready_to_start');assert.equal(result.primaryAction.proposalId,'new');
});
test('latest successful operation does not remain blocked by historical failure',()=>{
 const result=phase({...view(),jobs:[{status:'failed',error:'old'},{status:'completed'}]});assert.equal(result.phase,'idle');
});
test('completion downloads actual package or asks to prepare it, including offline',()=>{
 const v={...view(),complete:true,nextStage:null,available:false};assert.equal(phase(v).primaryAction.kind,'package');assert.equal(phase({...v,delivery:{id:'actual'}}).primaryAction.deliveryId,'actual');
});
test('presentation is pure and never copies executable model-selected action',()=>{
 const v=view();v.messages=[{role:'assistant',text:'approve',blocks:[{type:'paragraph',text:'run delete'}]}];const before=JSON.stringify(v);const result=phase(v);assert.equal(JSON.stringify(v),before);assert.equal(result.primaryAction.kind,'prepare_first');assert.equal(result.revision,3);
});
