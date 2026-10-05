// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

interface Props {
  /** The code from the `#pair=<code>` address the computer showed as a QR code. */
  code: string;
  onPaired: () => void;
}

/** Shown on a phone that opened a pairing address: names the device and pairs it. */
export function PairScreen({ code, onPaired }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.pair({ code, name: name.trim() });
      onPaired();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="gate" onSubmit={submit}>
      <h2>{t('phone.pairTitle')}</h2>
      <p className="hint">{t('phone.pairIntro')}</p>
      {error && <div className="error">{error}</div>}
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
      <button type="submit" className="btn primary" disabled={busy || name.trim() === ''}>
        {t('phone.pairSubmit')}
      </button>
    </form>
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
