import test from 'node:test';
import assert from 'node:assert/strict';
import {learningProfile,parseLearningPlan,markLearningProgress,sourceChanges} from '../learning-plan.js';
const profile={goal:'看懂预约产品',level:'zero',minutes:20};
const evidence={sources:[{id:'S1',path:'README.md',hash:'one'}]};
const raw=()=>({plan:{title:'从零认识预约',map:['产品用途','一次预约的流程'],lessons:Array.from({length:3},(_,i)=>({title:'主题'+i,objective:'能说清一个问题',question:'请用自己的话解释',minutes:10,sourceIds:['S1']}))}});
test('learning profile and plan reject invalid time, fabricated source and malformed lessons',()=>{
 assert.deepEqual(learningProfile(profile),profile);assert.throws(()=>learningProfile({...profile,minutes:0}));
 const valid=parseLearningPlan(JSON.stringify(raw()),profile,evidence);assert.equal(valid.lessons.length,3);
 for(const modify of [p=>p.plan.lessons[0].sourceIds=['S2'],p=>p.plan.lessons[0].minutes=60,p=>p.plan.lessons=[]]){const data=raw();modify(data);assert.throws(()=>parseLearningPlan(JSON.stringify(data),profile,evidence));}
});
test('self assessment needs reading and reflection, and old plan IDs cannot change progress',()=>{
 const plan=parseLearningPlan(JSON.stringify(raw()),profile,evidence),learning={plan};
 const body={planId:plan.id,lessonId:plan.lessons[0].id,status:'self-checked'};
 assert.throws(()=>markLearningProgress(learning,body));
 markLearningProgress(learning,{...body,status:'read'});assert.throws(()=>markLearningProgress(learning,body));
 plan.lessons[0].reflectedAt='now';markLearningProgress(learning,body);assert.equal(plan.lessons[0].status,'self-checked');
 assert.throws(()=>markLearningProgress(learning,{...body,planId:'old'}));
});
test('source changes distinguish plan version from current evidence',()=>{
 const plan={evidence};assert.deepEqual(sourceChanges(plan,evidence),[]);
 assert.deepEqual(sourceChanges(plan,{sources:[{...evidence.sources[0],hash:'two'}]}),['README.md']);
 assert.deepEqual(sourceChanges(plan,{sources:[]}),['README.md']);
});
