// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_PRESET, PERMISSION_PRESETS, definedOnly, presetRules } from '@harnessboard/shared';
import type { AgentInfo, Settings, TaskMode, TaskSize, TaskWorkspace } from '@harnessboard/shared';
import { api } from '../api';
import { parseRules } from '../rules';
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
  const [discuss, setDiscuss] = useState(true);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [who, setWho] = useState<AgentChoice>({
    implementer: 'claude',
    implementerModel: null,
    implementerEffort: null,
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
  const [presets, setPresets] = useState<string[]>([DEFAULT_PRESET]);
  const [allow, setAllow] = useState('');
  const [skip, setSkip] = useState(false);
  const [autoApprove, setAutoApprove] = useState(true);
  const [queue, setQueue] = useState(true);
  const [confirmPlan, setConfirmPlan] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agents().then(setAgents, (e: Error) => setError(e.message));
  }, []);

  const extra = parseRules(allow);
  const togglePreset = (id: string, on: boolean) =>
    setPresets((current) => (on ? [...current, id] : current.filter((p) => p !== id)));

  /**
   * `undefined` for the untouched default, so the repository's `.harnessboard.json` rules
   * still apply; otherwise the ticked presets plus the extra rules.
   */
  const allowedTools = (): string[] | undefined => {
    const untouched =
      presets.length === 1 && presets[0] === DEFAULT_PRESET && extra.rules.length === 0;
    if (untouched) return undefined;
    const ordered = PERMISSION_PRESETS.map((p) => p.id).filter((id) => presets.includes(id));
    return [...new Set([...presetRules(ordered), ...extra.rules])];
  };

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
          // Criteria given up front are used as they are; blank ones are agreed on first.
          confirmPlan: mode === 'loop' ? confirmPlan : acceptance.trim() ? undefined : discuss,
          implementer: who.implementer,
          implementerModel: who.implementerModel,
          implementerEffort: who.implementerEffort,
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
          allowedTools: allowedTools(),
          skipPermissions: skip || undefined,
          autoApprove,
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

        <label className="field">
          <span>{t('form.acceptance')}</span>
          <textarea
            rows={3}
            value={acceptance}
            placeholder={t('form.acceptancePlaceholder')}
            onChange={(e) => setAcceptance(e.target.value)}
          />
          <small className="hint">
            {t(
              mode === 'loop'
                ? 'form.acceptanceHintLoop'
                : acceptance.trim()
                  ? 'form.acceptanceHintGiven'
                  : discuss
                    ? 'form.acceptanceHint'
                    : 'form.acceptanceHintSkip',
            )}
          </small>
        </label>
        {mode === 'single' && !acceptance.trim() && (
          <label className="check">
            <input
              type="checkbox"
              checked={discuss}
              onChange={(e) => setDiscuss(e.target.checked)}
            />
            <span>{t('form.discuss')}</span>
          </label>
        )}

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
              required={!confirmPlan}
              placeholder={confirmPlan ? t('form.verifyOptional') : 'npm test'}
              onChange={(e) => setVerify(e.target.value)}
            />
            <small className="hint">
              {t(confirmPlan ? 'form.verifyHintPlan' : 'form.verifyHint')}
            </small>
          </label>
        )}

        <fieldset className="presets">
          <legend>{t('form.permissions')}</legend>
          <div className="preset-grid">
            {PERMISSION_PRESETS.map((preset) => (
              <label key={preset.id} className="check">
                <input
                  type="checkbox"
                  checked={presets.includes(preset.id)}
                  onChange={(e) => togglePreset(preset.id, e.target.checked)}
                />
                <span>
                  {t(`presets.${preset.id}.label`)}
                  <small className="hint mono">{preset.rules.join('  ')}</small>
                  {preset.broad && presets.includes(preset.id) && (
                    <span className="warn-text">⚠ {t(`presets.${preset.id}.warn`)}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>{t('form.allow')}</span>
            <textarea
              rows={2}
              className="mono"
              value={allow}
              placeholder="Bash(make *)"
              onChange={(e) => setAllow(e.target.value)}
              aria-invalid={extra.invalid.length > 0}
            />
            {extra.invalid.length > 0 ? (
              <small className="hint warn-text">
                {t('permission.invalid', { rules: extra.invalid.join(', ') })}
              </small>
            ) : (
              <small className="hint">{t('form.allowHint')}</small>
            )}
          </label>
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
          <small className="hint">{t('form.permissionsHint')}</small>
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
          <button type="submit" className="btn primary" disabled={busy || extra.invalid.length > 0}>
            {t(queue ? 'form.create' : 'form.createOnly')}
          </button>
        </div>
      </form>
    </>
  );
}
