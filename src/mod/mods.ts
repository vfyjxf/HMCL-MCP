/**
 * Single-mod tools: search / get / download / install / list mods.
 *
 * Everything goes through HMCL's own MODS repositories inside the headless
 * HMCL JVM (ModrinthRemoteAddonRepository.MODS / CurseForgeRemoteAddonRepository.MODS):
 * search, project info, downloads (SHA-1 verified via HMCL's FileDownloadTask)
 * and install into an instance's mods/ directory. CurseForge uses HMCL's
 * embedded API key, so no HMCL_MCP_CURSEFORGE_API_KEY is required.
 *
 * Handlers NEVER throw for user-level failures — they return
 * `{ ok: false, error }` so the server layer produces a clean MCP isError.
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { ensureAgent } from '../hmcl-client.js';
import type {
  AgentHandle,
  Ctx,
  ModpackSource,
  ToolDef,
  ToolResult,
} from '../types.js';
import { fail, ok } from '../types.js';

const DEFAULT_LIMIT = 20;

const SOURCE_SCHEMA = z.enum(['modrinth', 'curseforge']);

function toSource(value: unknown): ModpackSource {
  return value === 'curseforge' ? 'curseforge' : 'modrinth';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run `fn` and convert any throw into a `fail(...)` ToolResult. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(errText(err));
  }
}

/** Start (or reuse) the HMCL agent; throws with an actionable message on failure. */
async function agentOf(ctx: Ctx): Promise<AgentHandle> {
  try {
    return await ensureAgent(ctx);
  } catch (err) {
    throw new Error(
      `HMCL agent could not be started: ${errText(err)}. Make sure the HMCL jar and ` +
        `hmcl-agent.jar are in ${ctx.hmclDir} (use install_hmcl) and that ` +
        `${ctx.javaPath ?? 'java on PATH'} is a JDK 17+.`,
    );
  }
}

/** Unwrap an AgentResult into its payload; throws with the agent's error message. */
function requireOk<T = unknown>(result: { ok: boolean; error?: string; data?: unknown }): T {
  if (!result.ok) throw new Error(result.error ?? 'unknown agent error');
  return result.data as T;
}

export function createModTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: 'search_mods',
      description:
        "Search single mods (not modpacks) with HMCL's own mod repositories: Modrinth (default) or " +
        "CurseForge (HMCL's embedded API key — no key needed). Pass gameVersion (e.g. \"1.21.4\") to " +
        'filter by Minecraft version. Returns hits: [{id (slug), title, description, authors, url}]. ' +
        'Use install_mod to place a mod file into an instance mods/ directory.',
      inputSchema: {
        query: z.string(),
        source: SOURCE_SCHEMA.optional(),
        gameVersion: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      handler: async (input) => {
        const query = typeof input.query === 'string' ? input.query : '';
        if (!query.trim()) return fail('search_mods requires a non-empty query');
        const source = toSource(input.source);
        const gameVersion =
          typeof input.gameVersion === 'string' && input.gameVersion.trim()
            ? input.gameVersion.trim()
            : undefined;
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
          ? Math.min(Math.max(Math.trunc(input.limit), 1), 50)
          : DEFAULT_LIMIT;
        return guard(async () => {
          const data = requireOk<unknown>(
            await (await agentOf(ctx)).searchMods(source, query, gameVersion, limit),
          );
          const hits = (data as { hits?: unknown }).hits;
          return ok(Array.isArray(hits) ? hits : data);
        });
      },
    },
    {
      name: 'get_mod',
      description:
        'Get details of a mod project (id = Modrinth slug or CurseForge slug/id) through HMCL: summary + ' +
        'available versions (id, version, gameVersions, loaders, filename). Pick a version id for install_mod.',
      inputSchema: {
        source: SOURCE_SCHEMA.optional(),
        id: z.string(),
      },
      handler: async (input) => {
        const source = toSource(input.source);
        const id = typeof input.id === 'string' ? input.id : '';
        if (!id) return fail('get_mod requires a mod id');
        return guard(async () => {
          const data = requireOk<unknown>(await (await agentOf(ctx)).getMod(source, id));
          const rec = (data ?? {}) as Record<string, unknown>;
          const versions = Array.isArray(rec.versions) ? rec.versions : [];
          return ok({ summary: rec.summary ?? null, versions, latest: versions[0] ?? null });
        });
      },
    },
    {
      name: 'download_mod',
      description:
        "Download a mod file through HMCL into <workdir>/modfiles/ (SHA-1 verified via HMCL's downloader). " +
        'Pass versionId (a version id from get_mod) to pick a specific version; defaults to the latest. ' +
        'Returns {id, version, gameVersions, filename, path, size}.',
      inputSchema: {
        source: SOURCE_SCHEMA.optional(),
        id: z.string(),
        versionId: z.string().optional(),
      },
      handler: async (input) => {
        const source = toSource(input.source);
        const id = typeof input.id === 'string' ? input.id : '';
        if (!id) return fail('download_mod requires a mod id');
        const versionId =
          typeof input.versionId === 'string' && input.versionId ? input.versionId : undefined;
        return guard(async () =>
          ok(requireOk(await (await agentOf(ctx)).downloadMod(source, id, versionId))),
        );
      },
    },
    {
      name: 'install_mod',
      description:
        'Install a mod into an instance: places the mod .jar into <workdir>/versions/<instance>/mods/. ' +
        'Either pass path to a local mod file, or id (plus optional versionId) to download it first via HMCL. ' +
        '`instance` is an installed instance id (see list_versions / list_modpacks).',
      inputSchema: {
        source: SOURCE_SCHEMA.optional(),
        id: z.string().optional(),
        versionId: z.string().optional(),
        path: z.string().optional(),
        instance: z.string(),
      },
      handler: async (input) => {
        const source = toSource(input.source);
        const id = typeof input.id === 'string' && input.id ? input.id : undefined;
        const versionId =
          typeof input.versionId === 'string' && input.versionId ? input.versionId : undefined;
        const modPath = typeof input.path === 'string' && input.path ? input.path : undefined;
        const instance = typeof input.instance === 'string' ? input.instance.trim() : '';
        if (!instance) return fail('install_mod requires an "instance" id (see list_versions / list_modpacks)');
        if (!id && !modPath) {
          return fail('install_mod requires either id (source, to download the mod) or path (a local mod file)');
        }
        if (modPath && !existsSync(modPath)) {
          return fail(`Mod file not found: ${modPath}`);
        }
        return guard(async () =>
          ok(
            requireOk(
              await (await agentOf(ctx)).installMod({
                source,
                id,
                versionId,
                path: modPath,
                instance,
              }),
            ),
          ),
        );
      },
    },
    {
      name: 'list_mods',
      description:
        'List the mods currently installed in an instance: scans <workdir>/versions/<instance>/mods/ for ' +
        '.jar files and returns [{filename, size}] plus the modsDir path.',
      inputSchema: {
        instance: z.string(),
      },
      handler: async (input) => {
        const instance = typeof input.instance === 'string' ? input.instance.trim() : '';
        if (!instance) return fail('list_mods requires an "instance" id');
        return guard(async () => ok(requireOk(await (await agentOf(ctx)).listMods(instance))));
      },
    },
  ];
}
