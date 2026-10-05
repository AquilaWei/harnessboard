// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo, Settings, TaskSize } from '@harnessboard/shared';
import { api } from '../api';
import { DetectedAgents } from './DetectedAgents';
import { PhoneAccess } from './PhoneAccess';
import { LANGUAGES, setLanguage } from '../i18n';
import { parseRules } from '../rules';
import type { Language } from '../i18n';
import { notificationPermission, notificationsEnabled, setNotifications } from '../notify';
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
  const [globalRules, setGlobalRules] = useState(settings.allowedTools.join('\n'));
  const parsedRules = parseRules(globalRules);
  const [guidelines, setGuidelines] = useState(settings.reviewGuidelines.join('\n'));
  const [remoteHosts, setRemoteHosts] = useState(settings.remoteHosts.join('\n'));
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [notify, setNotify] = useState(notificationsEnabled);
  const [permission, setPermission] = useState(notificationPermission);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = () => api.agents().then(setAgents, (e: Error) => setError(e.message));
  useEffect(() => void loadAgents(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(
        await api.saveSettings({
          maxConcurrent,
          quotaPauseUtilization: pausePct / 100,
          defaultContextPolicy: { ...settings.defaultContextPolicy, size },
          defaultReviewer: reviewer === '' ? null : reviewer,
          allowedTools: parsedRules.rules,
          reviewGuidelines: guidelines
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
          remoteHosts: remoteHosts
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
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

        <label className="field">
          <span>{t('settingsForm.globalRules')}</span>
          <textarea
            rows={Math.max(2, parsedRules.rules.length + parsedRules.invalid.length)}
            className="mono"
            value={globalRules}
            placeholder="Bash(make *)"
            onChange={(e) => setGlobalRules(e.target.value)}
            aria-invalid={parsedRules.invalid.length > 0}
          />
          {parsedRules.invalid.length > 0 ? (
            <small className="hint warn-text">
              {t('permission.invalid', { rules: parsedRules.invalid.join(', ') })}
            </small>
          ) : (
            <small className="hint">{t('settingsForm.globalRulesHint')}</small>
          )}
        </label>

        <label className="field">
          <span>{t('settingsForm.reviewGuidelines')}</span>
          <textarea
            rows={2}
            className="mono"
            value={guidelines}
            placeholder="~/.claude/skills/coding-standards/SKILL.md"
            onChange={(e) => setGuidelines(e.target.value)}
          />
          <small className="hint">{t('settingsForm.reviewGuidelinesHint')}</small>
        </label>

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
          <DetectedAgents onAdded={() => void loadAgents()} onError={setError} />
          <p className="hint">
            {configFile
              ? t('settingsForm.agentsHint', { file: configFile })
              : t('settingsForm.agentsHintNoFile')}
          </p>
        </section>

        <PhoneAccess
          savedHosts={settings.remoteHosts}
          hosts={remoteHosts}
          onHostsChange={setRemoteHosts}
          onError={setError}
        />

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
        <label className="check">
          <input
            type="checkbox"
            checked={notify}
            disabled={permission === null}
            onChange={(e) => {
              const on = e.target.checked;
              void setNotifications(on).then((granted) => {
                setPermission(granted);
                setNotify(on && granted === 'granted');
              });
            }}
          />
          <span>
            {t('notify.label')}
            <small className="hint">
              {permission === null
                ? t('notify.unsupported')
                : permission === 'denied'
                  ? t('notify.blocked')
                  : t('notify.hint')}
            </small>
          </span>
        </label>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={parsedRules.invalid.length > 0}>
            {t('settingsForm.save')}
          </button>
        </div>
      </form>
    </>
  );
}
