// SPDX-License-Identifier: Apache-2.0
export { reduceHtml, refreshPrices } from '@harnessboard/core';
import type { PricingProvider } from '@harnessboard/shared';
import type { ApiClient } from './client.js';

/** CLI confirmation happens after the server prepares and validates its preview. */
export async function refreshPricing(
  api: Pick<ApiClient, 'pricingPreview' | 'pricingApply'>,
  provider: PricingProvider,
  confirm: () => Promise<boolean>,
  print: (message: string) => void,
): Promise<void> {
  const preview = await api.pricingPreview(provider);
  if (!preview.diff) {
    print('Prices are already up to date.');
    return;
  }
  print(preview.diff);
  if (!(await confirm())) {
    print('Nothing written.');
    return;
  }
  const applied = await api.pricingApply(preview.id);
  print(`Updated ${provider} prices in ${applied.file}.`);
}
