// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  name: string;
  start_url: string;
  display: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string }[];
}

const publicDir = new URL('../public/', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('manifest.webmanifest', publicDir), 'utf8'),
) as Manifest;
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// PNG stores the width as a big-endian 32-bit number at byte 16, in the IHDR chunk.
function pngWidth(file: string): number {
  return readFileSync(new URL(file, publicDir)).readUInt32BE(16);
}

describe('manifest.webmanifest', () => {
  it('opens the board standalone from the Home Screen', () => {
    expect(manifest).toMatchObject({
      name: 'Harnessboard',
      start_url: '/',
      display: 'standalone',
      theme_color: '#2a78d6',
    });
  });

  it('names a 192 px and a 512 px PNG icon', () => {
    expect(manifest.icons).toEqual([
      { src: '/icons/192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/512x512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('names only icon files that exist in public/', () => {
    const missing = manifest.icons
      .map((icon) => icon.src)
      .filter((src) => !existsSync(new URL('.' + src, publicDir)));
    expect(missing).toEqual([]);
  });

  it('ships icons whose pixel size matches the size the manifest declares', () => {
    expect(pngWidth('icons/192x192.png')).toBe(192);
    expect(pngWidth('icons/512x512.png')).toBe(512);
  });
});

describe('index.html', () => {
  it('links the manifest', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('sets the same theme colour as the manifest', () => {
    expect(html).toContain('<meta name="theme-color" content="#2a78d6" />');
  });
});
