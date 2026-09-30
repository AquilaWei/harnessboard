// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo, Settings, TaskSize } from '@harnessboard/shared';
import { api } from '../api';
import { LANGUAGES, setLanguage } from '../i18n';
import type { Language } from '../i18n';
import { THEMES, applyTheme, savedTheme } from '../theme';
import type { Theme } from '../theme';

interface Props {
  settings: Settings;
  configFile: string | null;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

/** Scheduler settings (saved on the server), agent profiles, and display (this browser). */
export function SettingsDialog({ settings, configFile, onClose, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrent);
  const [pausePct, setPausePct] = useState(Math.round(settings.quotaPauseUtilization * 100));
  const [size, setSize] = useState<TaskSize>(settings.defaultContextPolicy.size ?? 'medium');
  const [reviewer, setReviewer] = useState(settings.defaultReviewer ?? '');
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agents().then(setAgents, (e: Error) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(
        await api.saveSettings({
          maxConcurrent,
          quotaPauseUtilization: pausePct / 100,
          defaultContextPolicy: { ...settings.defaultContextPolicy, size },
          defaultReviewer: reviewer === '' ? null : reviewer,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings"
        onSubmit={submit}
      >
        <h2 id="settings">{t('settings')}</h2>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <label className="field">
            <span>{t('settingsForm.maxConcurrent')}</span>
            <input
              type="number"
              min={1}
              max={16}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>{t('settingsForm.quotaPause')}</span>
            <input
              type="number"
              min={1}
              max={100}
              value={pausePct}
              onChange={(e) => setPausePct(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>{t('settingsForm.defaultSize')}</span>
            <select value={size} onChange={(e) => setSize(e.target.value as TaskSize)}>
              {(['small', 'medium', 'large'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`form.sizes.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('settingsForm.defaultReviewer')}</span>
            <select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">{t('form.reviewerNone')}</option>
              {(agents ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <section className="detail-section">
          <h3>{t('settingsForm.agents')}</h3>
          {agents && (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('settingsForm.provider')}</th>
                  <th>{t('settingsForm.model')}</th>
                  <th>{t('settingsForm.state')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.id}</td>
                    <td className="mono">{a.profile.provider}</td>
                    <td className="mono">{a.profile.model ?? t('settingsForm.defaultModel')}</td>
                    <td className={a.ok ? 'ok-text' : 'bad-text'} title={a.error ?? ''}>
                      {a.ok ? `✓ ${a.version ?? ''}` : `✗ ${a.error ?? ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">
            {configFile
              ? t('settingsForm.agentsHint', { file: configFile })
              : t('settingsForm.agentsHintNoFile')}
          </p>
        </section>

        <div className="row">
          <label className="field">
            <span>{t('language')}</span>
            <select value={i18n.language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {Object.entries(LANGUAGES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('theme.label')}</span>
            <select
              value={theme}
              onChange={(e) => {
                const next = e.target.value as Theme;
                setTheme(next);
                applyTheme(next);
              }}
            >
              {THEMES.map((th) => (
                <option key={th} value={th}>
                  {t(`theme.${th}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="btn primary">
            {t('settingsForm.save')}
          </button>
        </div>
      </form>
    </>
  );
}
