// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Markdown } from './Markdown';

interface Props {
  taskId: number;
  /** Changes whenever the task does, so a new note shows without reopening the tab. */
  version: number;
  onError: (message: string) => void;
}

/** The task's notes file: what each role reported to the roles after it. */
export function NotesView({ taskId, version, onError }: Props) {
  const { t } = useTranslation();
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    api.notes(taskId).then(
      (notes) => setMarkdown(notes.markdown),
      (e: Error) => onError(e.message),
    );
  }, [taskId, version, onError]);

  return markdown === null ? (
    <p className="hint">{t('notes.empty')}</p>
  ) : (
    <Markdown text={markdown} />
  );
}
