import React, { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { errorText, invoke, type BrowserIntegration } from '../api';
import { extensionGraceText } from '../../shared/grace-math';
import { SUPPORTED_BROWSERS, browserGrace, connectedBrowser, seenText } from '../format';
import { FormMessage, Page, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export function BrowsersPage() {
  const { status } = useStatus();
  const running = status.daemon.running;

  return (
    <Page
      title="Browsers"
      description="SmartBlocker needs its extension in each browser you use. While a lock is on, the companion closes any browser it can’t see SmartBlocker running in."
    >
      {!running && (
        <Callout tone="warning" id="browsers-daemon-down">
          The companion isn’t running, so authenticated extension connections are unknown. Installation and registration evidence is still shown. You can start it from{' '}
          <a href="#home" className="underline underline-offset-2">
            Home
          </a>
          . If it keeps stopping, use Repair in Settings.
        </Callout>
      )}

      {status.browserIntegrations.length === 0 && (
        <Callout tone="warning" id="browser-integration-unavailable">
          Browser installation and registration checks are unavailable. Any authenticated connection evidence is shown
          separately; missing inspection data is not being treated as an uninstalled browser.
        </Callout>
      )}

      <SettingsSection title="Supported browsers">
        <SettingsGroup id="browser-list">
          {SUPPORTED_BROWSERS.map((browser) => (
            <BrowserRow key={browser.kind} browser={browser} />
          ))}
        </SettingsGroup>
      </SettingsSection>

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

function BrowserRow({ browser }: { browser: SupportedBrowser }) {
  const { status, now, refresh } = useStatus();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const { kind, name } = browser;
  const running = status.daemon.running;
  const info = connectedBrowser(status, kind);
  const integration = status.browserIntegrations.find((entry) => entry.browser === kind);
  const grace = running ? browserGrace(status, kind, now) : null;
  const inGrace = grace?.state === 'grace' || grace?.state === 'expired';

  const repair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // The backend message is authoritative: repaired, already healthy,
      // undetected, or explicitly skipped in test mode.
      const result = await invoke('repair_browser', { browser: kind });
      setMsg({ tone: 'ok', text: result.message });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  let description: string;
  let badge: React.ReactNode;
  const evidence = integrationEvidence(integration);
  if (!running) {
    description = `${evidence} · authenticated extension connection unknown while the companion is stopped`;
    badge = <Badge dot>Unknown</Badge>;
  } else if (inGrace) {
    description = `${extensionGraceText(grace)} · ${evidence}`;
    badge = (
      <Badge variant="warning" dot>
        {grace.state === 'grace' ? 'Grace active' : 'Closing now'}
      </Badge>
    );
  } else if (info) {
    description = `${evidence} · extension connected (v${info.extVersion}, ${seenText(info.lastSeenMs, now)})`;
    badge = (
      <Badge variant="success" dot>
        Protected
      </Badge>
    );
  } else {
    description = `${evidence} · extension not connected`;
    badge = integration?.installation === 'notDetected' ? (
      <Badge dot>Not detected</Badge>
    ) : (
      <Badge variant="warning" dot>
        Not protected
      </Badge>
    );
  }

  const canRepair =
    integration?.installation === 'installed' && (!info || integration.registration !== 'healthy');
  const showSteps = running && !info && !inGrace;

  return (
    <SettingRow
      data-browser={kind}
      className="browser-row"
      stacked={showSteps || msg !== null}
      label={name}
      description={<span className="tabular-nums">{description}</span>}
      control={
        <>
          {badge}
          {canRepair && (
            <Button
              id={`repair-connection-${kind}`}
              variant="secondary"
              size="xs"
              onClick={repair}
              disabled={busy}
            >
              {busy ? 'Repairing…' : 'Repair connection'}
            </Button>
          )}
        </>
      }
    >
      {showSteps && <FixSteps name={name} integration={integration} />}
      <FormMessage id={`repair-${kind}-msg`} message={msg} />
    </SettingRow>
  );
}

function integrationEvidence(integration: BrowserIntegration | undefined): string {
  if (!integration) return 'Installation and registration checks unavailable';
  const installation = integration.installation === 'installed' ? 'Browser detected' : 'Browser not detected';
  const registration = {
    healthy: 'registration healthy',
    missing: 'registration missing',
    invalid: 'registration needs repair',
    unreadable: 'registration unreadable',
  }[integration.registration];
  return `${installation} · ${registration}`;
}

function FixSteps({
  name,
  integration,
}: {
  name: string;
  integration: BrowserIntegration | undefined;
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-3 text-[13px] text-muted-foreground">
      <Step n={1}>
        Install or enable the SmartBlocker extension in {name}. Repairing its connection never installs the extension.
      </Step>
      <Step n={2}>
        {!integration
          ? 'Browser inspection is unavailable, so no repair action is offered from missing evidence.'
          : integration.installation === 'notDetected'
            ? `${name} wasn’t detected. Repair is unavailable, so no registration is written for an undetected browser.`
            : `Use Repair connection above to repair only ${name}’s Native Messaging registration and verify the saved files afterward.`}
      </Step>
      <Step n={3}>Restart {name}. Only an authenticated extension connection shows Protected.</Step>
    </ol>
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
