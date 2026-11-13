import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleObservation,deferReview,pauseReview,invalidateReview,reviewPresentation} from '../learning-review.js';
import {evaluateTeachingCase,teachingReport,evaluationPrompt} from '../teaching-eval.js';
const time=Date.parse('2026-11-01T00:00:00Z');
const observation={id:'o1',conceptId:'c',title:'请求',certainty:'tentative',understood:[],misconceptions:[{claim:'待澄清',quote:'数据库'}]};
test('review rules are deterministic and do not equate observations to mastery',()=>{
 const l={};const r=scheduleObservation(l,observation,{},time);assert.equal(r.intervalDays,1);assert.equal(reviewPresentation(l,time).dueCount,0);assert.equal(reviewPresentation(l,time+86400000).dueCount,1);
 scheduleObservation(l,{...observation,id:'o2',certainty:'supported',understood:[{claim:'说明请求'}],misconceptions:[]},{coachTurn:{isReview:true}},time);assert.equal(r.intervalDays,3);assert.equal(r.attempts,2);
});
test('pause, defer, disable and corrections keep user control over reminders',()=>{
 const l={};const r=scheduleObservation(l,observation,{},time);pauseReview(l,{reviewId:r.id});
 scheduleObservation(l,observation,{},time);assert.equal(r.status,'paused');
 deferReview(l,{reviewId:r.id,days:3},time);assert.equal(r.status,'scheduled');
 invalidateReview(l,'o1');assert.equal(r.status,'needs-confirmation');
 deferReview(l,{reviewId:r.id,days:1},time);l.reviewReminders=false;assert.equal(reviewPresentation(l,time+86400000).dueCount,0);assert.equal(l.reviews.length,1);
 assert.throws(()=>deferReview(l,{reviewId:r.id,days:0},time));
});
test('evaluation flags malformed citations and unsupported student quotes without claiming learning success',()=>{
 const c={id:'test',requiresCitation:true,requiresAssessment:true,studentAnswer:'我不知道',sources:[{id:'S1',text:'one line'}]};
 const raw=JSON.stringify({reply:'解释 [S1:L2]',assessment:{understood:[{claim:'懂了',quote:'我都懂了'}],misconceptions:[],certainty:'supported',next:'继续'}});
 const result=evaluateTeachingCase(c,raw);assert.equal(result.status,'needs-attention');assert.equal(result.issues.length,2);assert.ok(result.humanReview.every(r=>r.rating===null));
 assert.equal(teachingReport([c],{}).results[0].status,'missing-response');assert.equal(teachingReport([c],{test:raw}).learningOutcomeValidated,false);
});
test('evaluation prepares real protocol prompts while leaving pedagogy review to people',()=>{
 const c={id:'intro',prompt:'解释页面',sources:[],maxQuestions:1};assert.match(evaluationPrompt(c),/未提供项目资料/);
 const report=teachingReport([c],{intro:'页面是用户看到并操作的界面。'});assert.equal(report.modelCalls,0);assert.equal(report.results[0].status,'ready-for-human-review');assert.equal(report.learningOutcomeValidated,false);
 const risk=evaluateTeachingCase(c,'你已经完全掌握。测试已通过。');assert.equal(risk.status,'needs-attention');
});
