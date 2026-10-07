// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { reviseSpec } from '../src/spec.js';

describe('reviseSpec', () => {
  it('replaces the criteria section and keeps the sections around it', () => {
    const spec =
      '# Spec\n\n## Goal\n\nGreet.\n\n## Acceptance criteria\n\n- prints hi\n\n## Out of scope\n\nColour.\n';
    expect(reviseSpec(spec, '- prints hello', '2026-10-05', 'why')).toBe(
      '# Spec\n\n## Goal\n\nGreet.\n\n## Acceptance criteria\n\n- prints hello\n\n## Out of scope\n\nColour.\n\n## Revisions\n\n- 2026-10-05: why\n',
    );
  });

  it('replaces sub-headings of a deeper level along with the old criteria', () => {
    const spec = '## Acceptance criteria\n\n### CLI\n\n- prints hi\n';
    expect(reviseSpec(spec, '- prints hello', '2026-10-05', 'why')).toBe(
      '## Acceptance criteria\n\n- prints hello\n\n## Revisions\n\n- 2026-10-05: why\n',
    );
  });

  it('adds the entry after the earlier revisions', () => {
    const spec = '## Acceptance criteria\n\n- a\n\n## Revisions\n\n- 2026-10-01: first\n';
    expect(reviseSpec(spec, '- b', '2026-10-05', 'second')).toBe(
      '## Acceptance criteria\n\n- b\n\n## Revisions\n\n- 2026-10-01: first\n- 2026-10-05: second\n',
    );
  });

  it('appends both sections to a spec that has neither', () => {
    expect(reviseSpec('# Spec\n', '- prints hello', '2026-10-05', 'why')).toBe(
      '# Spec\n\n## Acceptance criteria\n\n- prints hello\n\n## Revisions\n\n- 2026-10-05: why\n',
    );
  });

  it('finds the criteria heading at any level and in any case', () => {
    const spec = '# Spec\n\n### ACCEPTANCE CRITERIA\n\n- a\n\n## Design\n\nx\n';
    expect(reviseSpec(spec, '- b', '2026-10-05', 'why')).toBe(
      '# Spec\n\n### ACCEPTANCE CRITERIA\n\n- b\n\n## Design\n\nx\n\n## Revisions\n\n- 2026-10-05: why\n',
    );
  });
});
