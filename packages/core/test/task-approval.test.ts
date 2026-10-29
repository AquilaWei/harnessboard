// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import type { PermissionRequest, TaskApprovalRule } from '@harnessboard/shared';
import { approvalInput, matchingApproval, reusableApproval } from '../src/task-approval.js';

const request: PermissionRequest = {
  requestId: 'request-2',
  sessionId: 'worker-2',
  ts: 20,
  toolName: 'Bash',
  summary: 'test',
  suggestedRules: [],
  risk: null,
  cwd: '/repo',
  input: { command: 'pnpm test', cwd: '/repo' },
};
const rule: TaskApprovalRule = {
  id: 'rule-1',
  toolName: 'Bash',
  cwd: '/repo',
  input: { cwd: '/repo', command: 'pnpm test' },
  actor: 'secretary',
  reason: 'Run approved tests',
  sourceRequestId: 'request-1',
  sourceSessionId: 'worker-1',
  createdAt: 10,
  reusable: true,
};

it('matches exact arguments across workers regardless of property order', () => {
  expect(matchingApproval(request, [rule])?.id).toBe('rule-1');
});
it('rejects changed command arguments', () => {
  expect(
    matchingApproval({ ...request, input: { command: 'pnpm test --update', cwd: '/repo' } }, [
      rule,
    ]),
  ).toBeUndefined();
});
it('rejects a different cwd', () => {
  expect(matchingApproval({ ...request, cwd: '/other' }, [rule])).toBeUndefined();
});
it('rejects revoked approvals', () => {
  expect(matchingApproval(request, [{ ...rule, revokedAt: 30 }])).toBeUndefined();
});
it('does not borrow another tasks rules', () => {
  expect(matchingApproval(request, [])).toBeUndefined();
});
it('retains exact matching after JSON persistence', () => {
  expect(matchingApproval(request, JSON.parse(JSON.stringify([rule])))?.id).toBe('rule-1');
});
it('rejects missing previews', () => {
  expect(reusableApproval({ ...request, input: {} })).toBe(false);
});
it('does not reuse adb operations without fresh screen evidence', () => {
  expect(
    reusableApproval({ ...request, input: { command: 'adb -s device shell input tap 1 2' } }),
  ).toBe(false);
});
it('does not reuse Codex file grants without full edit evidence', () => {
  expect(
    reusableApproval({
      ...request,
      input: { rpcMethod: 'item/fileChange/requestApproval', file_path: '/repo/a' },
    }),
  ).toBe(false);
});
it('retains additional permissions and targets while removing transport identity', () => {
  expect(
    approvalInput({
      rpcId: 3,
      rpcParams: {
        threadId: 't',
        turnId: 'r',
        itemId: 'i',
        command: 'test',
        additionalPermissions: { network: true },
      },
    }),
  ).toEqual({
    rpcParams: { command: 'test', additionalPermissions: { network: true } },
  });
});
it('rejects a changed file edit even when the path matches', () => {
  expect(
    matchingApproval(
      { ...request, toolName: 'Edit', input: { file_path: 'a', old_string: 'x', new_string: 'z' } },
      [{ ...rule, toolName: 'Edit', input: { file_path: 'a', old_string: 'x', new_string: 'y' } }],
    ),
  ).toBeUndefined();
});
