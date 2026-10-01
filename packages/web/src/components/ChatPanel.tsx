// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatEntry, TaskDetail } from '@harnessboard/shared';
import { api } from '../api';
import { Markdown } from './Markdown';

/**
 * Statuses in which a message is sent at once; in any other the harness keeps it pending
 * until the task's current step ends. See `Harness.chat`.
 */
const CHATTABLE = ['stopped', 'failed', 'review', 'done'];

interface Props {
  task: TaskDetail;
  onSent: () => void;
  onError: (message: string) => void;
}

/**
 * Talk to the task's agent in its own conversation, as in a terminal: each message resumes
 * the latest session, which may edit files under the task's tool rules. Workflow sessions
 * are not shown here; they are on the timeline and in the log.
 */
export function ChatPanel({ task, onSent, onError }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ChatEntry[] | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // Read again whenever the task changes; live events update `updatedAt` while it replies.
  useEffect(() => {
    api.chat(task.id).then(setEntries, (e: Error) => onError(e.message));
  }, [task.id, task.updatedAt, task.status, onError]);

  // A block body: scrollIntoView may return a promise, which React would take for a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries?.length]);

  const replying = task.status === 'running' || task.status === 'awaiting_permission';
  const busy = !CHATTABLE.includes(task.status);
  const canSend = busy || task.latestSessionId !== null;
  const hasPending = entries?.some((e) => e.kind === 'pending') ?? false;

  const send = async () => {
    if (!message.trim() || !canSend) return;
    setSending(true);
    try {
      await api.sendChat(task.id, message.trim());
      setMessage('');
      onSent();
      // A pending message does not change the task, so read the chat again here.
      setEntries(await api.chat(task.id));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancelPending = async () => {
    try {
      await api.cancelChat(task.id);
      setEntries(await api.chat(task.id));
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const copyOpen = async () => {
    try {
      await navigator.clipboard.writeText(`hb open ${task.id}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onError(`hb open ${task.id}`);
    }
  };

  return (
    <div className="chat">
      {entries?.length === 0 && <p className="hint">{t('chat.empty')}</p>}
      <ol className="chat-log">
        {entries?.map((entry, i) => (
          <ChatLine key={i} entry={entry} />
        ))}
      </ol>
      {replying && task.activity?.phase === 'chatting' && (
        <p className="hint">{t('chat.replying', { agent: task.activity.agentId ?? '' })}</p>
      )}
      {hasPending && (
        <div className="actions">
          <span className="hint">{t('chat.pendingHint')}</span>
          <button type="button" className="btn ghost" onClick={() => void cancelPending()}>
            {t('chat.cancelPending')}
          </button>
        </div>
      )}
      <div ref={end} />
      <div className="chat-input">
        <textarea
          rows={3}
          value={message}
          disabled={!canSend}
          placeholder={
            !canSend
              ? t('chat.unavailable')
              : busy
                ? t('chat.queuePlaceholder')
                : t('chat.placeholder')
          }
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKey}
          aria-label={t('chat.label')}
        />
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={sending || !canSend || !message.trim()}
            onClick={() => void send()}
          >
            {busy ? t('chat.queue') : t('chat.send')}
          </button>
          <span className="hint">{t('chat.hint')}</span>
          <button type="button" className="btn ghost" onClick={() => void copyOpen()}>
            {copied ? t('actions.copied') : t('actions.copyOpen')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatLine({ entry }: { entry: ChatEntry }) {
  const { t } = useTranslation();
  switch (entry.kind) {
    case 'user':
      return (
        <li className="chat-user">
          <div className="chat-bubble">{entry.text}</div>
        </li>
      );
    case 'pending':
      return (
        <li className="chat-user chat-pending">
          <div className="chat-bubble">{entry.text}</div>
          <span className="chat-tag">{t('chat.pending')}</span>
        </li>
      );
    case 'dropped':
      return (
        <li className="chat-user chat-pending">
          <div className="chat-bubble chat-dropped">{entry.text}</div>
          <span className="chat-tag">
            {entry.cleared.reason === 'cancelled'
              ? t('chat.cancelled')
              : t('chat.undeliverable', { detail: entry.cleared.detail ?? '' })}
          </span>
        </li>
      );
    case 'agent':
      return (
        <li className="chat-agent">
          <Markdown className="chat-bubble" text={entry.text} />
        </li>
      );
    case 'tool':
      return (
        <li className="chat-tool mono">
          ⚙ {entry.name} {entry.summary}
        </li>
      );
    case 'compact':
      return (
        <li className="chat-tool">
          {t('chat.compacted', { pre: entry.preTokens, post: entry.postTokens })}
        </li>
      );
    case 'end':
      return entry.reason === 'completed' ? null : (
        <li className="chat-tool">{t('chat.ended', { reason: entry.reason })}</li>
      );
  }
}
