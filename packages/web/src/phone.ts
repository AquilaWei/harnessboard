// SPDX-License-Identifier: Apache-2.0

/**
 * The address a phone opens to pair: the board on the remote host, with the code in the hash.
 * A hash is never sent to the server, so the code stays out of proxy and server logs.
 */
export function pairUrl(remoteHost: string, code: string): string {
  return `https://${remoteHost}/#pair=${encodeURIComponent(code)}`;
}

/** The pairing code in a `#pair=<code>` hash, or `null` when the hash holds none. */
export function pairCodeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get('pair');
  return code ? code : null;
}

/** The command that lets the tailnet reach the board; the board never runs it itself. */
export function serveCommand(port: number): string {
  return `tailscale serve --bg ${port}`;
}

/**
 * The host a pairing QR code points at: the Tailscale name when it is one of the saved remote
 * hosts, else the first saved one. `null` when none is saved, because the server refuses a
 * host that is not saved.
 */
export function pairHost(saved: string[], detected: string | null): string | null {
  const match = detected && saved.find((h) => h.toLowerCase() === detected.toLowerCase());
  return match || (saved[0] ?? null);
}
