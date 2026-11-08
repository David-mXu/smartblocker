import React, { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { errorText, invoke } from '../api';
import { SUPPORTED_BROWSERS, connectedBrowser, joinNames, seenText } from '../format';
import { FormMessage, Page, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

export function BrowsersPage() {
  const { status, now } = useStatus();
  const running = status.daemon.running;
  const missing = SUPPORTED_BROWSERS.filter((b) => !connectedBrowser(status, b.kind));

  return (
    <Page
      title="Browsers"
      description="SmartBlocker needs its extension in each browser you use. While a lock is on, the companion closes any browser it can’t see SmartBlocker running in."
    >
      {!running && (
        <Callout tone="warning" id="browsers-daemon-down">
          The companion isn’t running, so SmartBlocker can’t check your browsers. You can start it from{' '}
          <a href="#home" className="underline underline-offset-2">
            Home
          </a>
          . If it keeps stopping, use Repair in Settings.
        </Callout>
      )}

      <SettingsSection title="Supported browsers">
        <SettingsGroup id="browser-list">
          {SUPPORTED_BROWSERS.map((b) => {
            const info = connectedBrowser(status, b.kind);
            let description: string;
            let badge: React.ReactNode;
            if (!running) {
              description = 'Can’t check while the companion isn’t running';
              badge = <Badge dot>Unknown</Badge>;
            } else if (info) {
              description = `SmartBlocker connected (v${info.extVersion}, ${seenText(info.lastSeenMs, now)})`;
              badge = (
                <Badge variant="success" dot>
                  Protected
                </Badge>
              );
            } else {
              description = 'SmartBlocker isn’t connected';
              badge = (
                <Badge variant="warning" dot>
                  Not protected
                </Badge>
              );
            }
            return (
              <SettingRow
                key={b.kind}
                data-browser={b.kind}
                className="browser-row"
                label={b.name}
                description={<span className="tabular-nums">{description}</span>}
                control={badge}
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      {running && missing.length > 0 && <FixSteps missingNames={missing.map((b) => b.name)} />}

      <SettingsSection title="What gets closed during a lock">
        <SettingsGroup>
          <SettingRow
            label="Browsers without SmartBlocker"
            description="Chrome, Edge or Firefox when the extension is missing, turned off or not responding. You get a warning first."
          />
          <SettingRow
            label="Private and guest windows"
            description="Incognito, InPrivate and guest windows, and browsers started with extensions turned off."
          />
          <SettingRow
            label="Browsers SmartBlocker doesn’t support"
            description="Brave, Opera, Vivaldi, Arc and others — SmartBlocker can’t check pages in them."
          />
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}

function FixSteps({ missingNames }: { missingNames: string[] }) {
  const { status, refresh } = useStatus();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const who = joinNames(missingNames);

  const repair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const result = await invoke('install_integration');
      setMsg({
        tone: 'ok',
        text: status.testMode ? result : 'Browser connection repaired. Restart the browser if it still isn’t connected.',
      });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <SettingsSection title="Fix a browser that isn’t protected" description="Only needed for browsers you actually use.">
      <SettingsGroup>
        <ol className="m-0 flex list-none flex-col gap-3 p-4 text-[13px] text-muted-foreground">
          <Step n={1}>
            Install the SmartBlocker extension in {who}, and make sure it’s turned on.
          </Step>
          <Step n={2}>
            <span className="flex flex-col items-start gap-2.5">
              Repair the browser connection so the extension can reach this app.
              <Button id="repair-connection" onClick={repair} disabled={busy}>
                Repair browser connection
              </Button>
            </span>
          </Step>
          <Step n={3}>Restart the browser. It shows up as protected within a few seconds.</Step>
        </ol>
      </SettingsGroup>
      <FormMessage message={msg} className="px-1" />
    </SettingsSection>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] tabular-nums text-muted-foreground"
      >
        {n}
      </span>
      <span className="min-w-0 pt-px leading-relaxed text-foreground">{children}</span>
    </li>
  );
}
