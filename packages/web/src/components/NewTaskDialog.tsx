// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo, PmConfig, Settings, TaskWorkspace } from '@harnessboard/shared';
import { api } from '../api';
import { FolderField } from './FolderField';
import { PmFields } from './PmFields';

const RECENT_KEY = 'harnessboard.recentRepos';
function recentRepos(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
interface Props {
  settings: Settings;
  onClose: () => void;
  onCreated: (id: number) => void;
}

/** New work starts with one PM conversation and an explicit worker model pool. */
export function NewTaskDialog({ settings, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const recent = recentRepos();
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState(recent[0] ?? '');
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const [workspace, setWorkspace] = useState<TaskWorkspace>('worktree');
  const [acceptance, setAcceptance] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [pm, setPm] = useState<PmConfig>({
    agentId: 'claude',
    model: null,
    effort: null,
    workers: [{ agentId: 'claude', models: [null] }],
  });
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
      const task = await api.createTask({
        prompt,
        repo: repo.trim(),
        workflow: 'pm',
        pm,
        title: title.trim() || prompt.split('\n')[0] || '',
        ...(workspace === 'base' ? { workspace } : {}),
        ...(base.trim() ? { baseRef: base.trim() } : {}),
        ...(acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
        size: settings.defaultContextPolicy.size ?? 'medium',
      });
      try {
        localStorage.setItem(
          RECENT_KEY,
          JSON.stringify([repo.trim(), ...recent.filter((r) => r !== repo.trim())].slice(0, 6)),
        );
      } catch {
        /* Recent folders are optional. */
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
        aria-label={t('form.title')}
        onSubmit={(e) => void submit(e)}
      >
        <h2>{t('form.title')}</h2>
        {error && <p className="error">{error}</p>}
        <label className="field">
          <span>{t('form.prompt')}</span>
          <textarea autoFocus required value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <FolderField value={repo} onChange={setRepo} recent={recent} />
        <p className="hint">{t('pm.intro')}</p>
        <PmFields agents={agents} value={pm} onChange={setPm} />
        <details>
          <summary>{t('form.advanced')}</summary>
          <label className="field">
            <span>{t('form.acceptance')}</span>
            <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('form.title')}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('form.base')}</span>
            <input value={base} onChange={(e) => setBase(e.target.value)} />
          </label>
          <fieldset>
            <legend>{t('form.workspace')}</legend>
            {(['worktree', 'base'] as const).map((w) => (
              <label className="check" key={w}>
                <input
                  type="radio"
                  name="workspace"
                  value={w}
                  checked={workspace === w}
                  onChange={() => setWorkspace(w)}
                />
                <strong>
                  {t(`form.workspaces.${w}`, { base: base || t('form.currentBranch') })}
                </strong>
              </label>
            ))}
          </fieldset>
        </details>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button className="btn primary" type="submit" disabled={busy || !pm.workers.length}>
            {t('form.createDiscuss')}
          </button>
        </div>
      </form>
    </>
  );
}
