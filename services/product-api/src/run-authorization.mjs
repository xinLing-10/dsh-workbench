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
export function runAuthorization(db){const r=db.prepare('SELECT authorization_json FROM service_run_authorization WHERE id=1').get();return r?JSON.parse(r.authorization_json):null;}
