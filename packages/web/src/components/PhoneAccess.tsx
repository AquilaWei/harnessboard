// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Device, PairingCreated, PairingSetup } from '@harnessboard/shared';
import { api } from '../api';
import { pairUrl } from '../phone';

/** How often the device list is read again while a pairing code is shown. */
const DEVICE_POLL_MS = 3000;

interface Props {
  onError: (message: string) => void;
}

/**
 * The "Phone access" settings section: pairing by QR code and the paired devices. Starting a
 * pairing also has the server make the board reachable on the tailnet.
 */
export function PhoneAccess({ onError }: Props) {
  const { t, i18n } = useTranslation();
  const [setup, setSetup] = useState<PairingSetup | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<{ code: PairingCreated; url: string; qr: string } | null>(
    null,
  );

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

  // While Tailscale is not up, read its state again so the page notices once it is.
  const waiting = setup !== null && setup.tailscale !== 'running';
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(
      () => void api.pairingSetup().then(setSetup, () => undefined),
      DEVICE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [waiting]);

  const detected = setup?.tailscaleHost ?? null;
  const startable =
    setup !== null &&
    (setup.tailscale === 'needs-login' ||
      (setup.tailscale === 'stopped' && setup.canStartTailscale));

  const startTailscale = async () => {
    setStarting(true);
    try {
      const started = await api.startTailscale();
      setLoginUrl(started.loginUrl ?? null);
      setSetup(await api.pairingSetup());
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const time = (ms: number) =>
    new Date(ms).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' });

  const startPairing = async () => {
    try {
      const code = await api.createPairing();
      const url = pairUrl(code.host, code.code);
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

  return (
    <section className="detail-section">
      <h3>{t('phone.title')}</h3>
      <p className="hint">{t('phone.intro')}</p>
      {setup && !detected && <p className="hint">{t(`phone.tailscale.${setup.tailscale}`)}</p>}
      {startable && (
        <p>
          <button
            type="button"
            className="btn"
            disabled={starting}
            onClick={() => void startTailscale()}
          >
            {t('phone.startTailscale')}
          </button>
        </p>
      )}
      {loginUrl && !detected && (
        <p className="hint">
          {t('phone.tailscaleLogin')}{' '}
          <a href={loginUrl} target="_blank" rel="noreferrer">
            {loginUrl}
          </a>
        </p>
      )}

      <p>
        <button
          type="button"
          className="btn"
          disabled={!detected}
          onClick={() => void startPairing()}
        >
          {pairing ? t('phone.newCode') : t('phone.pair')}
        </button>
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
