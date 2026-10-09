// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EffortInfo, ModelInfo } from '@harnessboard/shared';

/**
 * Claude Code's aliases, which always mean the latest model of a family. Which efforts an
 * alias offers depends on the model it points at, so they list none.
 */
export const CLAUDE_ALIASES: ModelInfo[] = [
  alias('opus', 'Opus'),
  alias('sonnet', 'Sonnet'),
  alias('fable', 'Fable'),
  alias('haiku', 'Haiku'),
];

function alias(id: string, name: string): ModelInfo {
  const description = `Latest ${name}`;
  return { id, name, description, note: null, more: false, efforts: [], defaultEffort: null };
}

type Json = Record<string, unknown>;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Models in a Claude Code model catalog, the file behind its `/model` menu. Entries in its
 * `overflow` section are the "more models" ones. Throws when the catalog has no model list.
 */
export function parseClaudeCatalog(catalog: unknown): ModelInfo[] {
  const models = ((catalog as Json | null)?.catalog as Json | undefined)?.config as
    Json | undefined;
  if (!Array.isArray(models?.models)) throw new Error('no model list in the Claude catalog');
  return (models.models as Json[])
    .filter((m) => text(m.id) !== null)
    .map((m) => ({
      id: m.id as string,
      name: text(m.name) ?? (m.id as string),
      description: text(m.description),
      note: text((m.badge as Json | undefined)?.message),
      more: m.section === 'overflow',
      efforts: claudeEfforts(m.thinking as Json | undefined),
      // The catalog only badges one effort "Recommended"; it does not say which one the CLI
      // uses without `--effort`, so the default stays unknown.
      defaultEffort: null,
    }));
}

/** A Claude catalog model's `thinking.effort_options`; empty when it has none. */
function claudeEfforts(thinking: Json | undefined): EffortInfo[] {
  const options = thinking?.effort_options;
  if (!Array.isArray(options)) return [];
  return (options as Json[])
    .filter((o) => text(o.id) !== null)
    .map((o) => ({
      id: o.id as string,
      name: text(o.name) ?? (o.id as string),
      description: text((o.tooltip as Json | undefined)?.content),
      note: text((o.badge as Json | undefined)?.message),
    }));
}

/**
 * The models Claude Code offers this account, from the newest catalog it cached under
 * `configDir` (`~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise). The catalog is
 * Claude Code's own cache, not a documented interface, so when it is missing or unreadable
 * this falls back to the aliases.
 */
export function readClaudeModels(configDir = claudeConfigDir()): ModelInfo[] {
  const dir = path.join(configDir, 'cache', 'model-catalog');
  try {
    const catalogs = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Json)
      .sort((a, b) => Number(b.fetchedAt ?? 0) - Number(a.fetchedAt ?? 0));
    const models = parseClaudeCatalog(catalogs[0]);
    return models.length > 0 ? models : CLAUDE_ALIASES;
  } catch {
    return CLAUDE_ALIASES; // no catalog cached yet, or a format this version does not know
  }
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * Models in the catalog `codex debug models` prints, without the ones Codex hides from its
 * own model picker. Throws when the output has no model list.
 */
export function parseCodexModels(catalog: unknown): ModelInfo[] {
  const models = (catalog as Json | null)?.models;
  if (!Array.isArray(models)) throw new Error('no model list in the Codex catalog');
  return (models as Json[])
    .filter((m) => text(m.slug) !== null && m.visibility !== 'hide')
    .map((m) => ({
      id: m.slug as string,
      name: text(m.display_name) ?? (m.slug as string),
      description: text(m.description),
      note: null,
      more: false,
      efforts: codexEfforts(m.supported_reasoning_levels),
      defaultEffort: text(m.default_reasoning_level),
    }));
}

/** A Codex model's `supported_reasoning_levels`; Codex names a level only by its id. */
function codexEfforts(levels: unknown): EffortInfo[] {
  if (!Array.isArray(levels)) return [];
  return (levels as Json[])
    .filter((l) => text(l.effort) !== null)
    .map((l) => ({
      id: l.effort as string,
      name: l.effort as string,
      description: text(l.description),
      note: null,
    }));
}
