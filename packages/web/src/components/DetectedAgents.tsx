// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DetectedAgent } from '@harnessboard/shared';
import { api } from '../api';

interface Props {
  /** Called after a profile was added, so the caller can reload the profile list. */
  onAdded: () => void;
  onError: (message: string) => void;
}

/** Agent CLIs found on this machine with no profile yet, each with a button to add one. */
export function DetectedAgents({ onAdded, onError }: Props) {
  const { t } = useTranslation();
  const [detected, setDetected] = useState<DetectedAgent[]>([]);
  const [ids, setIds] = useState<Record<string, string>>({});

  useEffect(() => {
    api.detectAgents().then(setDetected, (e: Error) => onError(e.message));
  }, [onError]);

  const add = async (agent: DetectedAgent) => {
    try {
      const id = ids[agent.provider] ?? agent.command;
      await api.addAgent({ id, provider: agent.provider, command: agent.command, model: null });
      onAdded();
      setDetected(await api.detectAgents());
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const unconfigured = detected.filter((d) => d.profileId === null);
  if (unconfigured.length === 0) return null;
  return (
    <>
      <h4>{t('settingsForm.detected')}</h4>
      <table>
        <tbody>
          {unconfigured.map((d) => (
            <tr key={d.provider}>
              <td>
                <input
                  className="mono"
                  aria-label={t('settingsForm.profileId')}
                  value={ids[d.provider] ?? d.command}
                  onChange={(e) => setIds({ ...ids, [d.provider]: e.target.value })}
                />
              </td>
              <td className="mono">{d.provider}</td>
              <td className="mono">{d.version}</td>
              <td>
                <button type="button" className="btn" onClick={() => void add(d)}>
                  {t('settingsForm.addAgent')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{t('settingsForm.detectedHint')}</p>
    </>
  );
}
