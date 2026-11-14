/** Offline control-plane administration; no model or Worker network calls. */
import { randomBytes } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { loadConfig } from './src/config.mjs';
import { openDatabase } from './src/db.mjs';
import { registerWorker, acquireLease, revokeLease, disableWorker } from './src/workers.mjs';
const [command, ...args] = process.argv.slice(2);
const db = openDatabase(loadConfig().dbPath);
try {
  if (command === 'register') {
    const [workerId, tenantId, secretFile] = args;
    if (!secretFile) throw new Error('register <workerId> <tenantId> <new-secret-file>');
    const secret = randomBytes(32).toString('base64url');
    await writeFile(secretFile, secret + '\n', { flag: 'wx', mode: 0o600 });
    try { registerWorker(db, { workerId, tenantId, secret }); }
    catch (error) { await unlink(secretFile); throw error; }
    console.log(JSON.stringify({ workerId, secretFile, registered: true }));
  } else if (command === 'lease') {
    const [workerId, projectId, operationId = '', ttl = '300000'] = args;
    console.log(JSON.stringify(acquireLease(db, { workerId, projectId, operationId, ttlMs: Number(ttl) })));
  } else if (command === 'revoke') {
    revokeLease(db, args[0]); console.log(JSON.stringify({ revoked: true }));
  } else if (command === 'disable') {
    disableWorker(db, args[0]); console.log(JSON.stringify({ disabled: true }));
  } else throw new Error('Commands: register, lease, revoke, disable');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db.close(); }
