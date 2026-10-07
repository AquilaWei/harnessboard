// SPDX-License-Identifier: Apache-2.0
/**
 * Rewriting a committed spec file after the user approved a change to it. The harness does
 * this itself rather than asking an agent, so the criteria in the file are exactly the
 * approved ones and the Revisions entry carries the harness's date.
 */

const CRITERIA_TITLE = /^(#{1,6})\s+acceptance criteria\s*$/i;
const REVISIONS_TITLE = /^(#{1,6})\s+revisions\s*$/i;

/**
 * `content` with the body of its acceptance criteria section replaced by `criteria`, and
 * `- <date>: <summary>` added at the end of its Revisions section. A section the file does
 * not have is appended under a level-2 heading. Only the first heading of each kind counts.
 */
export function reviseSpec(
  content: string,
  criteria: string,
  date: string,
  summary: string,
): string {
  const revised = setSection(content, CRITERIA_TITLE, '## Acceptance criteria', () =>
    criteria.trim().split('\n'),
  );
  return setSection(revised, REVISIONS_TITLE, '## Revisions', (old) => [
    ...old,
    `- ${date}: ${summary}`,
  ]);
}

/**
 * Replaces the lines under the first heading matching `title`, up to the next heading of the
 * same or a higher level, with `body` of the old ones (blank lines around them dropped).
 * Appends `fallback` with `body([])` when there is no such heading.
 */
function setSection(
  content: string,
  title: RegExp,
  fallback: string,
  body: (old: string[]) => string[],
): string {
  const lines = content.trimEnd().split('\n');
  const start = lines.findIndex((line) => title.test(line.trim()));
  if (start < 0) return [...lines, '', fallback, '', ...body([]), ''].join('\n');
  const level = title.exec(lines[start]!.trim())![1]!.length;
  const heading = new RegExp(`^#{1,${level}}\\s`);
  const next = lines.findIndex((line, i) => i > start && heading.test(line));
  const end = next < 0 ? lines.length : next;
  const old = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const after = lines.slice(end);
  return [
    ...lines.slice(0, start + 1),
    '',
    ...body(old ? old.split('\n') : []),
    ...(after.length > 0 ? ['', ...after] : []),
    '',
  ].join('\n');
}
