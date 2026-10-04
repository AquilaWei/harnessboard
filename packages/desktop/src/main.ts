// SPDX-License-Identifier: Apache-2.0
// Electron main process: starts the local server (or uses one already running), shows the
// board in a window, and keeps running in the tray when the window is closed, so tasks go on.
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, Tray, app, shell, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { loadConfig } from '@harnessboard/core';
import { format, messagesFor, statusPage } from './messages.js';
import { probePort, stopServer, waitForServer } from './server.js';
import { loginShellPath, mergePaths } from './shell-path.js';
// The version lives in the server's package.json only; the desktop build copies it from there.
import pkg from 'harnessboard/package.json' with { type: 'json' };

const SHELL_PATH_TIMEOUT_MS = 5000;

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: { child: UtilityProcess; exited: Promise<number> } | null = null;
let quitting = false;

// A second launch (from the menu, or a launcher while the window is hidden) shows this one.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow()); // macOS: clicking the Dock icon
// The app stays in the tray; only Quit ends it.
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  quitting = true;
  if (!server) return;
  // Agents must be stopped and the database closed before the app goes away.
  event.preventDefault();
  const running = server;
  server = null;
  void stopServer(running.child, running.exited).finally(() => app.quit());
});

// Being told to stop (a terminal's Ctrl+C, logout) goes through Quit, so the server stops cleanly.
process.once('SIGTERM', () => app.quit());
process.once('SIGINT', () => app.quit());

void app.whenReady().then(start);

async function start(): Promise<void> {
  const text = messagesFor(app.getLocale());
  await useLoginShellPath();
  const config = loadConfig();
  const url = `http://127.0.0.1:${config.port}`;
  createTray(text.open, text.quit);
  createWindow(statusPage(text.starting));

  const state = await probePort(url);
  if (state === 'other') return show(statusPage(format(text.portTaken, { port: config.port })));
  if (state === 'free') {
    const log = path.join(config.dataDir, 'logs', 'desktop-server.log');
    server = startServer(log);
    if (!(await waitForServer(url, server.exited))) {
      return show(statusPage(format(text.failed, { log })));
    }
  }
  show(url);
}

/** Agent CLIs and git are found the way they are in the user's terminal. */
async function useLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return; // Windows apps get the user's PATH already
  const shellPath = await loginShellPath(process.env.SHELL ?? '/bin/sh', SHELL_PATH_TIMEOUT_MS);
  if (shellPath) process.env.PATH = mergePaths(shellPath, process.env.PATH ?? '', path.delimiter);
}

/** Runs the bundled server in Electron's own Node; its output goes to `log`. */
function startServer(log: string): { child: UtilityProcess; exited: Promise<number> } {
  mkdirSync(path.dirname(log), { recursive: true });
  const out = createWriteStream(log, { flags: 'a' });
  out.write(`\n--- ${new Date().toISOString()} Harnessboard ${pkg.version} ---\n`);
  const child = utilityProcess.fork(path.join(import.meta.dirname, 'server.mjs'), [], {
    stdio: 'pipe',
    env: process.env,
    serviceName: 'Harnessboard server',
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  const exited = new Promise<number>((resolve) => child.once('exit', resolve));
  void exited.then((code) => {
    out.write(`--- server exited with code ${code} ---\n`);
    // A server that stops on its own leaves the board without data; end the app with it.
    if (!quitting) {
      server = null;
      app.quit();
    }
  });
  return { child, exited };
}

function createWindow(first: string): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Harnessboard',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  // Links to anything but the board (docs, GitHub) open in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  void window.loadURL(first);
}

function show(url: string): void {
  void window?.loadURL(url);
  showWindow();
}

function showWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray(openLabel: string, quitLabel: string): void {
  tray = new Tray(iconPath('tray.png'));
  tray.setToolTip(`Harnessboard ${pkg.version}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: openLabel, click: () => showWindow() },
      { label: `v${pkg.version}`, enabled: false },
      { type: 'separator' },
      { label: quitLabel, click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showWindow());
}

/** Icons ship in assets/, next to dist/ in the app. */
function iconPath(name: string): string {
  return path.join(import.meta.dirname, '..', 'assets', name);
}
