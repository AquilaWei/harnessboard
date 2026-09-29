// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings, TaskSize } from '@harnessboard/shared';
import { api } from '../api';

interface Props {
  settings: Settings;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

export function SettingsDialog({ settings, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrent);
  const [pausePct, setPausePct] = useState(Math.round(settings.quotaPauseUtilization * 100));
  const [size, setSize] = useState<TaskSize>(settings.defaultContextPolicy.size ?? 'medium');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(
        await api.saveSettings({
          maxConcurrent,
          quotaPauseUtilization: pausePct / 100,
          defaultContextPolicy: { ...settings.defaultContextPolicy, size },
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
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings"
        onSubmit={submit}
      >
        <h2 id="settings">{t('settings')}</h2>
        {error && <div className="error">{error}</div>}
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
