// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Markdown } from './Markdown';
import type { LocalAiStatus } from '@harnessboard/shared';

/** Opens the local runner's configuration and latest failure without interrupting work. */
export function LocalAiButton({ status }: { status: LocalAiStatus }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [failure, setFailure] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const loadModels = () =>
    api
      .localAiModels()
      .then((value) => {
        setModels(value.models);
        setFailure('');
      })
      .catch((error: Error) => setFailure(error.message));
  useEffect(() => {
    if (open) void loadModels();
  }, [open]);
  const ask = async (compact = false) => {
    if (busy || (compact ? !messages.length : !question.trim())) return;
    setBusy(true);
    setFailure('');
    try {
      const history = messages.slice(-12).map((m) => ({ ...m, content: m.content.slice(0, 4000) }));
      while (JSON.stringify(history).length > 16000) history.shift();
      const result = compact
        ? await api.localAiChat('', history, 'compact')
        : await api.localAiChat(question, history);
      if (result.status !== 'ok') throw new Error(result.reason);
      if (!result.answer?.trim()) throw new Error(t('localAi.emptyAnswer'));
      if (compact) {
        setMessages([{ role: 'assistant', content: result.answer.slice(0, 4000) }]);
        return;
      }
      setMessages((current) => [
        ...current,
        { role: 'user', content: question },
        {
          role: 'assistant',
          content: `${result.answer}\n${t('localAi.snapshot')}: ${result.snapshotAt} · ${result.taskIds.map((id) => `#${id}`).join(', ')}`,
        },
      ]);
      setQuestion('');
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
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
        {t('localAi.title')}:{' '}
        {status.selectedModel ?? status.running?.model ?? status.loadedModel ?? 'lfm2.5'} ·{' '}
        {t(`localAi.${status.state}`)}
        {status.running && (
          <>
            {' '}
            · {t(`localAi.${status.running.useCase}`)} · {status.running.model}
          </>
        )}
        {status.queued > 0 && <> · {t('localAi.queued', { count: status.queued })}</>}
      </button>
      {open && (
        <div className="popover local-ai-details" role="dialog" aria-label={t('localAi.title')}>
          <h3>{t('localAi.title')}</h3>
          <label>
            {t('localAi.models')}
            <select
              aria-label={t('localAi.models')}
              value={status.selectedModel ?? ''}
              onChange={(event) => {
                void api
                  .selectLocalAiModel(event.target.value)
                  .catch((error: Error) => setFailure(error.message));
              }}
            >
              <option value="" disabled>
                {t('localAi.legacy')}
              </option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <p>
            {t('localAi.actual')}: {status.loadedModel ?? t('localAi.unloaded')}
          </p>
          <div className="local-ai-conversation" aria-live="polite">
            {messages.map((message, index) => (
              <div key={index}>
                <strong>{t(`localAi.${message.role}`)}</strong>
                {message.role === 'assistant' ? (
                  <Markdown text={message.content} />
                ) : (
                  <p className="local-ai-question">{message.content}</p>
                )}
              </div>
            ))}
          </div>
          <div className="local-ai-actions">
            <button
              type="button"
              disabled={busy || !messages.length}
              onClick={() => {
                setMessages([]);
                setFailure('');
              }}
            >
              {t('localAi.clear')}
            </button>
            <button
              type="button"
              disabled={busy || !messages.length}
              onClick={() => void ask(true)}
            >
              {t('localAi.compact')}
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <textarea
              aria-label={t('localAi.question')}
              placeholder={t('localAi.question')}
              maxLength={4000}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button type="submit" disabled={busy || !question.trim()}>
              {t(busy ? 'localAi.wait' : 'localAi.ask')}
            </button>
          </form>
          {failure && (
            <div role="alert">
              <p>
                {t('localAi.retryHint')}: {failure}
              </p>
              <button
                type="button"
                onClick={() => {
                  void loadModels();
                }}
              >
                {t('localAi.retry')}
              </button>
            </div>
          )}
          <details>
            <summary>{t('localAi.details')}</summary>
            <p>
              {t('localAi.command')}: <code>{status.command ?? t('localAi.notFound')}</code>
            </p>
            <dl>
              {Object.entries(status.models).map(([useCase, model]) => (
                <div key={useCase}>
                  <dt>{t(`localAi.${useCase}`)}</dt>
                  <dd>{model}</dd>
                </div>
              ))}
            </dl>
          </details>
          {error && (
            <>
              <h4>{t('localAi.lastError')}</h4>
              <p>
                {t(`localAi.${error.useCase}`)}: {error.message}
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
