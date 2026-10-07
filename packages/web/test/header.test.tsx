// SPDX-License-Identifier: Apache-2.0
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Header } from '../src/components/Header';

const html = (version: string | null) =>
  renderToStaticMarkup(
    <Header
      running={0}
      attention={0}
      status={null}
      settings={null}
      version={version}
      onNewTask={() => {}}
      onSettings={() => {}}
      onAttention={() => {}}
    />,
  );

describe('Header', () => {
  it('shows the server version next to the name', () => {
    expect(html('0.0.21')).toContain(
      '<span>Harnessboard</span><span class="version">v0.0.21</span>',
    );
  });

  it('shows no version before it is known', () => {
    expect(html(null)).not.toContain('class="version"');
  });
});
