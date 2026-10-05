// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { resetNotifications } from '../notify';
import { checkPasskey, passkeysAvailable, registerPasskey } from '../passkey';

interface Props {
  /** The code from the `#pair=<code>` address the computer showed as a QR code. */
  code: string;
  onPaired: () => void;
}

/**
 * Shown on a phone that opened a pairing address: names the device, pairs it, then creates its
 * passkey. The device counts as paired only after the passkey; if that step fails the screen
 * stays and retries it alone, since the code is used up.
 */
export function PairScreen({ code, onPaired }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!paired) {
        await api.pair({ code, name: name.trim() });
        resetNotifications(); // a new device has no push subscription on the board yet
        setPaired(true);
      }
      await registerPasskey();
      onPaired();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!passkeysAvailable()) return <NoPasskeys title={t('phone.pairTitle')} />;
  return (
    <form className="gate" onSubmit={submit}>
      <h2>{t('phone.pairTitle')}</h2>
      <p className="hint">{t(paired ? 'phone.passkeyIntro' : 'phone.pairIntro')}</p>
      {error && <div className="error">{error}</div>}
      {!paired && (
        <label className="field">
          <span>{t('phone.deviceName')}</span>
          <input
            value={name}
            maxLength={64}
            placeholder="Pixel 9"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <button type="submit" className="btn primary" disabled={busy || name.trim() === ''}>
        {t(paired ? 'phone.passkeySubmit' : 'phone.pairSubmit')}
      </button>
    </form>
  );
}

/** Shown on a phone whose board session is locked: the passkey prompt unlocks it. */
export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await checkPasskey();
      onUnlocked();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!passkeysAvailable()) return <NoPasskeys title={t('phone.lockedTitle')} />;
  return (
    <div className="gate">
      <h2>{t('phone.lockedTitle')}</h2>
      <p className="hint">{t('phone.lockedBody')}</p>
      {error && <div className="error">{error}</div>}
      <button type="button" className="btn primary" disabled={busy} onClick={() => void unlock()}>
        {t('phone.unlock')}
      </button>
    </div>
  );
}

/** Takes the place of a passkey button in a browser without passkeys, e.g. LINE's. */
function NoPasskeys({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="gate" role="alert">
      <h2>{title}</h2>
      <p>{t('phone.noPasskeys')}</p>
    </div>
  );
}

/** Shown instead of an empty board when the API answers 401: this device is not paired. */
export function NotPaired() {
  const { t } = useTranslation();
  return (
    <div className="gate" role="alert">
      <h2>{t('phone.notPairedTitle')}</h2>
      <p>{t('phone.notPairedBody')}</p>
    </div>
  );
}
