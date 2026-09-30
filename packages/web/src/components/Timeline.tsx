// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TimelineEntry } from '@harnessboard/shared';
import { formatTokens } from '../live';
import { Markdown } from './Markdown';

/**
 * The task's history as steps, so the harness's decisions are visible: who worked, when
 * context ran out, what verification and review said.
 */
export function Timeline({ entries }: { entries: TimelineEntry[] | null }) {
  const { t } = useTranslation();
  if (!entries) return null;
  if (entries.length === 0) return <p className="empty">{t('timeline.empty')}</p>;
  let seenFeatures = false;
  return (
    <ol className="timeline">
      {entries.map((entry, i) => {
        const first = entry.kind === 'features' && !seenFeatures;
        if (entry.kind === 'features') seenFeatures = true;
        return <Step key={i} entry={entry} firstFeatures={first} />;
      })}
    </ol>
  );
}

function Step({ entry, firstFeatures }: { entry: TimelineEntry; firstFeatures: boolean }) {
  const { t, i18n } = useTranslation();
  const time = new Date(entry.ts).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  });

  switch (entry.kind) {
    case 'session': {
      const s = entry.session;
      const reason = s.endReason ? t(`endReason.${s.endReason}`) : t('timeline.active');
      return (
        <li className={`step step-${s.role}`}>
          <StepHead
            icon={s.role === 'reviewer' ? '🔍' : '🛠'}
            title={t(`timeline.${s.role}`, { agent: s.agentId })}
            meta={`${reason} · ${formatTokens(s.contextTokens)} · ${time}`}
          />
          {entry.summary && (
            <details>
              <summary>{t('timeline.reply')}</summary>
              <Markdown className="reply" text={entry.summary} />
            </details>
          )}
        </li>
      );
    }
    case 'features': {
      const { features, verify, verifiedPassing } = entry.snapshot;
      if (firstFeatures && !verify) {
        return (
          <li className="step">
            <StepHead
              icon="🗂"
              title={t('timeline.planned', { total: features.length })}
              meta={time}
            />
          </li>
        );
      }
      if (!verify) return null;
      const code = verify.timedOut ? t('loop.timedOut') : String(verify.exitCode);
      return (
        <li className={`step ${verify.ok ? 'step-good' : 'step-bad'}`}>
          <StepHead
            icon={verify.ok ? '✓' : '✗'}
            title={
              verify.ok
                ? t('timeline.verifyPassed', { verified: verifiedPassing, total: features.length })
                : t('timeline.verifyFailed', { code })
            }
            meta={`${verify.command} · ${time}`}
          />
          {!verify.ok && verify.output && (
            <details open>
              <summary>{t('timeline.output')}</summary>
              <pre className="reply">{verify.output}</pre>
            </details>
          )}
        </li>
      );
    }
    case 'review_request':
      return (
        <li className="step">
          <StepHead
            icon="→"
            title={t('timeline.reviewRequested', { round: entry.request.round })}
            meta={time}
          />
        </li>
      );
    case 'review': {
      const r = entry.review;
      const key =
        r.verdict === 'approve' ? 'approved' : r.verdict === 'changes' ? 'changes' : 'noVerdict';
      return (
        <li className={`step ${r.verdict === 'approve' ? 'step-good' : 'step-bad'}`}>
          <StepHead
            icon={r.verdict === 'approve' ? '✓' : '!'}
            title={t(`timeline.${key}`, { agent: r.agentId, round: r.round })}
            meta={time}
          />
          {r.findings && (
            <details open={r.verdict !== 'approve'}>
              <summary>{t('timeline.reply')}</summary>
              <Markdown className="reply" text={r.findings} />
            </details>
          )}
        </li>
      );
    }
    case 'handoff':
      return (
        <li className="step">
          <StepHead icon="↻" title={t('timeline.handoff')} meta={time} />
          {entry.note && (
            <details>
              <summary>{t('timeline.note')}</summary>
              <Markdown className="reply" text={entry.note} />
            </details>
          )}
        </li>
      );
  }
}

function StepHead({ icon, title, meta }: { icon: string; title: string; meta: string }) {
  return (
    <div className="step-head">
      <span className="step-icon" aria-hidden>
        {icon}
      </span>
      <span className="step-title">{title}</span>
      <span className="step-meta">{meta}</span>
    </div>
  );
}
