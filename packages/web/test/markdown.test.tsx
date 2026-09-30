// SPDX-License-Identifier: Apache-2.0
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/components/Markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders bold text and lists', () => {
    expect(html('**Fix** this:\n\n- one\n- two')).toContain(
      '<p><strong>Fix</strong> this:</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>',
    );
  });

  it('shows raw HTML from an agent as text instead of rendering it', () => {
    expect(html('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('drops images so a reply cannot load remote content', () => {
    expect(html('![x](https://example.com/t.png)')).not.toContain('<img');
  });

  it('removes javascript: links', () => {
    expect(html('[x](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('opens links in a new tab without passing the opener', () => {
    expect(html('[docs](https://example.com)')).toContain(
      'href="https://example.com" target="_blank" rel="noopener noreferrer"',
    );
  });
});
