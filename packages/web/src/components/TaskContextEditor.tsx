// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveThresholds, type TaskDetail } from '@harnessboard/shared';
import { api } from '../api';

/** Saves the task budget without restarting its workflow or discarding its conversation. */
export function TaskContextEditor({
  task,
  onSaved,
  onError,
}: {
  task: TaskDetail;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [soft, setSoft] = useState(40);
  const [hard, setHard] = useState(50);
  const [compact, setCompact] = useState(30);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const value = resolveThresholds(task.contextPolicy);
    setSoft(value.softPct);
    setHard(value.hardPct);
    setCompact(value.compactPct ?? 0);
  }, [task.contextPolicy]);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await api.setTaskContext(task.id, {
            size: task.contextPolicy.size ?? 'medium',
            softPct: soft,
            hardPct: hard,
            compactPct: compact,
          });
          onSaved();
        } catch (error) {
          onError((error as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        {t('form.soft')}
        <input
          type="number"
          min={1}
          max={99}
          required
          value={soft}
          onChange={(e) => setSoft(e.target.valueAsNumber)}
        />
      </label>
      <label>
        {t('form.hard')}
        <input
          type="number"
          min={2}
          max={100}
          required
          value={hard}
          onChange={(e) => setHard(e.target.valueAsNumber)}
        />
      </label>
      <label>
        {t('form.taskCompact')}
        <input
          type="number"
          min={0}
          max={99}
          required
          value={compact}
          onChange={(e) => setCompact(e.target.valueAsNumber)}
        />
      </label>
      <p>{t('form.contextUpdateHint')}</p>
      <button type="submit" disabled={saving}>
        {t('form.contextSave')}
      </button>
    </form>
  );
}
