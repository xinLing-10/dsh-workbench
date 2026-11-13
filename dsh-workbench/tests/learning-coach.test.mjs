import test from 'node:test';
import assert from 'node:assert/strict';
import {coachTurn,finishCoaching,parseAssessment,correctObservation,learnerContext} from '../learning-coach.js';
const fixture=()=>({messages:[],plan:{id:'p',lessons:[{id:'l',title:'接口',objective:'理解页面如何请求服务'}]}});
const result=(quote)=>JSON.stringify({assessment:{understood:[],misconceptions:[{claim:'把接口等同于存储',quote}],certainty:'tentative',next:'用预约单重新解释'}});
test('teaching starts with diagnosis, allows skipping and preserves phase during hints',()=>{
 const l=fixture();coachTurn(l,{action:'learning-lesson'},l.plan.lessons[0]);
 const body={coachId:l.coach.id,step:'diagnostic'};
 const hint=coachTurn(l,{...body,action:'learning-coach-help',variant:'hint'});assert.equal(l.coach.hintLevel,0);
 finishCoaching(l,{coachTurn:hint},'');assert.equal(l.coach.hintLevel,1);assert.equal(l.coach.step,'diagnostic');
 const skip=coachTurn(l,{...body,action:'learning-coach-skip'});finishCoaching(l,{coachTurn:skip},'');assert.equal(l.coach.step,'explain');assert.equal(l.observations,undefined);
});
test('assessment quotes must occur in the current answer',()=>{
 assert.throws(()=>parseAssessment(result('用户没说过的话'),'接口是数据库'),/不存在/);
 assert.equal(parseAssessment(result('数据库'),'接口是数据库').misconceptions[0].quote,'数据库');
});
test('misunderstanding loops back to explanation without marking mastery',()=>{
 const l=fixture();coachTurn(l,{action:'learning-lesson'},l.plan.lessons[0]);l.coach.step='practice';
 const turn=coachTurn(l,{action:'learning-coach-answer',coachId:l.coach.id,step:'practice',text:'接口是数据库'});
 finishCoaching(l,{coachTurn:turn,userMessageId:'user-1',evidence:{sources:[]}},result('数据库'));
 assert.equal(l.coach.step,'explain');assert.equal(l.observations[0].messageId,'user-1');assert.equal(l.plan.lessons[0].status,undefined);
 correctObservation(l,{observationId:l.observations[0].id,text:'我只是举例，并没有把它们当成一回事。'});
 assert.equal(learnerContext(l).observations[0].misconceptions.length,0);assert.match(learnerContext(l).observations[0].correction,/举例/);
});
test('paused and stale teaching steps cannot advance',()=>{
 const l=fixture();coachTurn(l,{action:'learning-lesson'},l.plan.lessons[0]);
 assert.throws(()=>coachTurn(l,{action:'learning-coach-next',coachId:l.coach.id,step:'explain'}),/变化/);
 l.coach.paused=true;assert.throws(()=>coachTurn(l,{action:'learning-coach-answer',coachId:l.coach.id,step:'diagnostic',text:'不知道'}),/暂停/);
});
