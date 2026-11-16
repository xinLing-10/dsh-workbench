/** Same-host fail-closed ownership, not a distributed lease or multi-host HA. */
import {randomUUID} from 'node:crypto';
export function claimController(db,{name='worker-controller',pid=process.pid,alive=(pid)=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;return true;}}}={}){
 const owner=randomUUID();db.exec('BEGIN IMMEDIATE');try{const old=db.prepare('SELECT * FROM controller_owners WHERE name=?').get(name);if(old&&alive(old.pid))throw Error('Another controller owns this SQLite/workspace. Multi-writer API replicas are unsupported.');db.prepare('INSERT INTO controller_owners VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET pid=excluded.pid,owner=excluded.owner').run(name,pid,owner);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return {assert(){const current=db.prepare('SELECT owner FROM controller_owners WHERE name=?').get(name);if(current?.owner!==owner)throw Error('Controller ownership changed');},release(){db.prepare('DELETE FROM controller_owners WHERE name=? AND owner=?').run(name,owner);}};
}
