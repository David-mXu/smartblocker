import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS = '__smartblockerForceRedirectRuleTest';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const path = url.split('?')[0];
    if (path.endsWith('/src/shared/api.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const api = globalThis.${HARNESS}.api; export const IS_FIREFOX = false;`,
      };
    }
    if (path.endsWith('/src/shared/lock.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const getLockStatus = async () => ({ forceBlocking: false });',
      };
    }
    return nextLoad(url, context);
  },
});

const existing = {
  id: 1_000_500,
  priority: 1000,
  action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } },
  condition: {
    tabIds: [70],
    resourceTypes: ['main_frame'],
    urlFilter: '|https://example.test/static|',
  },
};
const rules = [structuredClone(existing)];
const liveTabs = new Set([70, 71]);
globalThis[HARNESS] = {
  api: {
    declarativeNetRequest: {
      async getSessionRules() { return structuredClone(rules); },
      async updateSessionRules(change) {
        const removed = new Set(change.removeRuleIds ?? []);
        for (let n = rules.length - 1; n >= 0; n--) {
          if (removed.has(rules[n].id)) rules.splice(n, 1);
        }
        if (change.addRules) rules.push(...structuredClone(change.addRules));
      },
    },
    tabs: {
      async get(tabId) {
        if (!liveTabs.has(tabId)) throw new Error('missing tab');
        return { id: tabId };
      },
      async query() { return [...liveTabs].map((id) => ({ id })); },
    },
  },
};

const info = { title: 'game', label: 'video games', score: 0.99, ms: 2, reason: 'dnf-redirect' };
const { addForceRedirectRule, clearForceRedirectRule } = await import(
  `../src/background/force-redirect.ts?rule-test=${process.pid}`
);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('force redirect ownership tests');
await test('service-worker reconciliation returns already-enforced, not ownership', async () => {
  const result = await addForceRedirectRule(70, 'https://example.test/static', info);
  assert.deepEqual(result, { status: 'already-enforced' });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, existing.id);
});
await test('a newly installed rule receives its own rollback identity', async () => {
  const first = await addForceRedirectRule(71, 'https://example.test/new', info);
  assert.equal(first.status, 'installed');
  assert.equal(typeof first.ruleId, 'number');
  assert.notEqual(first.ruleId, existing.id);
  const second = await addForceRedirectRule(71, 'https://example.test/new', info);
  assert.deepEqual(second, { status: 'already-enforced' });
  assert.equal(rules.filter((rule) => rule.condition.tabIds?.[0] === 71).length, 1);
});
await test('only the exact owner ID can remove a rule; ordinary allowed clearing still works', async () => {
  const installed = await addForceRedirectRule(71, 'https://example.test/other', info);
  assert.equal(installed.status, 'installed');
  await clearForceRedirectRule(71, 'https://example.test/other', installed.ruleId + 999);
  assert.equal(rules.some((rule) => rule.id === installed.ruleId), true);
  await clearForceRedirectRule(71, 'https://example.test/other', installed.ruleId);
  assert.equal(rules.some((rule) => rule.id === installed.ruleId), false);
  await clearForceRedirectRule(70, 'https://example.test/static');
  assert.equal(rules.some((rule) => rule.id === existing.id), false);
});
await test('invalid/capability failures return failed rather than fabricated ownership', async () => {
  assert.deepEqual(await addForceRedirectRule(70, 'not a URL', info), { status: 'failed' });
  assert.deepEqual(
    await addForceRedirectRule(70, `https://example.test/${'x'.repeat(9_000)}`, info),
    { status: 'failed' },
  );
});
console.log(`\n${passed} passed, 0 failed`);
