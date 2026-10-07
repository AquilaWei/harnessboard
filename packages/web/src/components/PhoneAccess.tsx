// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Device, PairingCode, PairingSetup } from '@harnessboard/shared';
import { api } from '../api';
import { pairHost, pairUrl, serveCommand } from '../phone';

/** How often the device list is read again while a pairing code is shown. */
const DEVICE_POLL_MS = 3000;

interface Props {
  /** Remote hosts as saved on the server; pairing points the phone at one of these. */
  savedHosts: string[];
  /** Remote hosts in the form, one per line; saved with the rest of the settings. */
  hosts: string;
  onHostsChange: (hosts: string) => void;
  onError: (message: string) => void;
}

/**
 * The "Phone access" settings section: the Tailscale name, the remote hosts, the
 * `tailscale serve` command to copy, pairing by QR code, and the paired devices.
 * It never runs `tailscale serve`; the user does, once.
 */
export function PhoneAccess({ savedHosts, hosts, onHostsChange, onError }: Props) {
  const { t, i18n } = useTranslation();
  const [setup, setSetup] = useState<PairingSetup | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<{ code: PairingCode; url: string; qr: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const loadDevices = useCallback(
    () => api.devices().then(setDevices, (e: Error) => onError(e.message)),
    [onError],
  );
  useEffect(() => {
    api.pairingSetup().then(setSetup, (e: Error) => onError(e.message));
    void loadDevices();
  }, [loadDevices, onError]);
  // The phone pairs on its own; reading the list again shows it here as soon as it has.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => void loadDevices(), DEVICE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pairing, loadDevices]);

  const detected = setup?.tailscaleHost ?? null;
  const formHosts = hosts.split('\n').map((h) => h.trim());
  const host = pairHost(savedHosts, detected);
  const time = (ms: number) =>
    new Date(ms).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' });

  const startPairing = async () => {
    if (!host) return;
    try {
      const code = await api.createPairing();
      const url = pairUrl(host, code.code);
      // Loaded here, not with the board: only the computer that pairs needs it.
      const QRCode = (await import('qrcode')).default;
      setPairing({ code, url, qr: await QRCode.toDataURL(url, { margin: 2, width: 240 }) });
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const revoke = async (id: number) => {
    try {
      await api.revokeDevice(id);
      await loadDevices();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      (e: Error) => onError(e.message),
    );

  return (
    <section className="detail-section">
      <h3>{t('phone.title')}</h3>
      <p className="hint">{t('phone.intro')}</p>
      {setup &&
        (detected ? (
          <p>
            {t('phone.detected')} <span className="mono">{detected}</span>{' '}
            {!formHosts.some((h) => h.toLowerCase() === detected.toLowerCase()) && (
              <button
                type="button"
                className="btn"
                onClick={() => onHostsChange([...formHosts.filter((h) => h), detected].join('\n'))}
              >
                {t('phone.useDetected')}
              </button>
            )}
          </p>
        ) : (
          <p className="hint">{t('phone.notDetected')}</p>
        ))}

      <label className="field">
        <span>{t('phone.hosts')}</span>
        <textarea
          rows={2}
          className="mono"
          value={hosts}
          placeholder="pc.tailnet.ts.net"
          onChange={(e) => onHostsChange(e.target.value)}
        />
        <small className="hint">{t('phone.hostsHint')}</small>
      </label>

      {setup && (
        <p className="serve-command">
          <span className="hint">{t('phone.serveHint')}</span>
          <code className="mono">{serveCommand(setup.port)}</code>
          <button type="button" className="btn" onClick={() => void copy(serveCommand(setup.port))}>
            {copied ? t('phone.copied') : t('phone.copy')}
          </button>
        </p>
      )}

      <p>
        <button type="button" className="btn" disabled={!host} onClick={() => void startPairing()}>
          {pairing ? t('phone.newCode') : t('phone.pair')}
        </button>{' '}
        {!host && <small className="hint">{t('phone.needHost')}</small>}
      </p>
      {pairing && (
        <div className="pairing">
          <img src={pairing.qr} alt={pairing.url} width={240} height={240} />
          <p className="hint">{t('phone.scan', { time: time(pairing.code.expiresAt) })}</p>
          <p className="mono">{pairing.url}</p>
        </div>
      )}

      <h4>{t('phone.devices')}</h4>
      {devices.length === 0 ? (
        <p className="hint">{t('phone.noDevices')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('phone.device')}</th>
              <th>{t('phone.lastSeen')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{time(d.lastSeenAt)}</td>
                <td>
                  <button type="button" className="btn" onClick={() => void revoke(d.id)}>
                    {t('phone.revoke')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
