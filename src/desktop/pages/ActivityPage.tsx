import React, { useMemo, useState } from 'react';
import { Switch } from '../../components/ui/switch';
import { SettingsGroup } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import { describeEvents, type ActivityItem } from '../activity';
import { dayHeading, formatTime } from '../format';
import { Page } from '../components/Page';
import { useStatus } from '../useDesktop';

export function ActivityPage() {
  const { activity, now } = useStatus();
  const [technical, setTechnical] = useState(false);

  const items = useMemo(() => describeEvents(activity ?? []), [activity]);
  const shown = technical ? items : items.filter((i) => i.text !== null);
  const hiddenCount = items.length - items.filter((i) => i.text !== null).length;

  const groups = useMemo(() => {
    const out: { day: string; items: ActivityItem[] }[] = [];
    for (const item of shown) {
      const day = dayHeading(item.event.tsMs, now);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(item);
      else out.push({ day, items: [item] });
    }
    return out;
    // Day headings only change at midnight; `now` is in deps for that.
  }, [shown, now]);

  return (
    <Page
      title="Activity"
      description="What the companion did on this computer. This log stays on this device."
      aside={
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          Show technical events
          <Switch
            id="show-technical"
            checked={technical}
            onChange={(e) => setTechnical(e.target.checked)}
          />
        </label>
      }
    >
      {activity === null ? (
        <div className="min-h-[200px]" aria-busy="true" />
      ) : shown.length === 0 ? (
        <div id="activity-empty" className="flex flex-col gap-1 rounded-xl border border-dashed border-border px-5 py-8 text-center">
          <p className="m-0 text-sm font-medium">Nothing here yet</p>
          <p className="m-0 text-[13px] text-muted-foreground">
            When the companion closes an app or a browser during a lock, it shows up here.
            {hiddenCount > 0 && !technical ? ` ${hiddenCount} technical ${hiddenCount === 1 ? 'event is' : 'events are'} hidden.` : ''}
          </p>
        </div>
      ) : (
        <div id="activity-feed" className="flex flex-col gap-7">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day} className="flex flex-col gap-2.5">
              <h2 className="m-0 px-1 text-[13px] font-medium text-muted-foreground">{g.day}</h2>
              <SettingsGroup>
                <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                  {g.items.map((item, i) => (
                    <ActivityRow key={`${item.event.tsMs}-${i}`} item={item} />
                  ))}
                </ul>
              </SettingsGroup>
            </section>
          ))}
          {!technical && hiddenCount > 0 && (
            <p className="m-0 px-1 text-xs text-faint">
              {hiddenCount} technical {hiddenCount === 1 ? 'event' : 'events'} hidden.
            </p>
          )}
        </div>
      )}
    </Page>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const { event, text, tone } = item;
  return (
    <li className="activity-row flex items-start gap-4 px-4 py-2.5" data-kind={event.kind}>
      <time
        dateTime={new Date(event.tsMs).toISOString()}
        className="w-[64px] shrink-0 pt-px font-mono text-xs tabular-nums text-faint"
      >
        {formatTime(event.tsMs)}
      </time>
      {text !== null ? (
        <span className={cn('min-w-0 text-[13px] leading-relaxed', tone === 'neutral' ? 'text-muted-foreground' : 'text-foreground')}>
          {text}
        </span>
      ) : (
        <span className="min-w-0 break-words font-mono text-xs leading-relaxed text-faint">
          {event.kind} {event.detail}
        </span>
      )}
    </li>
  );
}
