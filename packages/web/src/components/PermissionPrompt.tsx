// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionDecision, PermissionRequest } from '@harnessboard/shared';
import { api } from '../api';
import { parseRules } from '../rules';

interface Props {
  taskId: number;
  requests: PermissionRequest[];
  onAnswered: () => void;
  onError: (message: string) => void;
}

/** The tool uses the agent waits on, each with allow once, allow and remember, or deny. */
export function PermissionPrompt({ taskId, requests, onAnswered, onError }: Props) {
  return (
    <div className="permission-list">
      {requests.map((request) => (
        <Request
          key={request.requestId}
          taskId={taskId}
          request={request}
          onAnswered={onAnswered}
          onError={onError}
        />
      ))}
    </div>
  );
}

function Request({
  taskId,
  request,
  onAnswered,
  onError,
}: {
  taskId: number;
  request: PermissionRequest;
  onAnswered: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [rulesText, setRulesText] = useState(request.suggestedRules.join('\n'));
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { rules, invalid } = parseRules(rulesText);

  const answer = async (decision: Omit<PermissionDecision, 'requestId'>) => {
    setBusy(true);
    try {
      await api.answerPermission(taskId, { requestId: request.requestId, ...decision });
      onAnswered();
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="permission" aria-label={t('permission.title', { tool: request.toolName })}>
      <div className="permission-head">
        <strong>{t('permission.title', { tool: request.toolName })}</strong>
      </div>
      <pre className="permission-command">{request.summary || request.toolName}</pre>
      <label className="field">
        <span>{t('permission.rules')}</span>
        <textarea
          rows={Math.max(1, rules.length + invalid.length)}
          className="mono"
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          aria-invalid={invalid.length > 0}
        />
        {invalid.length > 0 ? (
          <small className="hint warn-text">
            {t('permission.invalid', { rules: invalid.join(', ') })}
          </small>
        ) : (
          <small className="hint">{t('permission.rulesHint')}</small>
        )}
      </label>
      {denying && (
        <label className="field">
          <span>{t('permission.reason')}</span>
          <input
            value={reason}
            placeholder={t('permission.reasonHint')}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </label>
      )}
      <div className="actions">
        {denying ? (
          <>
            <button
              type="button"
              className="btn danger-fill"
              disabled={busy}
              onClick={() =>
                void answer({ behavior: 'deny', ...(reason.trim() ? { message: reason } : {}) })
              }
            >
              {t('permission.confirmDeny')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setDenying(false)}>
              {t('permission.cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={busy || rules.length === 0 || invalid.length > 0}
              onClick={() => void answer({ behavior: 'allow', rules })}
            >
              {t('permission.allowRemember')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void answer({ behavior: 'allow' })}
            >
              {t('permission.allowOnce')}
            </button>
            <button
              type="button"
              className="btn ghost danger"
              disabled={busy}
              onClick={() => setDenying(true)}
            >
              {t('permission.deny')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
