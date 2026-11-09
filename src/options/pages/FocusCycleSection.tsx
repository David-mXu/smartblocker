import React, { useEffect, useState } from 'react';
import { Play, Square } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import type { FocusCycleProgram } from '../../shared/focus-cycle-types';
import type { FocusCycleResponse } from '../../shared/messages';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';

interface Props { category: string }

export function FocusCycleSection({ category }: Props) {
  const [mode, setMode] = useState<'focus' | 'pomodoro'>('focus');
  const [workMinutes, setWorkMinutes] = useState(25);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [cycles, setCycles] = useState(2);
  const [program, setProgram] = useState<FocusCycleProgram | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    const response = (await api.runtime.sendMessage({ type: 'GET_FOCUS_CYCLE' })) as FocusCycleResponse;
    if (!response.ok) throw new Error(response.error ?? 'Could not read the focus cycle.');
    setProgram(response.program ?? null);
    setLoaded(true);
    if (response.error) setMessage(response.error);
  };

  useEffect(() => {
    void load().catch((error) => setMessage(String(error)));
    const timer = setInterval(() => void load().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, []);

  const run = async (action: 'start' | 'cancel') => {
    setBusy(true);
    setMessage('');
    try {
      const response = (await api.runtime.sendMessage(action === 'cancel'
        ? { type: 'CANCEL_FOCUS_CYCLE' }
        : { type: 'START_FOCUS_CYCLE', category, mode, workMinutes, breakMinutes, cycles })) as FocusCycleResponse;
      setProgram(response.program ?? null);
      if (!response.ok) throw new Error(response.error ?? 'Could not change the cycle.');
      setMessage(action === 'cancel'
        ? 'Stopped future cycles. Any active fixed grant will end on its own clock.'
        : mode === 'focus'
          ? 'Focus session started now — complete the timer to earn reward.'
          : 'Pomodoro started with separate fixed breaks.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const number = (value: number, update: (next: number) => void) => ({
    type: 'number' as const, min: 1, max: 1440, step: 1, value,
    disabled: busy || Boolean(program),
    className: 'w-24',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(event.target.valueAsNumber),
  });

  return (
    <SettingsSection
      title="Focus & Pomodoro"
      description="An immediate focus session earns reward only when its timer completes — it does not create a Frozen lock. Pomodoro work earns the same way. Its programmed breaks are fixed and do not spend ordinary allowance or use waiting escalation."
    >
      <SettingsGroup>
        <SettingRow label="Program" description={program
          ? `${program.mode === 'focus' ? 'Focus' : 'Pomodoro'} · cycle ${program.cycle}/${program.totalCycles} · ${program.stage} · ends ${new Date(program.stageEndsAtMs).toLocaleTimeString()}`
          : 'No active focus or Pomodoro cycle.'}>
          <select
            id="focus-mode" value={mode} disabled={busy || Boolean(program)}
            onChange={(event) => setMode(event.target.value as 'focus' | 'pomodoro')}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="focus">Immediate focus</option>
            <option value="pomodoro">Pomodoro</option>
          </select>
        </SettingRow>
        <div className="flex flex-wrap gap-3 px-4 py-3.5 text-[13px] text-muted-foreground">
          <label className="flex items-center gap-2">Work (min)
            <Input id="focus-work-minutes" {...number(workMinutes, setWorkMinutes)} />
          </label>
          <label className="flex items-center gap-2">Break (min)
            <Input id="focus-break-minutes" {...number(breakMinutes, setBreakMinutes)} />
          </label>
          {mode === 'pomodoro' && (
            <label className="flex items-center gap-2">Cycles
              <Input id="focus-cycle-count" {...number(cycles, setCycles)} max={4} />
            </label>
          )}
        </div>
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <Button
            id="focus-cycle-start" disabled={!loaded || busy || Boolean(program)}
            onClick={() => void run('start')}
          >
            <Play className="size-3.5" />{mode === 'focus' ? 'Start focus now' : 'Start Pomodoro'}
          </Button>
          {program && (
            <Button id="focus-cycle-cancel" variant="secondary" disabled={busy} onClick={() => void run('cancel')}>
              <Square className="size-3.5" />Stop future cycles
            </Button>
          )}
        </div>
      </SettingsGroup>
      <p id="focus-cycle-msg" role="status" className="m-0 px-1 text-xs text-muted-foreground">{message}</p>
    </SettingsSection>
  );
}
