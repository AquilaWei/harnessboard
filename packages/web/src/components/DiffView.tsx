// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorktreeDiff } from '@harnessboard/shared';

function lineClass(line: string): string {
  if (line.startsWith('diff --git')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return '';
}

/** Unified diff text with added, removed and header lines coloured. */
export function DiffLines({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => (
        <span key={i} className={lineClass(line)}>
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/**
 * Decodes the C-quoted path that starts at `s[from]` (a `"`). Git quotes paths with
 * tabs, quotes, backslashes or non-ASCII bytes, writing the bytes as `\ooo` octal.
 * Returns the path and the index just past the closing quote.
 */
function readQuoted(s: string, from: number): { path: string; next: number } {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = from + 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] !== '\\') {
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      bytes.push(...encoder.encode(ch));
      i += ch.length;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(s.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 4;
    } else {
      bytes.push(ESCAPES[s[i + 1]!] ?? s.charCodeAt(i + 1));
      i += 2;
    }
  }
  return { path: new TextDecoder().decode(new Uint8Array(bytes)), next: i + 1 };
}

/** A path field from a diff header, quoted or not; drops the tab git adds after paths with spaces. */
function gitPath(field: string): string {
  return field.startsWith('"') ? readQuoted(field, 0).path : field.replace(/\t$/, '');
}

/**
 * The path in `a/<path> b/<path>`. Only used when both sides are the same path
 * (renames and copies are read from their own lines), so an unquoted header splits in half.
 */
function headerPath(rest: string): string {
  if (!rest.startsWith('"')) return rest.slice((rest.length + 5) / 2);
  return gitPath(rest.slice(readQuoted(rest, 0).next + 1)).slice(2);
}

/** The new path of one `diff --git` block, or the old one when the file was deleted. */
function blockPath(block: string): string {
  const lines = block.split('\n');
  const hunk = lines.findIndex((line) => line.startsWith('@@'));
  const header = hunk === -1 ? lines : lines.slice(0, hunk);
  const field = (prefix: string) =>
    header.find((line) => line.startsWith(prefix))?.slice(prefix.length);

  const moved = field('rename to ') ?? field('copy to ');
  if (moved !== undefined) return gitPath(moved);
  const added = field('+++ ');
  if (added !== undefined && added !== '/dev/null') return gitPath(added).slice(2);
  const removed = field('--- ');
  if (removed !== undefined && removed !== '/dev/null') return gitPath(removed).slice(2);
  return headerPath(header[0]!.slice('diff --git '.length));
}

/** The files a unified diff touches, decoding Git's quoted paths; renames give the new path. */
export function diffFiles(text: string): string[] {
  return text
    .split(/^(?=diff --git )/m)
    .filter((block) => block.startsWith('diff --git '))
    .map(blockPath);
}

/** The worktree's changes; "Files only" lists the changed files, which reads better on a phone. */
export function DiffView({ diff }: { diff: WorktreeDiff | null }) {
  const { t } = useTranslation();
  const [filesOnly, setFilesOnly] = useState(false);
  if (!diff) return null;
  if (!diff.diff && diff.untracked.length === 0) return <p className="empty">{t('noDiff')}</p>;
  return (
    <>
      {diff.diff && (
        <div className="actions diff-toolbar">
          <button
            type="button"
            className="btn small"
            aria-pressed={filesOnly}
            onClick={() => setFilesOnly((on) => !on)}
          >
            {t('filesOnly')}
          </button>
        </div>
      )}
      {diff.diff &&
        (filesOnly ? (
          <ul className="mono diff-files">
            {diffFiles(diff.diff).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <DiffLines text={diff.diff} />
        ))}
      {diff.untracked.length > 0 && (
        <>
          <h3>{t('untracked')}</h3>
          <ul className="mono">
            {diff.untracked.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
