// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSION_PRESETS } from '@harnessboard/shared';
import type { TaskView } from '@harnessboard/shared';
import { api } from '../api';
import { parseRules } from '../rules';

interface Props {
  task: TaskView;
  onSaved: () => void;
  onError: (message: string) => void;
}

/**
 * A task's allowed tools. They can be changed while no session runs, e.g. after tool uses
 * were refused; the next session gets the new list.
 */
export function ToolRules({ task, onSaved, onError }: Props) {
  const { t } = useTranslation();
  const rules = task.permission.allowedTools;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = parseRules(text);
  const live = task.status === 'running' || task.status === 'awaiting_permission';

  const startEditing = () => {
    setText(rules.join('\n'));
    setEditing(true);
  };

  // Appends a preset's missing rules, so the list stays editable text.
  const addPreset = (presetRules: string[]) => {
    const missing = presetRules.filter((rule) => !parsed.rules.includes(rule));
    setText((current) => [current.trim(), ...missing].filter(Boolean).join('\n'));
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setAllowedTools(task.id, parsed.rules);
      setEditing(false);
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (on: boolean) => {
    try {
      await api.setAutoApprove(task.id, on);
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  // Read at each request, so it can change while the task runs.
  const autoToggle = (
    <label className="check">
      <input
        type="checkbox"
        checked={task.permission.autoApprove === true}
        onChange={(e) => void toggleAuto(e.target.checked)}
      />
      <span>
        {t('form.autoApprove')}
        <small className="hint">{t('form.autoApproveHint')}</small>
      </span>
    </label>
  );

  if (!editing) {
    return (
      <div className="tool-rules">
        {autoToggle}
        {rules.length > 0 ? (
          <ul className="rule-list mono">
            {rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        ) : (
          <span>{t('fields.none')}</span>
        )}
        {!live && (
          <button type="button" className="btn small" onClick={startEditing}>
            {t('rules.edit')}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="tool-rules">
      <div className="preset-chips">
        {PERMISSION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="chip"
            title={preset.rules.join('\n')}
            onClick={() => addPreset(preset.rules)}
          >
            + {t(`presets.${preset.id}.label`)}
          </button>
        ))}
      </div>
      <textarea
        className="mono"
        rows={Math.min(12, Math.max(3, parsed.rules.length + parsed.invalid.length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={parsed.invalid.length > 0}
      />
      {parsed.invalid.length > 0 ? (
        <small className="hint warn-text">
          {t('permission.invalid', { rules: parsed.invalid.join(', ') })}
        </small>
      ) : (
        <small className="hint">{t('rules.hint')}</small>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || parsed.invalid.length > 0}
          onClick={() => void save()}
        >
          {t('rules.save')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>
          {t('rules.cancel')}
        </button>
      </div>
    </div>
  );
}
