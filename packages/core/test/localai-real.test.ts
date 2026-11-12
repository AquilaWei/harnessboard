// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { LocalAiService } from '../src/localai.js';
import { LocalAiServer } from '../src/localai-server.js';

// Opt-in hardware acceptance: uses installed models, never downloads or changes the registry.
it.skipIf(process.env.HARNESSBOARD_LOCALAI_ACCEPTANCE !== '1')(
  'real LocalAICLI answers Chinese, reuses the model, switches and unloads after five minutes',
  async () => {
    const ai = new LocalAiService({
      enabled: true,
      command: null,
      selectedModel: 'lfm2.5-24b-a2b-q4',
      models: { pricing: 'gpt-oss-20b', slug: 'mellum2.1', commit: 'lfm2.5' },
    });
    const stop = vi.spyOn(LocalAiServer.prototype, 'stop');
    try {
      console.log('Registered models:', await ai.models());
      const first = await ai.request('chat', '請用繁體中文簡短說明什麼是任務看板。', {
        timeoutMs: 180000,
      });
      console.log('Chinese answer:', first);
      expect(first.status).toBe('ok');
      expect(first.status === 'ok' && /[\u3400-\u9fff]/.test(first.answer)).toBe(true);
      const firstPid = ai.status().servicePid;
      stop.mockClear();
      const second = await ai.request('chat', '請用繁體中文用一句話回答：如何查看任務進度？', {
        timeoutMs: 180000,
      });
      console.log('Second answer:', second);
      expect(second.status).toBe('ok');
      expect(stop).not.toHaveBeenCalled();
      expect(ai.status().servicePid).toBe(firstPid);
      ai.selectModel('mellum2.1-12b-q4');
      const third = await ai.request('chat', 'Reply with OK.', { timeoutMs: 180000 });
      console.log('Switched answer:', third);
      expect(third.status).toBe('ok');
      expect(ai.status().loadedModel).toBe('mellum2.1-12b-q4');
      const supervisorPid = ai.status().servicePid!;
      const runtimePid = readFileSync(
        `/proc/${supervisorPid}/task/${supervisorPid}/children`,
        'utf8',
      )
        .trim()
        .split(' ')[0];
      console.log(
        'Loaded runtime memory:',
        readFileSync(`/proc/${runtimePid}/status`, 'utf8').match(/^VmRSS:.*$/m)?.[0],
      );
      console.log('Waiting five real minutes for model release:', new Date().toISOString());
      await new Promise((resolve) => setTimeout(resolve, 304000));
      console.log('After idle:', ai.status());
      expect(ai.status().loadedModel).toBeNull();
      expect(ai.status().state).toBe('unloaded');
      expect(existsSync(`/proc/${supervisorPid}`)).toBe(false);
      expect(existsSync(`/proc/${runtimePid}`)).toBe(false);
    } finally {
      await ai.close();
      stop.mockRestore();
    }
  },
  900000,
);
