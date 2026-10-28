// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PmWork, StoredEvent, TaskView } from '@harnessboard/shared';
import { Markdown } from './Markdown';
import { LogView } from './LogView';
import { UsageSummary } from './UsageSummary';

type Node = {
  id: string;
  parent: string | null;
  role: 'pm' | 'worker' | 'subagent' | 'secretary';
  agent: string;
  provider: string;
  model: string | null;
  reportedModel: string | null;
  status: string;
  activity: string | null;
  updatedAt: number | null;
  work: PmWork | null;
};

/** Local SVG keeps the team legible at any size without loading bitmap assets. */
function Robot({ role }: { role: Node['role'] }) {
  return (
    <svg className={`agent-robot ${role}`} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M32 14V7m-8 50h-7m30 0h-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="6" r="4" fill="currentColor" />
      <rect x="10" y="17" width="44" height="37" rx="13" fill="currentColor" />
      <rect x="16" y="23" width="32" height="22" rx="9" fill="var(--surface)" />
      <circle cx="25" cy="32" r="3" fill="currentColor" />
      <circle cx="39" cy="32" r="3" fill="currentColor" />
      <path
        d="M28 39q4 4 8 0M6 29v10m52-10v10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {role === 'pm' && <path d="m20 18 2-8 10 5 10-5 2 8" fill="currentColor" />}
      {role === 'subagent' && <path d="m50 5 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="currentColor" />}
    </svg>
  );
}

/** The same persistent tree and selection drive desktop and touch layouts. */
export function AgentTeam({ task, events }: { task: TaskView; events: StoredEvent[] }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const nodes: Node[] = [
    {
      id: 'pm',
      parent: null,
      role: 'pm',
      agent: task.pm?.agentId ?? 'PM',
      provider: task.pmState?.provider ?? task.pm?.agentId ?? '',
      model: task.pm?.model ?? null,
      reportedModel: task.pmState?.model ?? Object.keys(task.pmUsage?.byModel ?? {}).at(-1) ?? null,
      status: task.pmQuestion ? 'awaiting_user' : (task.pmState?.status ?? task.status),
      activity: task.pmState?.activity ?? null,
      updatedAt: task.pmState?.updatedAt ?? null,
      work: null,
    },
    ...(task.secretary
      ? [
          {
            id: task.secretary.id,
            parent: 'pm',
            role: 'secretary' as const,
            agent: task.secretary.agentId,
            provider: task.secretary.provider ?? task.secretary.agentId,
            model: task.secretary.model,
            reportedModel: Object.keys(task.secretary.usage?.byModel ?? {}).at(-1) ?? null,
            status: task.secretary.status,
            activity: task.secretary.summary,
            updatedAt: task.secretary.updatedAt,
            work: null,
          },
        ]
      : []),
    ...(task.work ?? []).map((work): Node => ({
      id: work.id,
      parent: work.parentWorkId ?? 'pm',
      role: work.parentWorkId ? 'subagent' : 'worker',
      agent: work.agentId,
      provider: work.provider ?? work.agentId,
      model: work.model,
      reportedModel: work.reportedModel ?? Object.keys(work.usage?.byModel ?? {}).at(-1) ?? null,
      status: work.reviewStage ? `awaiting_${work.reviewStage}_review` : work.status,
      activity: work.activity ?? null,
      updatedAt: work.updatedAt ?? null,
      work,
    })),
  ];
  const current = nodes.find((node) => node.id === selected);
  const status = (value: string) =>
    t(`team.states.${value}`, { defaultValue: t(`status.${value}`, { defaultValue: value }) });
  const title = (node: Node) => `${t(`team.roles.${node.role}`)} · ${node.agent}`;
  const path = (node: Node): Node[] => {
    const result = [node];
    let parent = nodes.find((n) => n.id === node.parent);
    while (parent && !result.some((n) => n.id === parent!.id)) {
      result.unshift(parent);
      parent = nodes.find((n) => n.id === parent!.parent);
    }
    return result;
  };
  const select = (id: string) => {
    setSelected(id);
    requestAnimationFrame(() => detailHeading.current?.focus());
  };
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const render = (node: Node, depth = 0) => {
    const children = nodes.filter((n) => n.parent === node.id);
    return (
      <li
        key={node.id}
        className="agent-branch"
        style={{ '--agent-depth': Math.min(depth, 3) } as React.CSSProperties}
      >
        <div className="agent-node-wrap">
          <button
            type="button"
            className={`agent-node state-${node.status}`}
            data-agent-id={node.id}
            aria-pressed={selected === node.id}
            onClick={() => select(node.id)}
          >
            <Robot role={node.role} />
            <span className="agent-node-copy">
              <strong>{title(node)}</strong>
              <span className="agent-model">
                {node.reportedModel ?? node.model ?? t('pm.profileDefault')}
              </span>
              <span className="agent-state">{status(node.status)}</span>
              <span className="agent-task">
                {node.activity ?? node.work?.goal ?? t('team.pmDuty')}
              </span>
              {depth > 1 && (
                <small className="agent-parent-label">
                  {t('team.parent')}: {nodes.find((n) => n.id === node.parent)?.agent}
                </small>
              )}
            </span>
          </button>
          {children.length > 0 && (
            <button
              type="button"
              className="agent-collapse"
              aria-expanded={!collapsed.has(node.id)}
              aria-label={`${t(collapsed.has(node.id) ? 'team.expand' : 'team.collapse')} ${title(node)}`}
              onClick={() => toggle(node.id)}
            >
              {collapsed.has(node.id) ? '+' : '−'}
              <small>{children.length}</small>
            </button>
          )}
        </div>
        {children.length > 0 && !collapsed.has(node.id) && (
          <ul className="agent-children">{children.map((child) => render(child, depth + 1))}</ul>
        )}
      </li>
    );
  };
  const sessions =
    current?.role === 'secretary'
      ? task.secretary?.sessionIds
      : current?.work
        ? (current.work.sessionIds ?? [current.work.sessionId])
        : events.filter((e) => e.kind === 'pm_turn').map((e) => e.sessionId);
  const usage =
    current?.role === 'secretary'
      ? task.secretary?.usage
      : (current?.work?.usage ?? (current?.id === 'pm' ? task.pmUsage : undefined));
  return (
    <section
      className={`agent-team ${current ? 'has-selection' : ''}`}
      aria-label={t('tabs.team')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && current) {
          event.preventDefault();
          setSelected(null);
        }
      }}
    >
      <div className="agent-map">
        <div className="agent-map-header">
          <h3>{t('tabs.team')}</h3>
          <span>{t('team.count', { count: nodes.length })}</span>
          <div className="agent-zoom" aria-label={t('team.zoom')}>
            <button
              type="button"
              className="btn"
              aria-label={t('team.zoomOut')}
              onClick={() => setZoom((z) => Math.max(0.05, z - 0.15))}
            >
              −
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const available = viewport.current?.clientWidth ?? 400;
                const width = tree.current?.scrollWidth ?? available;
                setZoom(Math.max(0.05, Math.min(1, (available - 26) / width)));
              }}
            >
              {t('team.fit')}
            </button>
            <button
              type="button"
              className="btn"
              aria-label={t('team.zoomIn')}
              onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}
            >
              +
            </button>
          </div>
        </div>
        <p className="hint">{t('team.hint')}</p>
        <div
          className="agent-viewport"
          ref={viewport}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button') || e.pointerType === 'touch') return;
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              left: e.currentTarget.scrollLeft,
              top: e.currentTarget.scrollTop,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            e.currentTarget.scrollLeft = drag.current.left + drag.current.x - e.clientX;
            e.currentTarget.scrollTop = drag.current.top + drag.current.y - e.clientY;
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <div className="agent-tree" ref={tree} style={{ zoom }}>
            <ul>{render(nodes[0]!)}</ul>
          </div>
        </div>
      </div>
      <div className="agent-inspector">
        {current ? (
          <>
            <button
              type="button"
              className="btn agent-back"
              onClick={() => {
                const id = selected;
                setSelected(null);
                requestAnimationFrame(() =>
                  [
                    ...(viewport.current?.querySelectorAll<HTMLButtonElement>('[data-agent-id]') ??
                      []),
                  ]
                    .find((button) => button.dataset.agentId === id)
                    ?.focus({ preventScroll: true }),
                );
              }}
            >
              {t('team.back')}
            </button>
            <h3 ref={detailHeading} tabIndex={-1}>
              {title(current)}
            </h3>
            <nav className="agent-path" aria-label={t('team.relationship')}>
              {path(current).map((n) => (
                <button className="btn ghost" type="button" key={n.id} onClick={() => select(n.id)}>
                  {title(n)}
                </button>
              ))}
            </nav>
            <dl className="facts">
              <dt>{t('team.status')}</dt>
              <dd>{status(current.status)}</dd>
              <dt>{t('team.provider')}</dt>
              <dd>{current.provider}</dd>
              <dt>{t('team.configuredModel')}</dt>
              <dd>{current.model ?? t('pm.profileDefault')}</dd>
              <dt>{t('team.reportedModels')}</dt>
              <dd>
                {Object.keys(usage?.byModel ?? {}).join(', ') ||
                  current.reportedModel ||
                  t('usage.notRecorded')}
              </dd>
              <dt>{t('team.activity')}</dt>
              <dd>{current.activity ?? t('usage.notRecorded')}</dd>
              <dt>{t('team.updated')}</dt>
              <dd>
                {current.updatedAt
                  ? new Date(current.updatedAt).toLocaleString()
                  : t('usage.notRecorded')}
              </dd>
              <dt>{t('team.access')}</dt>
              <dd>{current.work?.access ?? 'readOnly'}</dd>
            </dl>
            {current.work ? (
              <>
                {current.work.branch && (
                  <dl className="facts">
                    <dt>{t('team.branch')}</dt>
                    <dd>
                      <code>{current.work.branch}</code>
                    </dd>
                    <dt>{t('team.worktree')}</dt>
                    <dd>
                      <code>{current.work.worktreePath}</code>
                    </dd>
                    <dt>{t('team.writePaths')}</dt>
                    <dd>{current.work.writePaths?.join(', ')}</dd>
                    <dt>{t('team.integratedHead')}</dt>
                    <dd>
                      <code>{current.work.integratedHead ?? '—'}</code>
                    </dd>
                  </dl>
                )}
                <h4>{t('team.goal')}</h4>
                <Markdown text={current.work.goal} />
                <h4>{t('team.scope')}</h4>
                <Markdown text={current.work.scope} />
                <h4>{t('team.acceptance')}</h4>
                <Markdown text={current.work.acceptance} />
                {current.work.summary && (
                  <>
                    <h4>{t('team.result')}</h4>
                    <Markdown text={current.work.summary} />
                  </>
                )}
                {current.work.observedHead && (
                  <p>
                    {t('team.observedHead')}: <code>{current.work.observedHead}</code>
                  </p>
                )}
                {current.work.head && (
                  <p>
                    {t('team.head')}: <code>{current.work.head}</code>
                  </p>
                )}
              </>
            ) : (
              <p>{t(current.role === 'secretary' ? 'team.secretaryDuty' : 'team.pmDuty')}</p>
            )}
            {usage ? <UsageSummary usage={usage} /> : <p>{t('usage.notRecorded')}</p>}
            <p className="hint">{t('team.ownUsage')}</p>
            <details>
              <summary>{t('team.events')}</summary>
              <LogView
                events={events.filter((e) => sessions?.includes(e.sessionId))}
                window={task.context?.window ?? 1_000_000}
              />
            </details>
          </>
        ) : (
          <p className="hint">{t('team.select')}</p>
        )}
      </div>
    </section>
  );
}
