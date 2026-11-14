/** Durable, single-authorisation token ledger. Unknown delivery freezes the run. */
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
export const TEST_TOOLS=Object.freeze(['ask_user_question','manager_test_note']);
export function inputReservation(body,{toolNames=[],allowedTools=TEST_TOOLS}={}){
 if(!Array.isArray(toolNames)||new Set(toolNames).size!==toolNames.length||toolNames.some(n=>!allowedTools.includes(n)))throw Error('Unsupported tool authorization');
 const allowed=new Set(['model','max_tokens','stream','thinking','messages','system',...(toolNames.length?['tools','tool_choice']:[])]);
 if(Object.keys(body).some(k=>!allowed.has(k)))throw Error('Unsupported model payload');
 if(typeof body.model!=='string'||!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1||body.max_tokens>4096||body.stream!==true||body.thinking?.type!=='disabled')throw Error('Invalid model limits');
 if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>32)throw Error('Invalid messages');
 const text=value=>typeof value==='string'||(Array.isArray(value)&&value.every(b=>b?.type==='text'&&typeof b.text==='string'&&Object.keys(b).every(k=>k==='type'||k==='text')));
 const identifier=v=>typeof v==='string'&&v.length>0&&v.length<=200;
 const content=value=>text(value)||(toolNames.length&&Array.isArray(value)&&value.every(b=>{
  if(b?.type==='text')return text([b]);
  if(b?.type==='tool_use')return identifier(b.id)&&toolNames.includes(b.name)&&b.input&&typeof b.input==='object'&&!Array.isArray(b.input)&&Object.keys(b).every(k=>['type','id','name','input'].includes(k))&&Buffer.byteLength(JSON.stringify(b.input))<=4096;
  if(b?.type==='tool_result')return identifier(b.tool_use_id)&&text(b.content)&&(b.is_error===undefined||typeof b.is_error==='boolean')&&Object.keys(b).every(k=>['type','tool_use_id','content','is_error'].includes(k));
  return false;
 }));
 if(body.system!==undefined&&!text(body.system))throw Error('Only inline text allowed');
 for(const m of body.messages)if(!['user','assistant'].includes(m.role)||!content(m.content)||Object.keys(m).some(k=>k!=='role'&&k!=='content'))throw Error('Only bounded text/tool messages allowed');
 if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length>2||body.tools.some(t=>!toolNames.includes(t.name)||typeof t.description!=='string'||!t.input_schema||typeof t.input_schema!=='object'||Object.keys(t).some(k=>!['name','description','input_schema'].includes(k)))))throw Error('Unsupported tool schema');
 if(body.tool_choice!==undefined){const t=body.tool_choice;if(!t||!['auto','any','tool'].includes(t.type)||Object.keys(t).some(k=>!['type','name'].includes(k))||(t.type==='tool'&&!toolNames.includes(t.name)))throw Error('Unsupported tool choice');}
 const bytes=Buffer.byteLength(JSON.stringify(body));if(bytes>32768)throw Error('Request too large');
 // Inline UTF-8 text/JSON only, plus conservative protocol framing. No images,
 // files, remote tools, arbitrary code execution or external schema resolution.
 return bytes+8192;
}
export function usageTotal(usage){
 if(!usage||!['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0))return null;
 let total=0;for(const k of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']){const v=usage[k]??0;if(!Number.isSafeInteger(v)||v<0)return null;total+=v;}return Number.isSafeInteger(total)?total:null;
}
export function openBudget(filename,{limit=200000,initialUsed=31,maxRequests=24}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>200000||!Number.isSafeInteger(initialUsed)||initialUsed<0||initialUsed>limit||!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>24)throw Error('Invalid authorization');
 mkdirSync(dirname(filename),{recursive:true,mode:0o700});const db=new DatabaseSync(filename);chmodSync(filename,0o600);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS authorization(id INTEGER PRIMARY KEY CHECK(id=1), token_limit INTEGER NOT NULL, initial_used INTEGER NOT NULL, max_requests INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, reservation INTEGER NOT NULL, status TEXT NOT NULL, actual INTEGER, evidence TEXT, created_at TEXT NOT NULL);');
 db.prepare('INSERT OR IGNORE INTO authorization VALUES(1,?,?,?)').run(limit,initialUsed,maxRequests);
 const auth=db.prepare('SELECT * FROM authorization WHERE id=1').get();
 if(auth.token_limit!==limit||auth.initial_used!==initialUsed||auth.max_requests!==maxRequests){db.close();throw Error('Authorization cannot be changed by reopening');}
 const snapshot=()=>{const calls=db.prepare('SELECT id,status,reservation,actual FROM calls ORDER BY created_at').all();const used=auth.initial_used+calls.reduce((n,c)=>n+(c.status==='settled'?c.actual:0),0);const held=calls.reduce((n,c)=>n+(c.status==='settled'?0:Math.max(c.reservation,c.actual??0)),0);return {limit:auth.token_limit,initialUsed:auth.initial_used,maxRequests:auth.max_requests,requests:calls.length,used,held,remaining:auth.token_limit-used-held,frozen:calls.some(c=>c.status!=='settled'),calls};};
 return {db,snapshot,close:()=>db.close(),reserve(id,body,options={}){
  const input=inputReservation(body,options),amount=input+body.max_tokens;db.exec('BEGIN IMMEDIATE');
  try{const s=snapshot();if(s.frozen)throw Error('Unsettled request blocks further calls');if(s.requests>=auth.max_requests||amount>s.remaining)throw Error('Budget exhausted');const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');db.prepare('INSERT INTO calls VALUES(?,?,?,?,NULL,NULL,?)').run(id,hash,amount,'reserved',new Date().toISOString());db.exec('COMMIT');return {input,amount};}catch(e){db.exec('ROLLBACK');throw e;}
 },settle(id,{usage,complete,outputLimit,evidence={}}){
  const call=db.prepare('SELECT * FROM calls WHERE id=?').get(id);if(!call||call.status==='settled')throw Error('Invalid settlement');const actual=usageTotal(usage);const input=actual===null?null:actual-usage.output_tokens;
  const valid=complete&&actual!==null&&actual<=call.reservation&&input<=call.reservation-outputLimit&&usage.output_tokens<=outputLimit;
  db.prepare('UPDATE calls SET status=?,actual=?,evidence=? WHERE id=?').run(valid?'settled':'unknown',actual,JSON.stringify(evidence),id);return valid;
 }};
}
