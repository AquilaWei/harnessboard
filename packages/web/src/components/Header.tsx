// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { HarnessStatus, Settings } from '@harnessboard/shared';
import { LANGUAGES, setLanguage } from '../i18n';
import type { Language } from '../i18n';
import { QuotaMeter } from './Meter';

interface Props {
  status: HarnessStatus | null;
  settings: Settings | null;
  onNewTask: () => void;
  onSettings: () => void;
}

export function Header({ status, settings, onNewTask, onSettings }: Props) {
  const { t, i18n } = useTranslation();
  const quota = status?.quotas['claude-code'];
  const pauseAt = settings?.quotaPauseUtilization ?? 0.95;
  return (
    <header className="header">
      <div className="brand">
        <img src="/favicon.svg" alt="" />
        Harnessboard
      </div>
      <div className="header-stats">
        {status && (
          <span className="pill">
            {t('running', { n: status.running.length, max: status.maxConcurrent })}
          </span>
        )}
        {status && status.quotaPaused.length > 0 && (
          <span className="pill alert">⏸ {t('quotaPaused')}</span>
        )}
        {quota?.fiveHourUtilization != null ? (
          <QuotaMeter
            label={t('quota5h')}
            utilization={quota.fiveHourUtilization}
            pauseAt={pauseAt}
            resetsAt={quota.resetsAt}
          />
        ) : (
          <span className="pill">{t('quotaUnknown')}</span>
        )}
        {quota?.sevenDayUtilization != null && (
          <QuotaMeter
            label={t('quota7d')}
            utilization={quota.sevenDayUtilization}
            pauseAt={1}
            resetsAt={null}
          />
        )}
      </div>
      <div className="header-actions">
        <select
          aria-label={t('language')}
          value={i18n.language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          className="btn"
        >
          {Object.entries(LANGUAGES).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={onSettings} disabled={!settings}>
          {t('settings')}
        </button>
        <button type="button" className="btn primary" onClick={onNewTask}>
          + {t('newTask')}
        </button>
      </div>
    </header>
  );
}
