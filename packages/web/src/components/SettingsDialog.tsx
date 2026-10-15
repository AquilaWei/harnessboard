// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { quotaPauseLevel } from '@harnessboard/shared';
import type { AgentInfo, AgentProvider, ModelInfo, Settings, TaskSize } from '@harnessboard/shared';
import { api } from '../api';
import { DetectedAgents } from './DetectedAgents';
import { EffortSelect } from './ModelPicker';
import { PhoneAccess } from './PhoneAccess';
import { LANGUAGES, setLanguage } from '../i18n';
import { parseRules } from '../rules';
import type { Language } from '../i18n';
import { notificationPermission, notificationsEnabled, setNotifications } from '../notify';
import { currentNotifyMode } from '../push';
import { THEMES, applyTheme, savedTheme } from '../theme';
import type { Theme } from '../theme';

interface Props {
  settings: Settings;
  configFile: string | null;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

/** Platforms that report their usage; Gemini does not, so it has no pause level to set. */
const QUOTA_PROVIDERS: AgentProvider[] = ['claude-code', 'codex'];

/** A textarea's non-blank lines, trimmed: the server rejects surrounding spaces. */
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** Scheduler settings (saved on the server), agent profiles, and display (this browser). */
export function SettingsDialog({ settings, configFile, onClose, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const [tokenSpike, setTokenSpike] = useState(settings.tokenSpike);
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrent);
  const [pausePcts, setPausePcts] = useState(() =>
    Object.fromEntries(
      QUOTA_PROVIDERS.map((p) => [p, Math.round(quotaPauseLevel(settings, p) * 100)]),
    ),
  );
  const [size, setSize] = useState<TaskSize>(settings.defaultContextPolicy.size ?? 'medium');
  const [reviewer, setReviewer] = useState(settings.defaultReviewer ?? '');
  const [globalRules, setGlobalRules] = useState(settings.allowedTools.join('\n'));
  const parsedRules = parseRules(globalRules);
  const [guidelines, setGuidelines] = useState(settings.reviewGuidelines.join('\n'));
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [notify, setNotify] = useState(notificationsEnabled);
  const [permission, setPermission] = useState(notificationPermission);
  const notifyMode = currentNotifyMode();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  /** Profile efforts changed here, saved with the other settings. */
  const [efforts, setEfforts] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);

  const loadAgents = () => api.agents().then(setAgents, (e: Error) => setError(e.message));
  useEffect(() => void loadAgents(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      for (const [id, effort] of Object.entries(efforts)) await api.setAgentEffort(id, effort);
      onSaved(
        await api.saveSettings({
          maxConcurrent,
          tokenSpike,
          quotaPauseByProvider: {
            ...settings.quotaPauseByProvider,
            ...Object.fromEntries(QUOTA_PROVIDERS.map((p) => [p, pausePcts[p]! / 100])),
          },
          defaultContextPolicy: { ...settings.defaultContextPolicy, size },
          defaultReviewer: reviewer === '' ? null : reviewer,
          allowedTools: parsedRules.rules,
          reviewGuidelines: lines(guidelines),
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
        </div>
        <div className="row">
          {QUOTA_PROVIDERS.map((provider) => (
            <label key={provider} className="field">
              <span>{t('settingsForm.quotaPause', { name: t(`providers.${provider}`) })}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={pausePcts[provider]}
                onChange={(e) =>
                  setPausePcts((current) => ({ ...current, [provider]: Number(e.target.value) }))
                }
              />
            </label>
          ))}
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
          <h3>{t('safety.title')}</h3>
          <label className="field">
            <span>
              <input
                type="checkbox"
                checked={tokenSpike.enabled}
                onChange={(e) => setTokenSpike({ ...tokenSpike, enabled: e.target.checked })}
              />{' '}
              {t('safety.enabled')}
            </span>
          </label>
          <div className="row">
            <label className="field">
              <span>{t('safety.window')}</span>
              <input
                type="number"
                min={1}
                step={1}
                required
                value={tokenSpike.windowSeconds}
                onChange={(e) =>
                  setTokenSpike({ ...tokenSpike, windowSeconds: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              <span>{t('safety.limit')}</span>
              <input
                type="number"
                min={1}
                step={1}
                required
                value={tokenSpike.maxTokens}
                onChange={(e) =>
                  setTokenSpike({ ...tokenSpike, maxTokens: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <p className="hint">{t('safety.hint')}</p>
          <p className="hint">{t('safety.monitoringLimit')}</p>
        </section>
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
                  <th>{t('settingsForm.effort')}</th>
                  <th>{t('settingsForm.state')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.id}</td>
                    <td className="mono">{a.profile.provider}</td>
                    <td className="mono">{a.profile.model ?? t('settingsForm.defaultModel')}</td>
                    <td>
                      <ProfileEffort
                        agent={a}
                        value={a.id in efforts ? efforts[a.id]! : (a.profile.effort ?? null)}
                        onChange={(effort) => setEfforts({ ...efforts, [a.id]: effort })}
                      />
                    </td>
                    <td className={a.ok ? 'ok-text' : 'bad-text'} title={a.error ?? ''}>
                      {a.ok ? `✓ ${a.version ?? ''}` : `✗ ${a.error ?? ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {agents && <p className="hint">{t('settingsForm.effortHint')}</p>}
          <DetectedAgents onAdded={() => void loadAgents()} onError={setError} />
          <p className="hint">
            {configFile
              ? t('settingsForm.agentsHint', { file: configFile })
              : t('settingsForm.agentsHintNoFile')}
          </p>
        </section>

        <PhoneAccess onError={setError} />

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
            disabled={permission === null || notifyMode === 'unsupported'}
            onChange={(e) => {
              const on = e.target.checked;
              setNotifications(on, notifyMode).then(
                (granted) => {
                  setPermission(granted);
                  setNotify(on && granted === 'granted');
                },
                (err: Error) => setError(err.message),
              );
            }}
          />
          <span>
            {t('notify.label')}
            <small className="hint">
              {notifyMode === 'unsupported'
                ? t('notify.pushUnsupported')
                : permission === null
                  ? t('notify.unsupported')
                  : permission === 'denied'
                    ? t('notify.blocked')
                    : notifyMode === 'push'
                      ? t('notify.pushHint')
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

/**
 * A profile's default reasoning effort, chosen from the efforts its own model offers. A
 * profile without a model, or whose model is not listed, shows the stored effort as text.
 */
function ProfileEffort({
  agent,
  value,
  onChange,
}: {
  agent: AgentInfo;
  value: string | null;
  onChange: (effort: string | null) => void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const model = agent.profile.model;

  useEffect(() => {
    if (!model) return;
    let current = true;
    // Without a list there is nothing to choose from; the stored effort still shows.
    api.agentModels(agent.id).then(
      (list) => current && setModels(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [agent.id, model]);

  const info = models.find((m) => m.id === model);
  if (!info || info.efforts.length === 0) {
    return <span className="mono">{value ?? t('models.effortDefault')}</span>;
  }
  return (
    <EffortSelect
      efforts={info.efforts}
      defaultEffort={info.defaultEffort}
      value={value}
      onChange={onChange}
      label={t('settingsForm.effort')}
    />
  );
}
