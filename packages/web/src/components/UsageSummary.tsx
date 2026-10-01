// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { formatCost, formatDuration } from '@harnessboard/shared';
import type { TaskUsage, TokenCounts } from '@harnessboard/shared';
import { formatTokens } from '../live';

const total = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** One line for the drawer header: tokens · cost · elapsed time. */
export function UsageLine({ usage }: { usage: TaskUsage }) {
  const { t } = useTranslation();
  const parts = [
    usage.tokens ? t('usage.tokensShort', { tokens: formatTokens(total(usage.tokens)) }) : null,
    usage.costUsd !== null ? `~${formatCost(usage.costUsd)}` : null,
    usage.elapsedMs !== null ? formatDuration(usage.elapsedMs) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return <p className="usage-line">{parts.join(' · ')}</p>;
}

/** Tokens, estimated cost and time over all the task's sessions, with a row per model. */
export function UsageSummary({ usage }: { usage: TaskUsage }) {
  const { t } = useTranslation();
  const models = Object.entries(usage.byModel);
  return (
    <section className="detail-section">
      <h3>{t('usage.title')}</h3>
      <dl className="facts">
        <dt>{t('usage.tokens')}</dt>
        <dd>
          {usage.tokens
            ? t('usage.tokenParts', {
                total: formatTokens(total(usage.tokens)),
                input: formatTokens(usage.tokens.input),
                output: formatTokens(usage.tokens.output),
                cacheRead: formatTokens(usage.tokens.cacheRead),
                cacheWrite: formatTokens(usage.tokens.cacheWrite),
              })
            : t('usage.notRecorded')}
        </dd>
        <dt>{t('usage.cost')}</dt>
        <dd>
          {usage.costUsd !== null ? `~${formatCost(usage.costUsd)}` : t('usage.notRecorded')}
          <span className="hint"> {t('usage.costHint')}</span>
        </dd>
        <dt>{t('usage.agentTime')}</dt>
        <dd>
          {usage.runs > 0
            ? t('usage.runs', { time: formatDuration(usage.agentMs), count: usage.runs })
            : t('usage.notRecorded')}
        </dd>
        <dt>{t('usage.elapsed')}</dt>
        <dd>{usage.elapsedMs !== null ? formatDuration(usage.elapsedMs) : '-'}</dd>
      </dl>
      {models.length > 1 && (
        <table className="usage-models">
          <thead>
            <tr>
              <th>{t('usage.model')}</th>
              <th>{t('usage.tokens')}</th>
              <th>{t('usage.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map(([model, m]) => (
              <tr key={model}>
                <td className="mono">{model}</td>
                <td>{formatTokens(total(m))}</td>
                <td>{m.costUsd !== null ? `~${formatCost(m.costUsd)}` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
