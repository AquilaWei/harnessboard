// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { refreshPricing } from '../src/pricing-refresh.js';

it('prints the server preview then applies its token after confirmation', async () => {
  const api = {
    pricingPreview: vi.fn(async () => ({
      id: 'preview',
      provider: 'claude' as const,
      prices: {},
      diff: 'NEW MODEL',
    })),
    pricingApply: vi.fn(async () => ({ written: true as const, file: '/config/prices.json' })),
  };
  const print = vi.fn();
  const confirm = vi.fn(async () => {
    expect(print).toHaveBeenCalledWith('NEW MODEL');
    return true;
  });
  await refreshPricing(api, 'claude', confirm, print);
  expect(api.pricingPreview).toHaveBeenCalledWith('claude');
  expect(api.pricingApply).toHaveBeenCalledWith('preview');
});

it('does not apply a declined preview', async () => {
  const api = {
    pricingPreview: vi.fn(async () => ({
      id: 'preview',
      provider: 'codex' as const,
      prices: {},
      diff: 'changed',
    })),
    pricingApply: vi.fn(),
  };
  await refreshPricing(api, 'codex', async () => false, vi.fn());
  expect(api.pricingApply).not.toHaveBeenCalled();
});
