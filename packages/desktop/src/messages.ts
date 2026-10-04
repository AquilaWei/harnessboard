// SPDX-License-Identifier: Apache-2.0
// The few texts the desktop app shows itself; the board has its own translations.

const en = {
  open: 'Open Harnessboard',
  quit: 'Quit Harnessboard',
  starting: 'Starting Harnessboard…',
  portTaken:
    'Another program is using port {port}, so Harnessboard can not start. Close that program, or set HARNESSBOARD_PORT to a free port.',
  failed: 'The Harnessboard server did not start. Its log is at {log}.',
};

const zhTW: typeof en = {
  open: '開啟 Harnessboard',
  quit: '結束 Harnessboard',
  starting: 'Harnessboard 啟動中…',
  portTaken:
    '連接埠 {port} 被其他程式使用，Harnessboard 無法啟動。請關閉那個程式，或把 HARNESSBOARD_PORT 設成沒在使用的連接埠。',
  failed: 'Harnessboard 伺服器沒有啟動，記錄檔在 {log}。',
};

export type Messages = typeof en;

/** Traditional Chinese for zh-TW, zh-HK and zh-Hant locales; English otherwise. */
export function messagesFor(locale: string): Messages {
  return /^zh-(TW|HK|MO|Hant)/i.test(locale) ? zhTW : en;
}

/** Fills `{name}` placeholders. */
export function format(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => String(values[name] ?? all));
}

/** A plain page for the window while the server starts or when it can not. */
export function statusPage(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    '<!doctype html><meta charset="utf-8"><title>Harnessboard</title>' +
    '<body style="font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;' +
    'margin:0;padding:0 24px;color:#ddd;background:#1b1d22;text-align:center">' +
    `<p style="max-width:560px;line-height:1.6">${escaped}</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
