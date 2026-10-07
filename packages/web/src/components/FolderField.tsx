// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FolderInfo, FolderListing } from '@harnessboard/shared';
import { api } from '../api';

const CHECK_DELAY_MS = 350;

interface Props {
  value: string;
  onChange: (path: string) => void;
  /** Recently used repositories, offered as suggestions. */
  recent: string[];
}

/**
 * Repository path input with a folder browser and a live check of what the path is.
 * Browsers do not reveal real paths from their own folder dialog, so the server lists folders.
 */
export function FolderField({ value, onChange, recent }: Props) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (!value.trim()) {
      setInfo(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api.inspectFolder(value).then(setInfo, () => setInfo(null));
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <div className="field">
      <label htmlFor="repo-path">{t('form.repo')}</label>
      <div className="input-row">
        <input
          id="repo-path"
          required
          className="mono"
          list="recent-repos"
          value={value}
          placeholder={t('folders.placeholder')}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn" onClick={() => setBrowsing((b) => !b)}>
          {t(browsing ? 'folders.closeBrowser' : 'folders.browse')}
        </button>
      </div>
      <datalist id="recent-repos">
        {recent.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <FolderStatus info={info} />
      {browsing && (
        <FolderBrowser
          start={info?.exists ? info.path : ''}
          onPick={(path) => {
            onChange(path);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

/** One line saying whether the path can be used, and how to fix it when it cannot. */
function FolderStatus({ info }: { info: FolderInfo | null }) {
  const { t } = useTranslation();
  if (!info) return <small className="hint">{t('form.repoHint')}</small>;
  if (!info.exists) return <small className="bad-text">✗ {t('folders.missing')}</small>;
  if (!info.repoRoot) {
    return (
      <small className="bad-text">
        ✗ {t('folders.notRepo')} <code>git init</code> + <code>git commit</code>
      </small>
    );
  }
  if (!info.hasCommits) return <small className="bad-text">✗ {t('folders.noCommits')}</small>;
  return (
    <small className="ok-text">
      ✓ {t('folders.repo')} <span className="mono">{info.repoRoot}</span>
    </small>
  );
}

interface BrowserProps {
  start: string;
  onPick: (path: string) => void;
  /** Closes without picking; needed at phone width, where the browser covers the field's button. */
  onClose: () => void;
}

function FolderBrowser({ start, onPick, onClose }: BrowserProps) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = (path?: string) =>
    api.folders(path).then(
      (next) => {
        setListing(next);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );

  // Opens once at `start`; later navigation happens through the buttons.
  useEffect(() => {
    void open(start || undefined);
  }, []);

  return (
    <div className="folder-browser" role="group" aria-label={t('folders.browse')}>
      {error && <div className="error">{error}</div>}
      {listing && (
        <>
          <div className="folder-path">
            <button
              type="button"
              className="btn small"
              disabled={listing.parent === null}
              onClick={() => void open(listing.parent ?? undefined)}
              aria-label={t('folders.up')}
            >
              ↑
            </button>
            <span className="mono">{listing.path}</span>
          </div>
          <ul className="folder-list">
            {listing.entries.length === 0 && <li className="empty">{t('folders.empty')}</li>}
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" className="folder" onClick={() => void open(entry.path)}>
                  <span aria-hidden>📁</span> {entry.name}
                  {entry.isRepo && <span className="badge">git</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Outside `listing` so the full-screen phone browser can be closed while loading or after an error. */}
      <div className="folder-actions">
        {listing && (
          <span className={listing.repoRoot ? 'ok-text' : 'hint'}>
            {listing.repoRoot ? `✓ ${t('folders.inRepo')}` : t('folders.pickHint')}
          </span>
        )}
        <button type="button" className="btn small phone-only" onClick={onClose}>
          {t('folders.closeBrowser')}
        </button>
        {listing && (
          <button type="button" className="btn primary small" onClick={() => onPick(listing.path)}>
            {t('folders.use')}
          </button>
        )}
      </div>
    </div>
  );
}
