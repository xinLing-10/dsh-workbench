import { loadConfig } from './src/config.mjs';
import { openDatabase } from './src/db.mjs';
import { createDispatcher } from './src/dispatcher.mjs';
const config = loadConfig();
if (!config.simulate) throw new Error('Set PRODUCT_API_SIMULATE=1 to enable simulation only');
const db = openDatabase(config.dbPath);
try {
  const dispatcher = createDispatcher({ db, enabled: true, interactive: config.simulationFlow });
  if (process.argv.includes('--recover')) dispatcher.recover();
  else await dispatcher.tick();
  console.log(JSON.stringify({ simulation: true, states: db.prepare('SELECT state, COUNT(*) AS count FROM operations GROUP BY state').all() }));
} finally { db.close(); }
