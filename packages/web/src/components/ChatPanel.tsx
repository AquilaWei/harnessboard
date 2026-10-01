// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatEntry, TaskDetail } from '@harnessboard/shared';
import { api } from '../api';
import { Markdown } from './Markdown';

/** Statuses in which the harness accepts a chat message; see `Harness.chat`. */
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
  const [busy, setBusy] = useState(false);
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
  const canSend = CHATTABLE.includes(task.status) && task.latestSessionId !== null;

  const send = async () => {
    if (!message.trim() || !canSend) return;
    setBusy(true);
    try {
      await api.sendChat(task.id, message.trim());
      setMessage('');
      onSent();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
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
      <div ref={end} />
      <div className="chat-input">
        <textarea
          rows={3}
          value={message}
          disabled={!canSend}
          placeholder={canSend ? t('chat.placeholder') : t('chat.unavailable')}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKey}
          aria-label={t('chat.label')}
        />
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy || !canSend || !message.trim()}
            onClick={() => void send()}
          >
            {t('chat.send')}
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
