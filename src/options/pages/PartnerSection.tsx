import React, { useState } from 'react';
import { Copy, UserPlus, LockSimpleOpen, Key } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import type { PartnerCommandResponse } from '../../shared/messages';
import { partnerOperationFromResult } from '../../shared/companion-protocol';
import type { PendingPartnerOperation } from '../../shared/companion-protocol';
import type { OptionsState } from '../useOptionsState';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { LockedNote } from './Page';

const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/;

/** CommandResult.message carries the exact newly-created operation JSON. Do
 * not pick the last pending entry: a concurrent client may have appended B. */
function operationFromResponse(response: PartnerCommandResponse): PendingPartnerOperation {
  return partnerOperationFromResult(response.message, response.status);
}

export function PartnerSection({ state }: { state: OptionsState }) {
  const [publicKey, setPublicKey] = useState('');
  const [pending, setPending] = useState<PendingPartnerOperation | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const companion = state.companion?.state === 'connected' ? state.companion : null;
  const partner = companion?.status?.partner ?? null;
  const currentArm = companion?.status?.lockState.partnerArmGeneration ?? null;
  const activeKeys = partner?.publicKeys.filter((entry) =>
    Number.isSafeInteger(entry.activationObservedAtMs) &&
    Number.isSafeInteger(entry.activationObservedMonoMs)
  ) ?? [];

  const run = async (command: 'add-key' | 'arm' | 'begin-operation' | 'redeem') => {
    setBusy(true);
    setMessage('');
    try {
      const response = (await api.runtime.sendMessage({
        type: 'PARTNER_COMMAND',
        command: command === 'add-key'
          ? { action: command, publicKey: publicKey.trim().toLowerCase() }
          : command === 'redeem'
            ? { action: command, token: code.trim() }
            : { action: command },
      })) as PartnerCommandResponse;
      if (!response.ok || !response.status) throw new Error(response.error ?? response.message ?? 'Daemon refused the command.');
      if (command === 'add-key') setMessage('Public key saved. The 24-hour activation delay is now running; existing arms are unchanged.');
      if (command === 'arm') setMessage('Partner arm created. Blocking and all other lock timers stay unchanged.');
      if (command === 'begin-operation') {
        const next = operationFromResponse(response);
        setPending(next);
        setMessage('Give this exact operation to your partner. A private signing key is never sent from this browser.');
      }
      if (command === 'redeem') {
        setMessage(response.message ?? 'Partner code redeemed for its exact arm. Other locks and ordinary blocking are unchanged.');
        setCode('');
        setPending(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Accountability partner"
      description="The daemon verifies partner-held Ed25519 signatures offline. Public-key changes take 24 hours. A signed code releases only the exact arm it was issued for."
      aside={<Badge variant={currentArm ? 'commit' : 'outline'}>{currentArm ? 'Arm active' : 'Not armed'}</Badge>}
    >
      {currentArm && <LockedNote reason="The current partner arm is a settings lock. Redeeming it never lifts any other gate." className="px-1" />}
      <SettingsGroup>
        <SettingRow label="Partner public key" description="Paste the public half of a key generated on your partner's device. Private keys do not belong here.">
          <Button disabled={busy || (companion !== null && !HEX_PUBLIC_KEY.test(publicKey.trim().toLowerCase()))} onClick={() => void run('add-key')}>
            <UserPlus className="size-3.5" />Register public key
          </Button>
        </SettingRow>
        <div className="px-4 pb-4">
          <Input
            id="partner-public-key" value={publicKey} disabled={busy} spellCheck={false}
            onChange={(event) => setPublicKey(event.target.value)}
            placeholder="64 hexadecimal characters" className="font-mono text-xs"
          />
        </div>
        <div className="px-4 pb-4 text-xs text-muted-foreground">
          {(partner?.publicKeys.length ?? 0) === 0
            ? 'No public keys yet. You cannot arm until one reaches activation.'
            : partner?.publicKeys.map((entry) => (
                <p key={entry.publicKey} className="mt-1">
                  …{entry.publicKey.slice(-16)} · {Number.isSafeInteger(entry.activationObservedAtMs) && Number.isSafeInteger(entry.activationObservedMonoMs)
                    ? 'active (wall + elapsed time proven)'
                    : `24-hour wall/elapsed activation pending; wall boundary ${new Date(entry.activeAtMs).toLocaleString()}`}
                </p>
              ))}
        </div>
        <SettingRow label="Arm" description={currentArm ? 'This partner arm is active. Create a signing operation and redeem it with its exact partner code.' : activeKeys.length === 0 ? 'An activated public key is required before arming.' : 'Arm a fresh partner gate while no other settings lock is active.'}>
          <Button disabled={busy || Boolean(currentArm) || activeKeys.length === 0} onClick={() => void run('arm')}>
            <Key className="size-3.5" />Arm partner gate
          </Button>
        </SettingRow>
        <SettingRow label="Create offline operation" description="The operation binds this installation, the current arm, a unique ID, nonce, and 15-minute expiry.">
          <Button disabled={busy || !currentArm} onClick={() => void run('begin-operation')}>Create operation</Button>
        </SettingRow>
        {pending && (
          <div className="flex flex-col gap-3 px-4 pb-4">
            <label htmlFor="partner-operation" className="text-[13px] text-muted-foreground">Operation to give your partner</label>
            <Textarea id="partner-operation" readOnly rows={5} value={JSON.stringify(pending, null, 2)} className="font-mono text-xs" />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline" size="sm"
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(pending, null, 2)).then(() => setMessage('Operation copied for offline signing.'))}
              >
                <Copy className="size-3.5" />Copy operation
              </Button>
            </div>
            <p className="m-0 text-xs text-faint">
              Run <code>smartblocker-daemon partner-sign '&lt;operation-json&gt;' '&lt;expiry&gt;' '&lt;private-key-hex&gt;'</code> on the partner's device.
              Expiry must not exceed {new Date(pending.expiresAtMs).toLocaleString()}.
            </p>
          </div>
        )}
        <SettingRow label="Redeem signed code" description="Only the signed arm releases. Timer, Frozen, schedules, passwords, delay/random-text, and the normal blocking toggle stay exactly where they were.">
          <Button disabled={busy || code.trim().length === 0} onClick={() => void run('redeem')}>
            <LockSimpleOpen className="size-3.5" />Redeem
          </Button>
        </SettingRow>
        <div className="px-4 pb-4">
          <Textarea
            id="partner-redeem-code" value={code} disabled={busy} rows={4} spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
            placeholder="SBP1.…" className="font-mono text-xs"
          />
        </div>
      </SettingsGroup>
      <p id="partner-msg" role="status" className="m-0 px-1 text-xs text-muted-foreground">{message}</p>
      <p className="m-0 px-1 text-xs text-faint">
        Partner-only flow: <code>smartblocker-daemon partner-keygen</code> creates a keypair. The secret half stays on the partner's device.
        {!companion && ' Desktop pairing is required for setup and redemption; an offline browser cannot release this arm.'}
      </p>
    </SettingsSection>
  );
}
