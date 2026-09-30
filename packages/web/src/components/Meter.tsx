// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { ContextView, LoopProgress } from '@harnessboard/shared';
import { formatTokens } from '../live';

type Severity = 'normal' | 'warning' | 'critical';

interface BarProps {
  /** 0–100 */
  pct: number;
  severity: Severity;
  ticks?: number[];
  label: string;
}

/** Thin progress track; severity recolours the fill, ticks mark thresholds. */
export function MeterBar({ pct, severity, ticks = [], label }: BarProps) {
  return (
    <div
      className={`meter ${severity === 'normal' ? '' : severity}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <div className="meter-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      {ticks.map((t) => (
        <span key={t} className="meter-tick" style={{ left: `${t}%` }} aria-hidden />
      ))}
    </div>
  );
}

/**
 * Context usage with the task's soft and hard thresholds as ticks. The bar's scale
 * is zoomed so the hard limit sits at 80 % of its width, which keeps small budgets readable.
 */
export function ContextMeter({ context }: { context: ContextView | null }) {
  const { t } = useTranslation();
  if (!context) return <div className="meter-caption">{t('noContext')}</div>;
  const scale = 80 / context.hardPct;
  const severity: Severity =
    context.pct >= context.hardPct
      ? 'critical'
      : context.pct >= context.softPct
        ? 'warning'
        : 'normal';
  return (
    <div>
      <MeterBar
        pct={context.pct * scale}
        severity={severity}
        ticks={[context.softPct * scale, context.hardPct * scale]}
        label={t('context')}
      />
      <div className="meter-caption">
        <span>{t('contextValue', { pct: context.pct, window: formatTokens(context.window) })}</span>
        {severity === 'normal' ? (
          <span>{t('thresholds', { soft: context.softPct, hard: context.hardPct })}</span>
        ) : (
          <span className={`flag ${severity}`}>
            ⚠ {t(severity === 'critical' ? 'overHard' : 'overSoft')}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Loop feature progress: the fill counts only features the harness verified.
 * A failed last verification is flagged in text, not only by colour.
 */
export function FeatureProgress({ loop }: { loop: LoopProgress | null }) {
  const { t } = useTranslation();
  if (!loop) return <div className="meter-caption">{t('loop.planning')}</div>;
  const failed = loop.lastVerify !== null && !loop.lastVerify.ok;
  return (
    <div>
      <MeterBar
        pct={(loop.verified / loop.total) * 100}
        severity={failed ? 'warning' : 'normal'}
        label={t('loop.features')}
      />
      <div className="meter-caption">
        <span>{t('loop.verified', { verified: loop.verified, total: loop.total })}</span>
        {failed && <span className="flag warning">⚠ {t('loop.verifyFailed')}</span>}
      </div>
    </div>
  );
}

/** Quota window utilisation with the pause threshold as a tick. */
export function QuotaMeter(props: {
  label: string;
  utilization: number;
  pauseAt: number;
  resetsAt: number | null;
}) {
  const { t, i18n } = useTranslation();
  const pct = Math.round(props.utilization * 100);
  const pausePct = Math.round(props.pauseAt * 100);
  const severity: Severity =
    pct >= pausePct ? 'critical' : pct >= pausePct - 15 ? 'warning' : 'normal';
  const reset = props.resetsAt
    ? new Date(props.resetsAt).toLocaleTimeString(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  return (
    <div className="stat">
      <div className="stat-label">
        <span>
          {props.label} · <strong>{pct}%</strong>
        </span>
        {reset && <span>{t('resetsAt', { time: reset })}</span>}
      </div>
      <MeterBar pct={pct} severity={severity} ticks={[pausePct]} label={props.label} />
    </div>
  );
}
