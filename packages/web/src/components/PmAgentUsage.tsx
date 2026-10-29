// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { formatCost, formatDuration } from '@harnessboard/shared';
import type { TaskUsage, TaskView } from '@harnessboard/shared';
import { formatTokens } from '../live';
import { Markdown } from './Markdown';

/** PM totals and individual delegated jobs share a compact, comparable usage table. */
export function PmAgentUsage({ task }: { task: TaskView }) {
  const { t } = useTranslation();
  const rows = [
    {
      id: 'pm',
      agentId: task.pm?.agentId,
      model: task.pm?.model,
      usage: task.pmUsage,
      status: task.status,
      work: null,
    },
    ...(task.work ?? []).map((work) => ({ ...work, work })),
  ];
  const tokens = (usage?: TaskUsage) => {
    const counts = usage?.tokens;
    return counts
      ? formatTokens(counts.input + counts.output + counts.cacheRead + counts.cacheWrite)
      : t('usage.notRecorded');
  };
  return (
    <div className="agent-usage-scroll">
      <table className="usage-models agent-usage">
        <thead>
          <tr>
            {['agent', 'status', 'tokens', 'cost', 'agentTime'].map((key) => (
              <th key={key} scope="col">
                {t(`usage.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, agentId, model, status, usage, work }) => (
            <tr key={id}>
              <td>
                {work ? agentId : `PM · ${agentId ?? '-'}`}
                <small className="agent-usage-secondary">
                  {Object.keys(usage?.byModel ?? {}).join(', ') || model || t('pm.profileDefault')}
                </small>
                {work && (
                  <details>
                    <summary>{t('usage.details')}</summary>
                    <p>{work.goal}</p>
                    <p>{work.scope}</p>
                    {work.summary && <Markdown text={work.summary} />}
                    {work.evidence && (
                      <a
                        href={`/api/tasks/${task.id}/work/${work.id}/report`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('team.fullReport')}
                      </a>
                    )}
                    {work.head && <small className="mono">{work.head}</small>}
                  </details>
                )}
              </td>
              <td>
                {t(
                  status === 'completed' || status === 'cancelled'
                    ? `usage.${status}`
                    : `status.${status}`,
                )}
              </td>
              <td>{tokens(usage)}</td>
              <td>
                {usage?.costUsd != null ? `~${formatCost(usage.costUsd)}` : t('usage.notRecorded')}
              </td>
              <td>
                {usage && usage.runs > 0 ? (
                  <>
                    {formatDuration(usage.agentMs)}
                    <small className="agent-usage-secondary">
                      {t('usage.runCount', { count: usage.runs })}
                    </small>
                  </>
                ) : (
                  t('usage.notRecorded')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
