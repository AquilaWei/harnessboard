// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { definedOnly } from '@harnessboard/shared';
import type { AgentInfo, Settings, TaskMode, TaskSize, TaskWorkspace } from '@harnessboard/shared';
import { api } from '../api';
import { AgentFields } from './AgentFields';
import type { AgentChoice } from './AgentFields';
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
  const [acceptance, setAcceptance] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [who, setWho] = useState<AgentChoice>({
    implementer: 'claude',
    implementerModel: null,
    implementerEffort: null,
    implementerFallback: settings.defaultImplementerFallback,
    reviewer: settings.defaultReviewer,
    reviewerModel: null,
    reviewerEffort: null,
    spec: null,
    specModel: null,
    specEffort: null,
    tester: null,
    testerModel: null,
    testerEffort: null,
    designer: null,
    designerModel: null,
    designerEffort: null,
  });
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const [workspace, setWorkspace] = useState<TaskWorkspace>('worktree');
  const [size, setSize] = useState<TaskSize>(settings.defaultContextPolicy.size ?? 'medium');
  const [custom, setCustom] = useState(false);
  const [soft, setSoft] = useState(40);
  const [hard, setHard] = useState(50);
  const [skip, setSkip] = useState(false);
  const [autoApprove, setAutoApprove] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agents().then(setAgents, (e: Error) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask(
        definedOnly({
          prompt,
          repo: repo.trim(),
          mode,
          verifyCommand: mode === 'loop' ? verify.trim() || undefined : undefined,
          acceptance: acceptance.trim() || undefined,
          // Supplied criteria are draft input; every task still needs explicit approval.
          confirmPlan: true,
          implementer: who.implementer,
          implementerModel: who.implementerModel,
          implementerEffort: who.implementerEffort,
          implementerFallback: who.implementerFallback,
          reviewer: who.reviewer,
          reviewerModel: who.reviewer ? who.reviewerModel : null,
          reviewerEffort: who.reviewer ? who.reviewerEffort : null,
          spec: who.spec,
          specModel: who.spec ? who.specModel : null,
          specEffort: who.spec ? who.specEffort : null,
          tester: who.tester,
          testerModel: who.tester ? who.testerModel : null,
          testerEffort: who.tester ? who.testerEffort : null,
          designer: who.designer,
          designerModel: who.designer ? who.designerModel : null,
          designerEffort: who.designer ? who.designerEffort : null,
          title: title.trim() || undefined,
          baseRef: base.trim() || undefined,
          workspace: workspace === 'base' ? workspace : undefined,
          size,
          softPct: custom ? soft : undefined,
          hardPct: custom ? hard : undefined,
          skipPermissions: skip || undefined,
          autoApprove,
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

        <label className="field">
          <span>{t('form.acceptance')}</span>
          <textarea
            rows={3}
            value={acceptance}
            placeholder={t('form.acceptancePlaceholder')}
            onChange={(e) => setAcceptance(e.target.value)}
          />
          <small className="hint">
            {t(mode === 'loop' ? 'form.acceptanceHintLoop' : 'form.acceptanceHint')}
          </small>
        </label>

        <FolderField value={repo} onChange={setRepo} recent={recent} />

        <fieldset className="choice-cards">
          <legend>{t('form.workspace')}</legend>
          {(['worktree', 'base'] as const).map((w) => (
            <label key={w} className={`choice ${workspace === w ? 'selected' : ''}`}>
              <input
                type="radio"
                name="workspace"
                value={w}
                checked={workspace === w}
                onChange={() => setWorkspace(w)}
              />
              <strong>
                {t(`form.workspaces.${w}`, { base: base.trim() || t('form.currentBranch') })}
              </strong>
              <small>{t(`form.workspaceHints.${w}`)}</small>
            </label>
          ))}
        </fieldset>

        {mode === 'loop' && (
          <label className="field">
            <span>{t('form.verify')}</span>
            <input
              className="mono"
              value={verify}

              placeholder={t('form.verifyOptional')}
              onChange={(e) => setVerify(e.target.value)}
            />
            <small className="hint">{t('form.verifyHintPlan')}</small>
          </label>
        )}

        <fieldset className="presets">
          <legend>{t('form.permissions')}</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            <span>
              {t('form.autoApprove')}
              <small className="hint">{t('form.autoApproveHint')}</small>
            </span>
          </label>
        </fieldset>

        <AgentFields agents={agents} value={who} onChange={setWho} />

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
          <label className="check">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span>
              {t('form.skip')}
              {skip && <span className="warn-text">⚠ {t('form.skipWarn')}</span>}
            </span>
          </label>
        </details>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('form.createDiscuss')}
          </button>
        </div>
      </form>
    </>
  );
}
