/**
 * HMCL lifecycle + filesystem tools.
 *
 * Owns: check_environment, install_hmcl, start_hmcl, stop_hmcl, list_versions,
 * list_modpacks, launch_game, stop_game.
 *
 * Heavy lifting (version install, modpack install, game launch) is delegated to
 * the javaagent through `ensureAgent(ctx)` from src/hmcl-client.ts (see the
 * cross-module contract in src/types.ts). Everything that can be answered
 * locally is: environment probing, HMCL jar / agent jar download & build,
 * and filesystem scans of <workdir>/versions/.
 *
 * Handlers NEVER throw for user-level failures — they return `{ ok: false, error }`
 * (src/types.ts ok()/fail()) and the server layer turns that into an MCP isError result.
 */
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { AgentStatus, Ctx, InstalledModpack, LaunchRequest, LoaderId, ToolDef } from '../types.js';
import { fail, ok } from '../types.js';
import { ensureAgent } from '../hmcl-client.js';

/** Project root (where agent/build.mjs and agent/build/ live), resolved from this file. */
const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Identify ourselves to REST APIs (Modrinth/GitHub require a UA). */
const USER_AGENT = 'hmcl-mcp-server/0.1.0 (HMCL MCP server)';

/** Agent endpoints live on loopback only; the token is passed via header. */
function agentBaseUrl(ctx: Ctx): string {
  return `http://127.0.0.1:${ctx.agentPort}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 *  Local filesystem scans (shared by check_environment / list_* tools)
 * ------------------------------------------------------------------ */

export interface VersionEntry {
  id: string;
  path: string;
  hasJar: boolean;
}

/** A versions dir counts as an instance when it contains <id>/<id>.json. */
async function scanVersions(workdir: string): Promise<VersionEntry[]> {
  const versionsDir = path.join(workdir, 'versions');
  let entries;
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return []; // no versions/ dir yet — nothing installed
  }
  const out: VersionEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const instanceDir = path.join(versionsDir, entry.name);
    const jsonPath = path.join(instanceDir, `${entry.name}.json`);
    if (await pathExists(jsonPath)) {
      out.push({
        id: entry.name,
        path: instanceDir,
        hasJar: await pathExists(path.join(instanceDir, `${entry.name}.jar`)),
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Parse <instance>/modpack.json (HMCL `ModpackConfiguration`) into an
 * InstalledModpack. `name` is the instance id (the dir name — that is what
 * launch_game takes as `version`); gameVersion/modLoader are best-effort
 * reads from the provider-specific `manifest`.
 */
async function scanModpacks(ctx: Ctx): Promise<InstalledModpack[]> {
  const versionsDir = path.join(ctx.workdir, 'versions');
  let entries;
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledModpack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const instanceDir = path.join(versionsDir, entry.name);
    // HMCL 3.16+ writes the ModpackConfiguration marker as modpack.cfg
    // (JSON content); older versions used modpack.json. Accept both.
    const marker = (await pathExists(path.join(instanceDir, 'modpack.cfg')))
      ? 'modpack.cfg'
      : (await pathExists(path.join(instanceDir, 'modpack.json')))
        ? 'modpack.json'
        : null;
    if (!marker) continue;
    let cfg: unknown;
    try {
      cfg = JSON.parse(await fs.readFile(path.join(instanceDir, marker), 'utf8'));
    } catch (err) {
      ctx.log(`list_modpacks: unreadable ${path.join(instanceDir, marker)}: ${String(err)}`);
      continue;
    }
    const record = (cfg ?? {}) as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    let format: InstalledModpack['format'];
    if (type.includes('Modrinth')) format = 'mrpack';
    else if (type.includes('Curse')) format = 'curseforge'; // "Curse" (3.16) / "CurseForge" (legacy)
    else if (type.includes('HMCL')) format = 'hmcl';
    else {
      ctx.log(`list_modpacks: skip ${entry.name}: unsupported modpack type "${type}"`);
      continue;
    }
    const item: InstalledModpack = { name: entry.name, path: instanceDir, format };
    applyManifestBestEffort(item, record.manifest);
    out.push(item);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Best-effort gameVersion/modLoader extraction from the provider manifest. */
function applyManifestBestEffort(item: InstalledModpack, manifest: unknown): void {
  if (!manifest || typeof manifest !== 'object') return;
  const m = manifest as Record<string, unknown>;
  if (item.format === 'mrpack') {
    // ModrinthManifest: dependencies { minecraft, fabric-loader|forge|neoforge|quilt-loader }
    const deps = m.dependencies;
    if (deps && typeof deps === 'object') {
      const d = deps as Record<string, unknown>;
      if (typeof d.minecraft === 'string') item.gameVersion = d.minecraft;
      for (const key of ['fabric-loader', 'forge', 'neoforge', 'quilt-loader'] as const) {
        if (typeof d[key] === 'string') {
          item.modLoader = key.replace('-loader', '');
          break;
        }
      }
    }
  } else if (item.format === 'curseforge') {
    // CurseManifest: minecraft { version, modLoaders: [{ id: "forge-40.1.0", primary }] }
    const mc = m.minecraft;
    if (mc && typeof mc === 'object') {
      const mcObj = mc as Record<string, unknown>;
      if (typeof mcObj.version === 'string') item.gameVersion = mcObj.version;
      const loaders = mcObj.modLoaders;
      if (Array.isArray(loaders) && loaders[0] && typeof loaders[0] === 'object') {
        const id = (loaders[0] as Record<string, unknown>).id;
        if (typeof id === 'string') item.modLoader = id.split('-')[0];
      }
    }
  } else if (item.format === 'hmcl') {
    // HMCL packs: manifest is the Modpack object with a gameVersion field.
    if (typeof m.gameVersion === 'string') item.gameVersion = m.gameVersion;
  }
}

/* ------------------------------------------------------------------ *
 *  Environment probing (check_environment)
 * ------------------------------------------------------------------ */

/**
 * Extract the version string from `java -version` output (stderr, sometimes
 * stdout). Matches `version "X.Y.Z"`, falling back to the first non-empty line
 * (or 'unknown').
 */
export function parseJavaVersion(text: string): string {
  const match = /version\s+"([^"]+)"/i.exec(text);
  return match ? match[1] : (text.trim().split(/\r?\n/)[0] || 'unknown');
}

/** Run `java -version` (stderr) and return {path, version}; null when unusable. */
async function detectJava(ctx: Ctx): Promise<{ path: string; version: string } | null> {
  const javaBin = ctx.javaPath ?? 'java';
  const run = spawnSync(javaBin, ['-version'], { encoding: 'utf8', timeout: 15_000 });
  if (run.error || typeof run.status !== 'number' || run.status !== 0) return null;
  const text = `${run.stderr ?? ''}${run.stdout ?? ''}`;
  return { path: javaBin, version: parseJavaVersion(text) };
}

/** javafx jars needed by the agent JVM: looked up in <hmclDir>, falling back to agent/build/. */
async function findJavafxJars(ctx: Ctx): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of [ctx.hmclDir, path.join(projectRoot, 'agent', 'build')]) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.toLowerCase().startsWith('javafx-') && name.toLowerCase().endsWith('.jar')) {
        found.add(path.join(dir, name));
      }
    }
  }
  return [...found].sort();
}

/** Probe GET /status on the agent with a short timeout; never throws. */
async function probeAgent(ctx: Ctx): Promise<{ running: boolean; agent: AgentStatus | null }> {
  try {
    const res = await fetch(`${agentBaseUrl(ctx)}/status`, {
      headers: { 'X-HMCL-Agent-Token': ctx.agentToken },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { running: false, agent: null };
    const body: unknown = await res.json().catch(() => null);
    // Accept both the bare AgentStatus and a { ok: true, data: AgentStatus } wrapper.
    if (body && typeof body === 'object' && 'data' in body) {
      const data = (body as Record<string, unknown>).data;
      return { running: true, agent: (data && typeof data === 'object' ? data : null) as AgentStatus | null };
    }
    return { running: true, agent: body as AgentStatus | null };
  } catch {
    return { running: false, agent: null };
  }
}

/* ------------------------------------------------------------------ *
 *  install_hmcl helpers
 * ------------------------------------------------------------------ */

/** Resolve the latest HMCL release jar URL via the GitHub releases API. Throws Error. */
async function resolveLatestHmclJarUrl(): Promise<string> {
  const res = await fetch('https://api.github.com/repos/HMCL-dev/HMCL/releases/latest', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        `GitHub releases API rate-limited or forbidden (HTTP ${res.status}). ` +
          'Download HMCL.jar manually (https://hmcl.huangyuhui.net/download) and retry, or use docs/setup.md.',
      );
    }
    throw new Error(`GitHub releases API failed (HTTP ${res.status})`);
  }
  const release = (await res.json()) as {
    tag_name?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const asset = release.assets?.find(
    (a) => typeof a.name === 'string' && a.name.endsWith('.jar') && typeof a.browser_download_url === 'string',
  );
  if (!asset) throw new Error(`no .jar asset in latest HMCL release ${release.tag_name ?? '(unknown)'}`);
  return asset.browser_download_url as string;
}

/** Return an error message when javac is unusable, or null when it is available. */
function findJavac(ctx: Ctx): string | null {
  const candidates: string[] = ['javac'];
  if (ctx.javaPath) {
    candidates.push(path.join(path.dirname(ctx.javaPath), process.platform === 'win32' ? 'javac.exe' : 'javac'));
  }
  for (const candidate of candidates) {
    const run = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 15_000 });
    if (!run.error && typeof run.status === 'number' && run.status === 0) return null;
  }
  return 'javac not found on PATH — the agent jar is compiled by agent/build.mjs, which needs a JDK. Install JDK 17+ (21 recommended) and make sure both java and javac are available.';
}

/** Loader ids accepted by the loader tools (must match the agent's LOADER_IDS). */
const LOADER_IDS = [
  'fabric',
  'forge',
  'neoforge',
  'quilt',
  'optifine',
  'liteloader',
  'legacyfabric',
  'cleanroom',
] as const;

const LOADER_SCHEMA = z.enum(LOADER_IDS);

function isLoaderId(value: unknown): value is LoaderId {
  return typeof value === 'string' && (LOADER_IDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 *  Tools
 * ------------------------------------------------------------------ */

export function createHmclTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: 'check_environment',
      description:
        'Report the current environment: java (path + version), workdir, hmcl dir contents ' +
        '(HMCL.jar / hmcl-agent.jar / javafx jars), whether the headless HMCL agent JVM is running ' +
        '(loopback probe with short timeout), and counts of installed versions and modpacks. ' +
        'Run this first to diagnose setup problems. java is null when no JDK is found.',
      inputSchema: {},
      handler: async () => {
        const [java, agent, hmclDir, versions, modpacks] = await Promise.all([
          detectJava(ctx),
          probeAgent(ctx),
          scanHmclDir(ctx),
          scanVersions(ctx.workdir),
          scanModpacks(ctx),
        ]);
        return ok({
          java,
          workdir: ctx.workdir,
          hmclDir: {
            path: ctx.hmclDir,
            hasHmclJar: hmclDir.hasHmclJar,
            hasAgentJar: hmclDir.hasAgentJar,
            javafxJars: hmclDir.javafxJars,
          },
          agentRunning: agent.running,
          agent: agent.agent,
          versionsCount: versions.length,
          modpacksCount: modpacks.length,
        });
      },
    },
    {
      name: 'install_hmcl',
      description:
        'Prepare the HMCL directory: if <hmclDir>/HMCL.jar is missing, download the latest HMCL release ' +
        'jar from GitHub (asset ending in .jar); then run `node agent/build.mjs` (requires javac on PATH) ' +
        'to fetch the javafx jars and compile hmcl-agent.jar; copy hmcl-agent.jar and the javafx jars into ' +
        '<hmclDir>. Returns the resulting paths. Safe to re-run.',
      inputSchema: {},
      handler: async () => {
        try {
          await fs.mkdir(ctx.hmclDir, { recursive: true });
        } catch (err) {
          return fail(`cannot create ${ctx.hmclDir}: ${String(err)}`);
        }

        const javacError = findJavac(ctx);
        if (javacError) return fail(javacError);

        const notes: string[] = [];
        const hmclJar = path.join(ctx.hmclDir, 'HMCL.jar');

        if (await pathExists(hmclJar)) {
          notes.push(`HMCL.jar already present at ${hmclJar}; download skipped`);
        } else {
          let url: string;
          try {
            url = await resolveLatestHmclJarUrl();
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': USER_AGENT },
              redirect: 'follow',
              signal: AbortSignal.timeout(300_000),
            });
            if (!res.ok) return fail(`HMCL jar download failed (HTTP ${res.status}) from ${url}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(hmclJar, buffer);
            notes.push(`downloaded ${url} (${buffer.length} bytes)`);
          } catch (err) {
            return fail(`HMCL jar download failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Build the agent (javafx jars + hmcl-agent.jar) with the repo's build script.
        const build = spawnSync(process.execPath, ['agent/build.mjs'], {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 600_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (build.error) {
          return fail(`agent/build.mjs failed to run: ${build.error.message ?? String(build.error)}`);
        }
        if (build.status !== 0) {
          const output = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim();
          return fail(`agent/build.mjs exited with code ${build.status}${output ? `:\n${truncate(output, 3000)}` : ''}`);
        }

        const builtAgentJar = path.join(projectRoot, 'agent', 'build', 'hmcl-agent.jar');
        if (!(await pathExists(builtAgentJar))) {
          return fail(`agent build finished but ${builtAgentJar} is missing — inspect the agent/build.mjs output above`);
        }
        const agentJar = path.join(ctx.hmclDir, 'hmcl-agent.jar');
        try {
          await fs.copyFile(builtAgentJar, agentJar);
        } catch (err) {
          return fail(`cannot copy agent jar to ${agentJar}: ${String(err)}`);
        }
        notes.push(`copied ${builtAgentJar} → ${agentJar}`);

        // The agent JVM needs javafx-base/javafx-graphics on its classpath; keep a copy next to HMCL.jar.
        const javafxJars: string[] = [];
        let buildFiles: string[] = [];
        try {
          buildFiles = await fs.readdir(path.join(projectRoot, 'agent', 'build'));
        } catch {
          /* build dir missing — nothing to copy */
        }
        for (const name of buildFiles) {
          if (!(name.toLowerCase().startsWith('javafx-') && name.toLowerCase().endsWith('.jar'))) continue;
          const source = path.join(projectRoot, 'agent', 'build', name);
          const target = path.join(ctx.hmclDir, name);
          if (!(await pathExists(target))) {
            try {
              await fs.copyFile(source, target);
            } catch (err) {
              ctx.log(`install_hmcl: copy ${source} → ${target} failed: ${String(err)}`);
              continue;
            }
          }
          javafxJars.push(target);
        }
        if (javafxJars.length === 0) {
          notes.push('no javafx jars found in agent/build — the agent JVM may not start (see check_environment)');
        }

        return ok({ hmclJar, agentJar, javafxJars, notes });
      },
    },
    {
      name: 'start_hmcl',
      description:
        'Start the headless HMCL JVM with the injected javaagent (no-op if already running, per ensureAgent) ' +
        'and return the agent status ({hmclVersion, workdir, java, versions, running, gamePid}). ' +
        'The launcher GUI never opens; only the game window appears when a game is launched.',
      inputSchema: {},
      handler: async () => {
        try {
          const handle = await ensureAgent(ctx);
          return ok(await handle.status());
        } catch (err) {
          return fail(`failed to start HMCL agent: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'stop_hmcl',
      description:
        'Stop the headless HMCL JVM by POSTing /shutdown to the agent on 127.0.0.1, then confirm the ' +
        'agent is down with a status probe. Fails when no agent is reachable (run start_hmcl first).',
      inputSchema: {},
      handler: async () => {
        let res: Response;
        try {
          res = await fetch(`${agentBaseUrl(ctx)}/shutdown`, {
            method: 'POST',
            headers: { 'X-HMCL-Agent-Token': ctx.agentToken },
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          return fail(
            `HMCL agent is not reachable at ${agentBaseUrl(ctx)} — is it running? Run start_hmcl first.`,
          );
        }
        if (res.status < 200 || res.status >= 300) {
          return fail(`agent /shutdown returned HTTP ${res.status}`);
        }
        // The JVM's shutdown hook stops a tracked game first, so exiting can
        // take a couple of seconds — poll (up to 10s) until the agent goes down.
        const deadline = Date.now() + 10_000;
        let probe = await probeAgent(ctx);
        while (probe.running && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          probe = await probeAgent(ctx);
        }
        if (!probe.running) return ok({ stopped: true, httpStatus: res.status });
        return ok({ stopped: false, httpStatus: res.status, agent: probe.agent });
      },
    },
    {
      name: 'list_versions',
      description:
        'List installed game versions by scanning <workdir>/versions/ — a directory counts as a version ' +
        'when it contains <id>/<id>.json. Returns [{id, path, hasJar}], sorted by id.',
      inputSchema: {},
      handler: async () => ok(await scanVersions(ctx.workdir)),
    },
    {
      name: 'install_version',
      description:
        'Install a vanilla Minecraft version (e.g. "1.20.4") through the HMCL agent. ' +
        'Downloads the version json, client jar and libraries (via BMCLAPI/mojang mirrors) into ' +
        '<workdir>/versions/<id>/ and <workdir>/libraries/ — this can take a few minutes on first run. ' +
        'Assets are downloaded by HMCL at first launch.',
      inputSchema: {
        version: z.string().describe('Minecraft version id, e.g. "1.20.4"'),
      },
      handler: async (input) => {
        const version = input.version;
        if (typeof version !== 'string' || !version.trim()) {
          return fail('install_version requires a "version" string, e.g. "1.20.4"');
        }
        try {
          const handle = await ensureAgent(ctx);
          const result = await handle.installVersion(version.trim());
          if (!result.ok) return fail(`HMCL failed to install version ${version.trim()}: ${result.error}`);
          return ok(result.data ?? { id: version.trim() });
        } catch (err) {
          return fail(`install_version failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'list_remote_versions',
      description:
        'List Minecraft versions available for install_version from the remote version list ' +
        '(BMCLAPI/Mojang mirrors). type filters: "release" (default: all), "snapshot", or "all". ' +
        'Returns [{id, type, releaseDate?}] sorted newest-first.',
      inputSchema: {
        type: z.enum(['release', 'snapshot', 'all']).optional(),
      },
      handler: async (input) => {
        const type =
          input.type === 'release' || input.type === 'snapshot' || input.type === 'all'
            ? input.type
            : undefined;
        try {
          const handle = await ensureAgent(ctx);
          const result = await handle.listRemoteVersions(type);
          if (!result.ok) return fail(result.error);
          return ok(result.data ?? { versions: [] });
        } catch (err) {
          return fail(`list_remote_versions failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'list_loader_versions',
      description:
        'List mod-loader versions available for a Minecraft version: fabric, forge, neoforge, quilt, ' +
        'optifine, liteloader, legacyfabric or cleanroom. Returns [{id (loader version), fullVersion ' +
        '(instance id used internally), gameVersion}] — pass `id` to install_loader.',
      inputSchema: {
        loader: LOADER_SCHEMA,
        gameVersion: z.string().describe('Minecraft version, e.g. "1.21.4"'),
      },
      handler: async (input) => {
        if (!isLoaderId(input.loader)) {
          return fail(`list_loader_versions requires a "loader" in ${LOADER_IDS.join(', ')}`);
        }
        const gameVersion = typeof input.gameVersion === 'string' ? input.gameVersion.trim() : '';
        if (!gameVersion) return fail('list_loader_versions requires a "gameVersion", e.g. "1.21.4"');
        try {
          const handle = await ensureAgent(ctx);
          const result = await handle.listLoaderVersions(input.loader, gameVersion);
          if (!result.ok) return fail(result.error);
          return ok(result.data ?? { loader: input.loader, gameVersion, versions: [] });
        } catch (err) {
          return fail(`list_loader_versions failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'install_loader',
      description:
        'Install a mod loader (fabric/forge/neoforge/quilt/optifine/liteloader/legacyfabric/cleanroom). ' +
        'Two modes: pass instance to install the loader into an EXISTING instance, or gameVersion ' +
        '(+ optional name) to create a NEW instance with the vanilla game and the loader in one build. ' +
        'versionId is a loader version from list_loader_versions (e.g. "0.16.14"); fullVersion ' +
        '(e.g. "fabric-loader-0.16.14-1.21.4") also works. Downloads loader libraries through HMCL.',
      inputSchema: {
        loader: LOADER_SCHEMA,
        versionId: z.string().optional(),
        fullVersion: z.string().optional(),
        gameVersion: z.string().optional(),
        instance: z.string().optional(),
        name: z.string().optional(),
      },
      handler: async (input) => {
        if (!isLoaderId(input.loader)) {
          return fail(`install_loader requires a "loader" in ${LOADER_IDS.join(', ')}`);
        }
        const versionId =
          typeof input.versionId === 'string' && input.versionId ? input.versionId : undefined;
        const fullVersion =
          typeof input.fullVersion === 'string' && input.fullVersion ? input.fullVersion : undefined;
        const gameVersion =
          typeof input.gameVersion === 'string' && input.gameVersion ? input.gameVersion : undefined;
        const instance =
          typeof input.instance === 'string' && input.instance ? input.instance : undefined;
        const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
        if (!versionId && !fullVersion) {
          return fail('install_loader requires versionId or fullVersion (see list_loader_versions)');
        }
        if (!instance && !gameVersion) {
          return fail(
            'install_loader requires "instance" (existing instance to patch) or "gameVersion" (new instance)',
          );
        }
        try {
          const handle = await ensureAgent(ctx);
          const result = await handle.installLoader({
            loader: input.loader,
            versionId,
            fullVersion,
            gameVersion,
            instance,
            name,
          });
          if (!result.ok) return fail(result.error);
          return ok(result.data ?? { loader: input.loader });
        } catch (err) {
          return fail(`install_loader failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'list_modpacks',
      description:
        'List installed modpacks by scanning <workdir>/versions/*/modpack.json (HMCL ModpackConfiguration). ' +
        'Returns [{name, path, format, gameVersion?, modLoader?}] where format maps Modrinth→mrpack, ' +
        'CurseForge→curseforge, HMCL→hmcl; gameVersion/modLoader are best-effort reads from the pack manifest. ' +
        '`name` is the instance id — pass it as `version` to launch_game.',
      inputSchema: {},
      handler: async () => ok(await scanModpacks(ctx)),
    },
    {
      name: 'launch_game',
      description:
        'Launch a game instance through the agent as an offline account. `version` is an instance id ' +
        '(see list_versions / list_modpacks). username defaults to Steve; maxMemory is the max heap in MB; ' +
        'javaPath overrides the Java used for the game; extraArgs are appended after the default JVM args. ' +
        'The game runs as a separate child process — the game window opens normally.',
      inputSchema: {
        version: z.string().optional(),
        username: z.string().optional(),
        maxMemory: z.number().int().positive().optional(),
        javaPath: z.string().optional(),
        extraArgs: z.array(z.string()).optional(),
      },
      handler: async (input) => {
        const request: LaunchRequest = {};
        if (typeof input.version === 'string' && input.version) request.version = input.version;
        if (typeof input.username === 'string' && input.username) request.username = input.username;
        if (typeof input.maxMemory === 'number') request.maxMemory = input.maxMemory;
        if (typeof input.javaPath === 'string' && input.javaPath) request.javaPath = input.javaPath;
        if (Array.isArray(input.extraArgs)) {
          request.extraArgs = input.extraArgs.filter((arg): arg is string => typeof arg === 'string');
        }
        try {
          const handle = await ensureAgent(ctx);
          return ok(await handle.launch(request));
        } catch (err) {
          return fail(`launch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'stop_game',
      description: 'Stop the currently running game process via the agent (POST /launch/stop).',
      inputSchema: {},
      handler: async () => {
        try {
          const handle = await ensureAgent(ctx);
          const result = await handle.stopLaunch();
          if (!result.ok) return fail(result.error);
          return ok(result.data ?? { stopped: true });
        } catch (err) {
          return fail(`stop_game failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];
}

/** Local helper for check_environment's hmclDir section. */
async function scanHmclDir(ctx: Ctx): Promise<{
  hasHmclJar: boolean;
  hasAgentJar: boolean;
  javafxJars: string[];
}> {
  const [hasHmclJar, hasAgentJar, javafxJars] = await Promise.all([
    pathExists(path.join(ctx.hmclDir, 'HMCL.jar')),
    pathExists(path.join(ctx.hmclDir, 'hmcl-agent.jar')),
    findJavafxJars(ctx),
  ]);
  return { hasHmclJar, hasAgentJar, javafxJars };
}
