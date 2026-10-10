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
