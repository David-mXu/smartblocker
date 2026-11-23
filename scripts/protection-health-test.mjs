// Unit tests for the pure protection-health derivation
// (src/shared/protection-health.ts). No browser APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveProtectionHealth,
  protectionHealthTone,
} from '../src/shared/protection-health.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const base = {
  enabled: true,
  onboarded: true,
  settingsLocked: false,
  forceBlocking: false,
  hasAllUrls: true,
  modelCache: 'present',
  companionState: 'connected',
};
const h = (over = {}) => deriveProtectionHealth({ ...base, ...over });

console.log('protection health tests');

test('a healthy install reports on', () => {
  const health = h();
  assert.equal(health.kind, 'on');
  assert.equal(health.title, 'Protection is on');
  assert.equal(health.fixHref, null);
});

test('revoked site access outranks every other state', () => {
  const health = h({ hasAllUrls: false, onboarded: false, enabled: false });
  assert.equal(health.kind, 'attention');
  assert.match(health.title, /Site access/);
  assert.equal(health.fixHref, '#welcome');
});

test('unfinished onboarding reports setup', () => {
  const health = h({ onboarded: false });
  assert.equal(health.kind, 'setup');
  assert.equal(health.fixHref, '#welcome');
});

test('missing model files warn only while protection should be active', () => {
  assert.equal(h({ modelCache: 'missing' }).kind, 'attention');
  assert.match(h({ modelCache: 'missing' }).title, /Classifier/);
  // Unknown cache state (no Cache API) is not treated as missing.
  assert.equal(h({ modelCache: 'unknown' }).kind, 'on');
  // A paused install should say it is paused, not warn about the model.
  assert.equal(h({ modelCache: 'missing', enabled: false }).kind, 'paused');
  // Forced blocking with the master switch off still needs the model.
  assert.equal(
    h({ modelCache: 'missing', enabled: false, forceBlocking: true }).kind,
    'attention',
  );
});

test('a disconnected companion is surfaced even while locked', () => {
  const health = h({ companionState: 'disconnected', settingsLocked: true });
  assert.equal(health.kind, 'attention');
  assert.equal(health.fixHref, '#companion');
  // "connecting" is transient and must not flap the warning.
  assert.equal(h({ companionState: 'connecting' }).kind, 'on');
  assert.equal(h({ companionState: 'not-installed' }).kind, 'on');
});

test('paused and locked are distinguished, and lock does not mask "off"', () => {
  assert.equal(h({ enabled: false }).kind, 'paused');
  assert.equal(h({ settingsLocked: true }).kind, 'locked');
  assert.equal(
    h({ enabled: false, settingsLocked: true }).kind,
    'paused',
    'a timer lock with blocking off must still say blocking is off',
  );
  assert.equal(h({ enabled: false, forceBlocking: true }).kind, 'locked');
});

test('tone mapping is stable', () => {
  assert.equal(protectionHealthTone('on'), 'success');
  assert.equal(protectionHealthTone('locked'), 'commit');
  assert.equal(protectionHealthTone('paused'), 'warning');
  assert.equal(protectionHealthTone('setup'), 'warning');
  assert.equal(protectionHealthTone('attention'), 'warning');
});

test('dashboard renders every health id (source tripwire)', () => {
  const source = readFileSync(
    new URL('../src/options/pages/DashboardPage.tsx', import.meta.url),
    'utf8',
  );
  for (const id of ['protection-health', 'protection-health-title', 'protection-health-detail', 'protection-health-fix']) {
    assert.ok(source.includes(`id="${id}"`), `missing #${id}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
