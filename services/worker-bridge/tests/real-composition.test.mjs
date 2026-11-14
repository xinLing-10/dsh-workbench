import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { apply, normalizeConfig } from '../index.mjs';

/**
 * Composition test against the real Cordis runtime shipped with DSH.
 *
 * It proves the plugin registers its listeners on the real event names of this
 * DSH build (not on a hand-made fake context). It does not run a model, so
 * approvals/questions are exercised only by the handler tests.
 */
const DSH_ROOT = process.env.DSH_INSTALL
  || '/Users/xinlin/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';
const CORDIS = join(DSH_ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js');

test('apply registers the approval and question listeners on a real Context', async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href);
  const ctx = new Context();
  const seen = [];
  const originalOn = ctx.on.bind(ctx);
  ctx.on = (event, listener) => {
    seen.push(event);
    return originalOn(event, listener);
  };

  apply(ctx, {
    enabled: true,
    productApiUrl: 'http://127.0.0.1:1',
    workerSecret: 'composition-secret-1234567890',
    workerId: 'wrk_test',
    tenantId: 'ten_test',
    projectId: 'prj_test',
  });

  assert.ok(seen.includes('approval/request'), `registered: ${seen.join(', ')}`);
  assert.ok(seen.includes('user-questions/request'), `registered: ${seen.join(', ')}`);
  ctx.stop?.();
});

test('a disabled or incomplete config registers nothing', async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href);
  const ctx = new Context();
  const seen = [];
  const originalOn = ctx.on.bind(ctx);
  ctx.on = (event, listener) => {
    seen.push(event);
    return originalOn(event, listener);
  };
  apply(ctx, normalizeConfig({ enabled: false }));
  apply(ctx, { enabled: true, productApiUrl: '', workerSecret: '' });
  assert.deepEqual(seen, []);
  ctx.stop?.();
});
