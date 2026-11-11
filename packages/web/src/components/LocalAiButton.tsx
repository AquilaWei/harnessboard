// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalAiStatus } from '@harnessboard/shared';

/** Opens the local runner's configuration and latest failure without interrupting work. */
export function LocalAiButton({ status }: { status: LocalAiStatus }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const error = status.lastError;
  const minutes = error ? Math.max(0, Math.floor((Date.now() - error.at) / 60_000)) : 0;
  return (
    <div className="popover-anchor" ref={box}>
      <button
        type="button"
        className={`chip ${status.state === 'missing' ? 'chip-warning' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {t('localAi.title')}: {t(`localAi.${status.state}`)}
        {status.state === 'running' && status.running && (
          <>
            {' '}
            · {status.running.useCase} · {status.running.model}
          </>
        )}
        {status.queued > 0 && <> · {t('localAi.queued', { count: status.queued })}</>}
      </button>
      {open && (
        <div className="popover local-ai-details" role="dialog" aria-label={t('localAi.title')}>
          <h3>{t('localAi.title')}</h3>
          <h4>{t('localAi.models')}</h4>
          <dl>
            {Object.entries(status.models).map(([useCase, model]) => (
              <div key={useCase}>
                <dt>{useCase}</dt>
                <dd>{model}</dd>
              </div>
            ))}
          </dl>
          <p>
            {t('localAi.command')}: <code>{status.command ?? t('localAi.notFound')}</code>
          </p>
          {error && (
            <>
              <h4>{t('localAi.lastError')}</h4>
              <p>
                {error.useCase}: {error.message}
              </p>
              <time dateTime={new Date(error.at).toISOString()}>
                {new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(
                  -minutes,
                  'minute',
                )}
              </time>
            </>
          )}
        </div>
      )}
    </div>
  );
}
