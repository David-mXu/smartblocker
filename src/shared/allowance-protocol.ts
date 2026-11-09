// Additive item10 messages carried inside the existing v2 native-messaging
// frames. Field absence means extension-only fallback/older companion support,
// never a fictitious zero-balance authority.

import type { AllowanceCommand, AllowanceCommandRefusal, AllowanceAuthorityState } from './allowance-state';

export interface AllowanceCommandIntent {
  v: number;
  type: 'allowanceCommand';
  command: AllowanceCommand;
  baseRevision: number;
}

export interface AllowanceCommandAck {
  v: number;
  type: 'allowanceCommandResult';
  ok: boolean;
  operationId: string;
  allowance: AllowanceAuthorityState;
  reason?: AllowanceCommandRefusal;
  duplicate?: boolean;
}

export interface AllowanceSyncMessage {
  v: number;
  type: 'allowanceStateSync';
  allowance: AllowanceAuthorityState;
}

/** One-shot recovery for an actual uninitialized daemon. Never sent after an
 * authority exists; a persist failure returns no success acknowledgement. */
export type AllowanceBootstrapIntent = Omit<AllowanceSyncMessage, 'type'> & {
  type: 'allowanceBootstrap';
};

export type AllowanceProtocolMessage =
  | AllowanceCommandIntent
  | AllowanceCommandAck
  | AllowanceSyncMessage
  | AllowanceBootstrapIntent;
