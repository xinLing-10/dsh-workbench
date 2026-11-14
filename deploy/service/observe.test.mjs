import test from 'node:test';import assert from 'node:assert/strict';import {evaluate} from './observe.mjs';
const start=Date.parse('2026-11-14T00:00:00Z');const rows=Array.from({length:1441},(_,i)=>({at:new Date(start+i*60000).toISOString(),healthy:true}));
test('24 hour gate requires actual elapsed time and samples, never a short smoke run',()=>{assert.equal(evaluate(rows.slice(0,10)).status,'observing');assert.equal(evaluate([rows[0],rows.at(-1)]).status,'failed');assert.equal(evaluate(rows).status,'passed');});
test('failed samples, observation gaps and malformed records prevent trial acceptance',()=>{assert.equal(evaluate(rows.map((r,i)=>i===5?{...r,healthy:false}:r)).status,'failed');assert.equal(evaluate(rows.filter((_,i)=>i<40||i>50)).status,'failed');assert.throws(()=>evaluate([{at:'bad',healthy:true}]));});

test('an automatic process restart between healthy samples fails observation',()=>{assert.equal(evaluate(rows.map((r,i)=>({...r,units:[{unit:'manager-acceptance-api.service',restarts:i<50?0:1,started:i<50?'100':'200'}]}))).status,'failed');});

test('a no-model observation window fails if its request ledger grows',()=>{assert.equal(evaluate(rows.map((r,i)=>({...r,model:{requests:i<50?6:7}})),{expectNoModelCalls:true}).status,'failed');});
