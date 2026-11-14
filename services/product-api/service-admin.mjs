/** Local operator console. Platform privileges are never inferred from tenant ownership. */
import {importBudgetCarryover} from './src/budget-carryover.mjs';
import {loadConfig} from './src/config.mjs';
import {openDatabase} from './src/db.mjs';
import {auditService} from './src/service-budget.mjs';
const [command,userId]=process.argv.slice(2),db=openDatabase(loadConfig().dbPath);
try {
 if(command==='import-ledger'){console.log(JSON.stringify(importBudgetCarryover(db,userId)));}
 else {
 if(!['grant-admin','revoke-admin'].includes(command)||!db.prepare('SELECT id FROM users WHERE id=?').get(userId))throw Error('Usage: service-admin.mjs grant-admin|revoke-admin <existing-user-id> OR import-ledger <old-budget.sqlite>');
 db.exec('BEGIN IMMEDIATE');
 if(command==='grant-admin')db.prepare('INSERT OR IGNORE INTO platform_admins VALUES(?,?)').run(userId,new Date().toISOString());
 else db.prepare('DELETE FROM platform_admins WHERE user_id=?').run(userId);
 auditService(db,'local-operator',command==='grant-admin'?'platform_admin_granted':'platform_admin_revoked',userId);db.exec('COMMIT');
 console.log(JSON.stringify({command,userId,ok:true}));
 }
}catch(e){if(db.isTransaction)db.exec('ROLLBACK');console.error(e.message);process.exitCode=1;}finally{db.close();}
