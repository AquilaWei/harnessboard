// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CacheCleanup } from '@harnessboard/shared';
import { api } from '../api';

export function CacheCleanupButton({
  taskId,
  onError,
}: {
  taskId: number;
  onError: (message: string) => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [result, setResult] = useState<CacheCleanup | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(execute: boolean) {
    setBusy(true);
    try {
      setResult(await (execute ? api.cleanup(taskId) : api.previewCleanup(taskId)));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button className="btn" disabled={busy} onClick={() => void run(false)}>
        {zh ? '清理暫存' : 'Clean caches'}
      </button>
      {result && (
        <div role="dialog" aria-label={zh ? '清理暫存預覽' : 'Cache cleanup preview'}>
          <p>
            {zh ? '預估容量' : 'Estimated size'}: {(result.estimatedBytes / 1024 ** 3).toFixed(2)}{' '}
            GiB
          </p>
          <p>
            {zh ? '已清理' : 'Removed'}: {(result.removedBytes / 1024 ** 3).toFixed(2)} GiB
          </p>
          <ul>
            {result.entries.map((entry) => (
              <li key={entry.path}>
                {entry.path}: {entry.bytes.toLocaleString()} bytes — {entry.status}
                {entry.reason && `: ${entry.reason}`}
              </li>
            ))}
          </ul>
          <button
            className="btn"
            disabled={busy || !result.entries.some((e) => e.status === 'candidate')}
            onClick={() => void run(true)}
          >
            {zh ? '執行清理' : 'Remove caches'}
          </button>
          <button className="btn" disabled={busy} onClick={() => setResult(null)}>
            {zh ? '關閉' : 'Close'}
          </button>
        </div>
      )}
    </div>
  );
}
