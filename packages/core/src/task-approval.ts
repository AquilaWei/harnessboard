// SPDX-License-Identifier: Apache-2.0
import type { PermissionRequest, TaskApprovalRule } from '@harnessboard/shared';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return JSON.stringify(value) ?? 'undefined';
}

/** Keep every permission-bearing argument; omit only the RPC envelope identity. */
export function approvalInput(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  delete result.rpcId;
  if (result.rpcParams && typeof result.rpcParams === 'object') {
    const params = { ...(result.rpcParams as Record<string, unknown>) };
    delete params.threadId;
    delete params.turnId;
    delete params.itemId;
    result.rpcParams = params;
  }
  return result;
}

/** Missing previews and screen-dependent operations must always be reviewed again. */
export function reusableApproval(request: PermissionRequest): boolean {
  if (!request.cwd || !request.input || Object.keys(request.input).length === 0) return false;
  if (request.toolName === '?' || request.toolName === 'CodexApproval') return false;
  if (
    request.toolName === 'Edit' &&
    (typeof request.input.file_path !== 'string' ||
      typeof request.input.old_string !== 'string' ||
      typeof request.input.new_string !== 'string')
  )
    return false;
  if (
    request.toolName === 'Write' &&
    (typeof request.input.file_path !== 'string' || typeof request.input.content !== 'string')
  )
    return false;
  if (
    request.toolName === 'Bash' &&
    (typeof request.input.command !== 'string' || !request.input.command.trim())
  )
    return false;
  if (/adb/i.test(canonical(request.input))) return false;
  if (request.input.rpcMethod === 'item/fileChange/requestApproval') return false;
  return true;
}

export function matchingApproval(
  request: PermissionRequest,
  rules: readonly TaskApprovalRule[],
): TaskApprovalRule | undefined {
  if (!reusableApproval(request)) return undefined;
  return rules.find(
    (rule) =>
      rule.reusable &&
      !rule.revokedAt &&
      rule.cwd === request.cwd &&
      rule.toolName === request.toolName &&
      canonical(rule.input) === canonical(approvalInput(request.input!)),
  );
}
