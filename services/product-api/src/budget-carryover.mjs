/** Explicit offline import. Reads legacy ledger read-only, never changes its freeze or authorisation. */
import {DatabaseSync} from 'node:sqlite';import {realpathSync} from 'node:fs';import {createHash} from 'node:crypto';import {auditService} from './service-budget.mjs';
export function importBudgetCarryover(db,filename){
 const source=realpathSync(filename),legacy=new DatabaseSync(source,{readOnly:true});let authorization,calls;
 try{legacy.exec('BEGIN');authorization=legacy.prepare('SELECT * FROM authorization WHERE id=1').get();calls=legacy.prepare('SELECT * FROM calls ORDER BY id').all();legacy.exec('COMMIT');}finally{legacy.close();}
 if(!authorization||!Number.isSafeInteger(authorization.initial_used)||authorization.initial_used<0)throw Error('Invalid legacy ledger');
 let used=authorization.initial_used,held=0;for(const c of calls){if(!['reserved','settled','unknown'].includes(c.status)||!Number.isSafeInteger(c.reservation)||c.reservation<0||c.actual!==null&&(!Number.isSafeInteger(c.actual)||c.actual<0))throw Error('Invalid legacy usage');if(c.status==='settled'){if(c.actual===null)throw Error('Missing settled usage');used+=c.actual;}else held+=Math.max(c.reservation,c.actual??0);}
 const id='legacy_'+createHash('sha256').update(source).digest('hex'),digest=createHash('sha256').update(JSON.stringify({authorization,calls})).digest('hex');
 db.exec('BEGIN IMMEDIATE');try{
  if(db.prepare('SELECT 1 FROM service_budget_carryovers WHERE id=?').get(id))throw Error('Source ledger was already imported; reconcile its receipt, never import again');
  db.prepare('INSERT INTO service_budget_carryovers(id,used,held,evidence,imported_at) VALUES(?,?,?,?,?)').run(id,used,held,digest,new Date().toISOString());auditService(db,'local-operator','budget_carryover_imported',id,{used,held,digest});db.exec('COMMIT');return {id,used,held};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
