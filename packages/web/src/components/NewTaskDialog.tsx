// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { definedOnly } from '@harnessboard/shared';
import type { TaskMode, TaskSize } from '@harnessboard/shared';
import { api } from '../api';

const REPO_KEY = 'harnessboard.lastRepo';

function lastRepo(): string {
  try {
    return localStorage.getItem(REPO_KEY) ?? '';
  } catch {
    return '';
  }
}

interface Props {
  defaultSize: TaskSize;
  onClose: () => void;
  onCreated: (id: number) => void;
}

export function NewTaskDialog({ defaultSize, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TaskMode>('single');
  const [verify, setVerify] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState(lastRepo);
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const [size, setSize] = useState<TaskSize>(defaultSize);
  const [custom, setCustom] = useState(false);
  const [soft, setSoft] = useState(40);
  const [hard, setHard] = useState(50);
  const [allow, setAllow] = useState('');
  const [skip, setSkip] = useState(false);
  const [queue, setQueue] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          mode,
          verifyCommand: mode === 'loop' ? verify.trim() || undefined : undefined,
          repo: repo.trim(),
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
      try {
        localStorage.setItem(REPO_KEY, repo.trim());
      } catch {
        // only a convenience for the next task
      }
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
        <fieldset className="segmented">
          <legend>{t('form.mode')}</legend>
          {(['single', 'loop'] as const).map((m) => (
            <label key={m} className="check">
              <input
                type="radio"
                name="mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>{t(`form.modes.${m}`)}</span>
            </label>
          ))}
          {mode === 'loop' && <small className="hint">{t('form.modeHint')}</small>}
        </fieldset>
        <label className="field">
          <span>{t(mode === 'loop' ? 'form.goal' : 'form.prompt')}</span>
          <textarea
            required
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span>{t('form.repo')}</span>
          <input required className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <small className="hint">{t('form.repoHint')}</small>
        </label>
        {mode === 'loop' && (
          <label className="field">
            <span>{t('form.verify')}</span>
            <input
              className="mono"
              value={verify}
              placeholder="npm test"
              onChange={(e) => setVerify(e.target.value)}
            />
            <small className="hint">{t('form.verifyHint')}</small>
          </label>
        )}
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
            {skip && <div className="warn-text">⚠ {t('form.skipWarn')}</div>}
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
          <span>{t('form.queueNow')}</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('form.create')}
          </button>
        </div>
      </form>
    </>
  );
}
