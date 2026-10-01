// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessStatus, QuotaInfo, Settings } from '@harnessboard/shared';
import { windowAt } from '../quota';
import { QuotaMeter } from './Meter';

interface Props {
  running: number;
  attention: number;
  status: HarnessStatus | null;
  settings: Settings | null;
  onNewTask: () => void;
  onSettings: () => void;
}

/** Brand, a one-line summary of the board, the quota, and the two global actions. */
export function Header({ running, attention, status, settings, onNewTask, onSettings }: Props) {
  const { t } = useTranslation();
  const quota = status?.quotas['claude-code'] ?? null;
  const paused = (status?.quotaPaused.length ?? 0) > 0;

  const jumpToAttention = () =>
    document.getElementById('stage-attention')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <header className="header">
      <div className="brand">
        <img src="/favicon.svg" alt="" />
        <span>Harnessboard</span>
      </div>
      <div className="summary">
        <span className="chip">
          <span className="status-dot running" aria-hidden />{' '}
          {t('summary.running', { count: running })}
        </span>
        {attention > 0 && (
          <button type="button" className="chip chip-attention" onClick={jumpToAttention}>
            ! {t('summary.attention', { count: attention })}
          </button>
        )}
        <QuotaButton
          quota={quota}
          paused={paused}
          pauseAt={settings?.quotaPauseUtilization ?? 0.95}
        />
      </div>
      <div className="header-actions">
        <button type="button" className="btn" onClick={onSettings} disabled={!settings}>
          {t('settings')}
        </button>
        <button type="button" className="btn primary" onClick={onNewTask} disabled={!settings}>
          + {t('newTask')}
        </button>
      </div>
    </header>
  );
}

/** Compact quota reading that opens the full breakdown. */
function QuotaButton(props: { quota: QuotaInfo | null; paused: boolean; pauseAt: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const { quota, paused, pauseAt } = props;
  if (quota?.fiveHourUtilization == null) {
    return <span className="chip muted">{t('summary.quotaUnknown')}</span>;
  }
  const now = Date.now();
  // Snapshots from before 0.0.5 have no per-window reset; the top-level one is the best guess.
  const fiveHour = windowAt(
    quota.fiveHourUtilization,
    quota.fiveHourResetsAt ?? quota.resetsAt,
    now,
  );
  const sevenDay =
    quota.sevenDayUtilization == null
      ? null
      : windowAt(quota.sevenDayUtilization, quota.sevenDayResetsAt, now);
  const pct = Math.round(fiveHour.utilization * 100);
  return (
    <div className="popover-anchor" ref={box}>
      <button
        type="button"
        className={`chip ${paused ? 'chip-warning' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {paused ? `⏸ ${t('summary.quotaPaused')}` : `${t('summary.quota')} 5h ${pct}%`}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label={t('quota.title')}>
          <h3>{t('quota.title')}</h3>
          <QuotaMeter
            label={t('quota.fiveHour')}
            utilization={fiveHour.utilization}
            pauseAt={pauseAt}
            resetsAt={fiveHour.resetsAt}
          />
          {sevenDay && (
            <QuotaMeter
              label={t('quota.sevenDay')}
              utilization={sevenDay.utilization}
              pauseAt={1}
              resetsAt={sevenDay.resetsAt}
            />
          )}
          <p className="hint">
            {paused ? t('quota.paused') : t('quota.pauseAt', { pct: Math.round(pauseAt * 100) })}
          </p>
        </div>
      )}
    </div>
  );
}
