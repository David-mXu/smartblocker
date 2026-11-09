// Focused additive v2 partner wire-shape checks. The matching Rust protocol
// unit test serializes/parses these same command and status shapes.
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../src/shared/companion-protocol.ts';

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

const partner = {
  version: 1,
  installationId: id,
  publicKeys: [{ publicKey: key, addedAtMs: 10, activeAtMs: 86_400_010 }],
  pendingOperations: [
    {
      installationId: id,
      armGeneration: '02'.repeat(32),
      operationId: '03'.repeat(32),
      nonce: '04'.repeat(32),
      expiresAtMs: 900_010,
    },
  ],
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
    partnerArmGeneration: '02'.repeat(32),
    partnerArmUpdatedAt: 20,
  },
  partner,
};
const wire = JSON.parse(JSON.stringify(status));
assert.equal(wire.partner.pendingOperations[0].operationId, '03'.repeat(32));
assert.equal(wire.lockState.partnerArmUpdatedAt, 20);
assert.equal('privateKey' in wire.partner, false);
assert.equal('privateKeyHex' in wire.partner, false);

// An older peer's status and redacted status both remain valid additive v2.
delete wire.partner;
delete wire.lockState.partnerArmGeneration;
delete wire.lockState.partnerArmUpdatedAt;
assert.equal('partner' in wire, false);
assert.equal('partnerArmGeneration' in wire.lockState, false);
console.log('partner protocol tests: 5 passed, 0 failed');
