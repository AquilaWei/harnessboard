// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import treeKill from 'tree-kill';
import { FEATURE_LIST_FILE } from '@harnessboard/shared';
import type { Feature, VerifyResult } from '@harnessboard/shared';

const OUTPUT_TAIL_CHARS = 4_000;

/**
 * Reads the feature list the agent keeps in the worktree.
 * Throws when the file is missing, is not JSON, or does not have the expected shape,
 * with a message that can be shown to the user and to the next session.
 */
export function readFeatureList(dir: string): Feature[] {
  return readPlan(dir).features;
}

/**
 * The feature list plus the planner's optional `verify` suggestion and open `questions`.
 * Throws like {@link readFeatureList}; bad optional fields are ignored rather than fatal.
 */
export function readPlan(dir: string): {
  features: Feature[];
  suggestedVerify: string | null;
  questions: string[];
} {
  const file = path.join(dir, FEATURE_LIST_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${FEATURE_LIST_FILE} was not found in the worktree`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${FEATURE_LIST_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const doc = (parsed ?? {}) as { features?: unknown; verify?: unknown; questions?: unknown };
  const features = doc.features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error(`${FEATURE_LIST_FILE} must contain a non-empty "features" array`);
  }
  const suggestedVerify =
    typeof doc.verify === 'string' && doc.verify.trim() ? doc.verify.trim() : null;
  const questions = Array.isArray(doc.questions)
    ? doc.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
    : [];
  return { features: features.map(checkFeature), suggestedVerify, questions };
}

function checkFeature(f: unknown, i: number): Feature {
  const item = f as Partial<Feature> | null;
  if (typeof item?.id !== 'string' || typeof item.description !== 'string') {
    throw new Error(`${FEATURE_LIST_FILE}: feature ${i + 1} needs a string id and description`);
  }
  if (typeof item.passes !== 'boolean') {
    throw new Error(`${FEATURE_LIST_FILE}: feature ${item.id} needs a boolean "passes"`);
  }
  return item as Feature;
}

/** Ids from `baseline` that are no longer in `current`; agents must not drop features. */
export function missingFeatures(baseline: Feature[], current: Feature[]): string[] {
  const ids = new Set(current.map((f) => f.id));
  return baseline.filter((f) => !ids.has(f.id)).map((f) => f.id);
}

/**
 * Runs the task's verify command through the platform shell (`sh` or `cmd.exe`) in `cwd`.
 * The whole process tree is killed on timeout or when `signal` aborts.
 * Never rejects: a command that cannot start comes back as a failed result.
 */
export function runVerify(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = () => {
      if (child.pid !== undefined && child.exitCode === null) treeKill(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolve({ command, ok: exitCode === 0 && !timedOut, exitCode, timedOut, output });
    };
    child.once('error', (err) => {
      output += err.message;
      finish(null);
    });
    child.once('close', finish);
  });
}
