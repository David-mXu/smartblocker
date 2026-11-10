// Focused additive v2 partner wire-shape and parser checks. The matching Rust
// protocol unit test serializes/parses these same command and status shapes.
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  partnerOperationFromResult,
} from '../src/shared/companion-protocol.ts';

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`  PASS  ${name}`);
}

check('protocol version and partner command wire shapes are stable', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  const id = '01'.repeat(32);
  const key = 'ab'.repeat(32);
  const messages = [
    { v: 2, type: 'addKey', publicKey: key },
    { v: 2, type: 'arm' },
    { v: 2, type: 'beginOperation' },
    { v: 2, type: 'redeem', token: 'SBP1.payload.signature' },
  ];
  assert.deepEqual(
    messages.map((message) => JSON.parse(JSON.stringify(message))),
    messages,
  );
  assert.equal('privateKey' in messages[0], false);
});

const id = '01'.repeat(32);
const key = 'ab'.repeat(32);
const arm = '02'.repeat(32);
const operation = {
  installationId: id,
  armGeneration: arm,
  operationId: '03'.repeat(32),
  nonce: '04'.repeat(32),
  expiresAtMs: 900_010,
  expiresMonoMs: 12_345,
};
const olderOperation = {
  ...operation,
  operationId: '05'.repeat(32),
  nonce: '06'.repeat(32),
};
const partner = {
  version: 1,
  installationId: id,
  publicKeys: [{ publicKey: key, addedAtMs: 10, activeAtMs: 86_400_010 }],
  pendingOperations: [olderOperation, operation],
  spentCodes: [],
  lastObservedAtMs: 10,
};
const status = {
  companionVersion: 'test',
  pro: true,
  enforcement: { appBlocking: true, watchdog: true, policyProtected: false },
  lockState: {
    timerUntil: null,
    passwordHash: null,
    frozenUntil: null,
    schedules: [],
    partnerArmGeneration: arm,
    partnerArmUpdatedAt: 20,
  },
  partner,
};

check('pending operations carry both clocks and no private material', () => {
  const wire = JSON.parse(JSON.stringify(status));
  assert.equal(wire.partner.pendingOperations[0].operationId, olderOperation.operationId);
  assert.equal(wire.partner.pendingOperations[1].expiresMonoMs, operation.expiresMonoMs);
  assert.equal(wire.lockState.partnerArmUpdatedAt, 20);
  assert.equal('privateKey' in wire.partner, false);
  assert.equal('privateKeyHex' in wire.partner, false);
});

check('the exact operation is selected instead of the latest status entry', () => {
  assert.deepEqual(
    partnerOperationFromResult(JSON.stringify(operation), status),
    operation,
  );
  assert.deepEqual(
    partnerOperationFromResult(JSON.stringify(olderOperation), status),
    olderOperation,
  );
});

check('malformed, incomplete, or mismatched operations are refused', () => {
  const invalid = [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...operation, expiresMonoMs: undefined }),
    JSON.stringify({ ...operation, expiresMonoMs: -1 }),
    JSON.stringify({ ...operation, expiresAtMs: 0 }),
    JSON.stringify({ ...operation, extra: 1 }),
    JSON.stringify({ ...operation, operationId: `${'0g'.repeat(32)}` }),
    JSON.stringify({ ...operation, installationId: '07'.repeat(32) }),
    JSON.stringify({ ...operation, nonce: '08'.repeat(32) }),
  ];
  for (const message of invalid) {
    assert.throws(
      () => partnerOperationFromResult(message, status),
      /pending operation|does not match/,
    );
  }
  assert.throws(
    () => partnerOperationFromResult(JSON.stringify(operation), { ...status, partner: null }),
    /does not match/,
  );
});

check('an older peer status and redacted status remain valid additive v2', () => {
  const wire = JSON.parse(JSON.stringify(status));
  delete wire.partner;
  delete wire.lockState.partnerArmGeneration;
  delete wire.lockState.partnerArmUpdatedAt;
  assert.equal('partner' in wire, false);
  assert.equal('partnerArmGeneration' in wire.lockState, false);
});

console.log(`partner protocol tests: ${checks} passed, 0 failed`);
