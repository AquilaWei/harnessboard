// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { definedOnly } from '@harnessboard/shared';
import type { AgentInfo, Settings, TaskMode, TaskSize } from '@harnessboard/shared';
import { api } from '../api';
import { FolderField } from './FolderField';

const RECENT_KEY = 'harnessboard.recentRepos';
const RECENT_MAX = 6;

function recentRepos(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRepo(repo: string): void {
  try {
    const next = [repo, ...recentRepos().filter((r) => r !== repo)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // only a convenience for the next task
  }
}

interface Props {
  settings: Settings;
  onClose: () => void;
  onCreated: (id: number) => void;
}

/** The essentials first (what, where, what kind, who reviews); everything else is folded away. */
export function NewTaskDialog({ settings, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const recent = recentRepos();
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState(recent[0] ?? '');
  const [mode, setMode] = useState<TaskMode>('single');
  const [verify, setVerify] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [reviewer, setReviewer] = useState<string>(settings.defaultReviewer ?? '');
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const [size, setSize] = useState<TaskSize>(settings.defaultContextPolicy.size ?? 'medium');
  const [custom, setCustom] = useState(false);
  const [soft, setSoft] = useState(40);
  const [hard, setHard] = useState(50);
  const [allow, setAllow] = useState('');
  const [skip, setSkip] = useState(false);
  const [queue, setQueue] = useState(true);
  const [confirmPlan, setConfirmPlan] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agents().then(setAgents, (e: Error) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const extraTools = allow
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    try {
      const task = await api.createTask(
        definedOnly({
          prompt,
          repo: repo.trim(),
          mode,
          verifyCommand: mode === 'loop' ? verify.trim() || undefined : undefined,
          confirmPlan: mode === 'loop' ? confirmPlan : undefined,
          reviewer: reviewer === '' ? null : reviewer,
          title: title.trim() || undefined,
          baseRef: base.trim() || undefined,
          size,
          softPct: custom ? soft : undefined,
          hardPct: custom ? hard : undefined,
          allowedTools: extraTools.length > 0 ? extraTools : undefined,
          skipPermissions: skip || undefined,
          queue,
        }),
      );
      rememberRepo(repo.trim());
      onCreated(task.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task"
        onSubmit={submit}
      >
        <h2 id="new-task">{t('newTask')}</h2>
        {error && <div className="error">{error}</div>}

        <fieldset className="choice-cards">
          <legend>{t('form.mode')}</legend>
          {(['single', 'loop'] as const).map((m) => (
            <label key={m} className={`choice ${mode === m ? 'selected' : ''}`}>
              <input
                type="radio"
                name="mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <strong>{t(`form.modes.${m}`)}</strong>
              <small>{t(`form.modeHints.${m}`)}</small>
            </label>
          ))}
        </fieldset>

        <label className="field">
          <span>{t(mode === 'loop' ? 'form.goal' : 'form.prompt')}</span>
          <textarea
            required
            rows={5}
            value={prompt}
            placeholder={t('form.promptHint')}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </label>

        <FolderField value={repo} onChange={setRepo} recent={recent} />

        {mode === 'loop' && (
          <label className="field">
            <span>{t('form.verify')}</span>
            <input
              className="mono"
              value={verify}
              required={!confirmPlan}
              placeholder={confirmPlan ? t('form.verifyOptional') : 'npm test'}
              onChange={(e) => setVerify(e.target.value)}
            />
            <small className="hint">
              {t(confirmPlan ? 'form.verifyHintPlan' : 'form.verifyHint')}
            </small>
          </label>
        )}

        <label className="field">
          <span>{t('form.reviewer')}</span>
          <select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            <option value="">{t('form.reviewerNone')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.ok}>
                {a.id}
                {a.profile.model ? ` (${a.profile.model})` : ''}
                {a.ok ? '' : ` ${t('form.agentMissing')}`}
              </option>
            ))}
          </select>
          <small className="hint">{t('form.reviewerHint')}</small>
        </label>

        <details className="advanced">
          <summary>{t('form.advanced')}</summary>
          <div className="row">
            <label className="field">
              <span>{t('form.title')}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
              <small className="hint">{t('form.titleHint')}</small>
            </label>
            <label className="field">
              <span>{t('form.base')}</span>
              <input className="mono" value={base} onChange={(e) => setBase(e.target.value)} />
              <small className="hint">{t('form.baseHint')}</small>
            </label>
          </div>
          <label className="field">
            <span>{t('form.size')}</span>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value as TaskSize)}
              disabled={custom}
            >
              {(['small', 'medium', 'large'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`form.sizes.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
            <span>{t('form.custom')}</span>
          </label>
          {custom && (
            <div className="row">
              <label className="field">
                <span>{t('form.soft')}</span>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={soft}
                  onChange={(e) => setSoft(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>{t('form.hard')}</span>
                <input
                  type="number"
                  min={2}
                  max={100}
                  value={hard}
                  onChange={(e) => setHard(Number(e.target.value))}
                />
              </label>
            </div>
          )}
          <label className="field">
            <span>{t('form.allow')}</span>
            <textarea
              rows={2}
              className="mono"
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
            />
            <small className="hint">{t('form.allowHint')}</small>
          </label>
          <label className="check">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span>
              {t('form.skip')}
              {skip && <span className="warn-text">⚠ {t('form.skipWarn')}</span>}
            </span>
          </label>
          {mode === 'loop' && (
            <label className="check">
              <input
                type="checkbox"
                checked={confirmPlan}
                onChange={(e) => setConfirmPlan(e.target.checked)}
              />
              <span>
                {t('form.confirmPlan')}
                <small className="hint">{t('form.confirmPlanHint')}</small>
              </span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
            <span>{t('form.queueNow')}</span>
          </label>
        </details>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t(queue ? 'form.create' : 'form.createOnly')}
          </button>
        </div>
      </form>
    </>
  );
}
