/** Optional immutable acceptance allocation, stricter than editable platform policies. */
export function setRunAuthorization(db,record){
 if(!record||typeof record.id!=='string'||!Number.isSafeInteger(record.tokenLimit)||record.tokenLimit<1||!Number.isSafeInteger(record.maxRequests)||record.maxRequests<1||!Number.isSafeInteger(record.carryoverCommitted)||record.carryoverCommitted<0||!Number.isSafeInteger(record.aggregateLimit)||record.tokenLimit+record.carryoverCommitted>record.aggregateLimit)throw Error('Invalid acceptance allocation');
 const serialized=JSON.stringify(record);db.exec('BEGIN IMMEDIATE');try{
  const old=db.prepare('SELECT authorization_json FROM service_run_authorization WHERE id=1').get();
  if(old && old.authorization_json!==serialized)throw Error('Acceptance allocation cannot change on restart');
  if(!old){if(db.prepare('SELECT count(*) n FROM service_model_calls').get().n)throw Error('Use an empty acceptance ledger, never reset existing calls');db.prepare('INSERT INTO service_run_authorization VALUES(1,?)').run(serialized);}
  db.exec('COMMIT');return record;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function baseAuthorization(db){const r=db.prepare('SELECT authorization_json FROM service_run_authorization WHERE id=1').get();return r?JSON.parse(r.authorization_json):null;}
function applyAmendment(current,record){
 const keys=['id','previousId','tokenLimit','maxRequests','aggregateLimit','reason','authorizedAt'];
 if(!current||!record||Object.keys(record).some(k=>!keys.includes(k))||typeof record.id!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(record.id)||record.id===current.id||record.previousId!==(current.amendmentId||current.id)||!Number.isSafeInteger(record.tokenLimit)||record.tokenLimit<=current.tokenLimit||!Number.isSafeInteger(record.maxRequests)||record.maxRequests<current.maxRequests||!Number.isSafeInteger(record.aggregateLimit)||record.aggregateLimit<current.aggregateLimit||record.tokenLimit+current.carryoverCommitted>record.aggregateLimit||typeof record.reason!=='string'||record.reason.trim().length<8||record.reason.length>1000||typeof record.authorizedAt!=='string'||!Number.isFinite(Date.parse(record.authorizedAt)))throw Error('Invalid or stale explicit budget amendment');
 return {...current,tokenLimit:record.tokenLimit,maxRequests:record.maxRequests,aggregateLimit:record.aggregateLimit,amendmentId:record.id};
}
/** Effective cap follows an append-only approval chain; historical calls/holds are untouched. */
export function runAuthorization(db){
 let effective=baseAuthorization(db);if(!effective)return null;
 for(const row of db.prepare('SELECT amendment_json FROM service_run_authorization_amendments ORDER BY sequence').all())effective=applyAmendment(effective,JSON.parse(row.amendment_json));
 return effective;
}
/** Trusted operator entrypoint only, never exposed as a customer HTTP action. */
export function setRunAuthorizationAmendment(db,record){
 const serialized=JSON.stringify(record);db.exec('BEGIN IMMEDIATE');try{
  const old=db.prepare('SELECT amendment_json FROM service_run_authorization_amendments WHERE amendment_id=?').get(record?.id||'');
  if(old){if(old.amendment_json!==serialized)throw Error('Existing budget amendment cannot change');const effective=runAuthorization(db);db.exec('COMMIT');return effective;}
  const effective=applyAmendment(runAuthorization(db),record);
  db.prepare('INSERT INTO service_run_authorization_amendments(amendment_id,amendment_json) VALUES(?,?)').run(record.id,serialized);
  db.exec('COMMIT');return effective;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
