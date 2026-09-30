// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { Feature, VerifyResult } from '@harnessboard/shared';

interface Props {
  features: Feature[] | null;
  lastVerify: VerifyResult | null;
}

/** The loop task's feature list with the output of the harness's latest verify run. */
export function FeatureList({ features, lastVerify }: Props) {
  const { t } = useTranslation();
  if (!features) return <p className="empty">{t('loop.noFeatures')}</p>;
  return (
    <>
      {lastVerify && (
        <div className={`verify ${lastVerify.ok ? 'ok' : 'failed'}`}>
          <strong>
            {lastVerify.ok ? '✓ ' : '⚠ '}
            <code className="mono">{lastVerify.command}</code>{' '}
            {t(lastVerify.ok ? 'loop.verifyPassed' : 'loop.verifyFailedDetail', {
              code: lastVerify.timedOut ? t('loop.timedOut') : String(lastVerify.exitCode),
            })}
          </strong>
          {!lastVerify.ok && lastVerify.output && <pre className="mono">{lastVerify.output}</pre>}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('loop.state')}</th>
            <th>{t('loop.id')}</th>
            <th>{t('loop.description')}</th>
          </tr>
        </thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.id}>
              <td className="nowrap">
                {f.passes ? `✓ ${t('loop.passes')}` : `· ${t('loop.open')}`}
              </td>
              <td className="mono nowrap">{f.id}</td>
              <td>{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
