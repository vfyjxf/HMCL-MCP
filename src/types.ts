/**
 * Shared contracts for the HMCL MCP server.
 *
 * ARCHITECTURE
 * ------------
 * HMCL has NO command line (no --launch/--import). Heavy lifting is done by
 * HMCL itself: we inject a small javaagent (`agent/`, built by `npm run
 * build:agent`) into a headless HMCL JVM (`java -javaagent:... -Dhmcl.home=...
 * -Dhmcl.dir=... -jar HMCL-3.16.3.jar` — the GUI is never started; the agent's
 * non-daemon HTTP thread keeps the JVM alive). The agent exposes a loopback
 * HTTP JSON API on 127.0.0.1:<port> and calls HMCL core classes directly.
 *
 * The Node server (this repo) is the MCP stdio server. It talks to the agent
 * over HTTP for: version install, modpack file install, game launch/stop.
 * Search/download of modpacks is done by Node directly against Modrinth /
 * CurseForge REST APIs (documented in docs/research/modpack-apis.md);
 * listing versions / modpacks is a local filesystem scan of <workdir>/versions/.
 *
 * Layout (HMCL-compatible, inside our workdir): versions/<id>/, libraries/,
 * assets/, mcpacks/, hmcl/ (HMCL jar + hmcl-agent.jar).
 *
 * Every tool module exports a `createXxxTools(ctx): ToolDef[]` factory; the
 * server (src/server.ts) registers all tools with the MCP SDK. Handlers must
 * NEVER throw for user-level failures — return `{ ok: false, error }` so the
 * server layer converts it into a clean MCP `isError` result.
 */

import { z } from 'zod';

/** Runtime context resolved from the environment (see src/config.ts). */
export interface Ctx {
  /** HMCL working directory (game root + user data root). Default: ~/.hmcl-mcp */
  workdir: string;
  /** Directory that holds HMCL.jar and hmcl-agent.jar. Default: <workdir>/hmcl */
  hmclDir: string;
  /** Java binary for launching HMCL; null means auto-detect (`java` on PATH). */
  javaPath: string | null;
  /** Optional CurseForge API key (env HMCL_MCP_CURSEFORGE_API_KEY). */
  curseforgeApiKey: string | null;
  /** Agent HTTP port on 127.0.0.1 (env HMCL_MCP_AGENT_PORT, default 28501). */
  agentPort: number;
  /** Shared token sent as X-HMCL-Agent-Token header (env HMCL_MCP_AGENT_TOKEN, default 'hmcl-mcp'). */
  agentToken: string;
  /** Log one line to stderr. NEVER log to stdout — it is reserved for JSON-RPC. */
  log(message: string): void;
}

/** A single MCP tool exposed by a module. */
export interface ToolDef {
  /** Tool name, snake_case. */
  name: string;
  /** Human-readable description shown to the agent. */
  description: string;
  /** Zod raw shape accepted by the SDK's registerTool. */
  inputSchema: z.ZodRawShape;
  /** Handler. Must never throw for user-level failures. */
  handler(input: Record<string, unknown>): Promise<ToolResult>;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** Convenience constructors. */
export const ok = (data: unknown): ToolResult => ({ ok: true, data });
export const fail = (error: string): ToolResult => ({ ok: false, error });

/** Modpack sources supported by the modpack module. */
export type ModpackSource = 'modrinth' | 'curseforge';

/** Loader ids supported by the loader tools — all are HMCL VersionList ids. */
export type LoaderId =
  | 'fabric'
  | 'forge'
  | 'neoforge'
  | 'quilt'
  | 'optifine'
  | 'liteloader'
  | 'legacyfabric'
  | 'cleanroom';

/** Input of the install_mod tool / agent POST /mods/install. */
export interface ModInstallRequest {
  source?: ModpackSource;
  /** Mod project id (Modrinth slug / CurseForge numeric id) to download first. */
  id?: string;
  versionId?: string;
  /** Local mod file to install instead of downloading. */
  path?: string;
  /** Target instance id (a version dir under <workdir>/versions/). Required. */
  instance: string;
}

/** Input of the install_loader tool / agent POST /loader/install. */
export interface LoaderInstallRequest {
  loader: LoaderId;
  /** Loader version (selfVersion from list_loader_versions), e.g. "0.16.14". */
  versionId?: string;
  /** Alternative selector: the full version id, e.g. "fabric-loader-0.16.14-1.21.4". */
  fullVersion?: string;
  /** Minecraft version the loader must target (required when creating a new instance). */
  gameVersion?: string;
  /** Install into this existing instance instead of creating a new one. */
  instance?: string;
  /** Name of the new instance (defaults to "<mc>-<loader>"). */
  name?: string;
}

/** Normalized modpack summary returned by search / get tools. */
export interface ModpackSummary {
  source: ModpackSource;
  /** Project id: Modrinth slug / CurseForge numeric id. */
  id: string;
  title: string;
  description: string;
  authors: string[];
  /** Available version numbers (as reported by the source). */
  versions: string[];
  url?: string;
}

/** A downloadable modpack version. */
export interface ModpackVersion {
  id: string;
  version: string;
  gameVersions: string[];
  url: string;
  filename: string;
  size: number;
  sha1?: string;
}

/** Installed modpack entry (a game instance under <workdir>/versions/<name>/). */
export interface InstalledModpack {
  name: string;
  path: string;
  format: 'mrpack' | 'curseforge' | 'hmcl';
  gameVersion?: string;
  modLoader?: string;
}

/**
 * CROSS-MODULE CONTRACTS
 *
 * src/hmcl-client.ts (owned by the node-client module) exports:
 *   ensureAgent(ctx): Promise<AgentHandle>   // start HMCL headless if not running; wait for /status
 *   interface AgentHandle {
 *     status(): Promise<AgentStatus>                       // GET /status
 *     installVersion(mcVersion: string): Promise<AgentResult>  // POST /versions/install
 *     installModpack(path: string, name?: string): Promise<AgentResult> // POST /modpack/install
 *     launch(req: LaunchRequest): Promise<LaunchInfo>          // POST /launch
 *     stopLaunch(): Promise<AgentResult>                      // POST /launch/stop
 *     close(): void
 *   }
 * The agent HTTP protocol is documented in agent/README.md.
 *
 * AgentResult = { ok: true; data?: unknown } | { ok: false; error: string }.
 */
export interface AgentHandle {
  /** GET /status. Throws on transport/agent errors. */
  status(): Promise<AgentStatus>;
  /** POST /versions/install. Never throws for user-level failures. */
  installVersion(mcVersion: string): Promise<AgentResult>;
  /** POST /modpack/install. Never throws for user-level failures. */
  installModpack(path: string, name?: string): Promise<AgentResult>;
  /** POST /modpack/search (HMCL-native repository, CurseForge uses HMCL's embedded key). Never throws. */
  searchModpacks(source: ModpackSource, query: string, limit?: number): Promise<AgentResult>;
  /** POST /modpack/info. Never throws for user-level failures. */
  getModpack(source: ModpackSource, id: string): Promise<AgentResult>;
  /** POST /modpack/download — HMCL downloads the pack file (sha1-verified) into <workdir>/mcpacks/. Never throws. */
  downloadModpack(source: ModpackSource, id: string, versionId?: string): Promise<AgentResult>;
  /** POST /mods/search (HMCL MODS repositories, CurseForge uses HMCL's embedded key). Never throws. */
  searchMods(source: ModpackSource, query: string, gameVersion?: string, limit?: number): Promise<AgentResult>;
  /** POST /mods/info. Never throws. */
  getMod(source: ModpackSource, id: string): Promise<AgentResult>;
  /** POST /mods/download — HMCL downloads the mod file (sha1-verified) into <workdir>/modfiles/. Never throws. */
  downloadMod(source: ModpackSource, id: string, versionId?: string): Promise<AgentResult>;
  /** POST /mods/install — download (or reuse a local path) and place the mod into <instance>/mods/. Never throws. */
  installMod(req: ModInstallRequest): Promise<AgentResult>;
  /** POST /mods/list — list the .jar files of <instance>/mods/. Never throws. */
  listMods(instance: string): Promise<AgentResult>;
  /** POST /loaders/list — loader versions available for a Minecraft version. Never throws. */
  listLoaderVersions(loader: LoaderId, gameVersion: string): Promise<AgentResult>;
  /** POST /loader/install — install a loader into an existing instance or as a new instance. Never throws. */
  installLoader(req: LoaderInstallRequest): Promise<AgentResult>;
  /** POST /versions/remote — installable Minecraft versions from the remote list. Never throws. */
  listRemoteVersions(type?: 'release' | 'snapshot' | 'all'): Promise<AgentResult>;
  /** POST /launch. Throws on transport/agent errors. */
  launch(req: LaunchRequest): Promise<LaunchInfo>;
  /** POST /launch/stop. Never throws for user-level failures. */
  stopLaunch(): Promise<AgentResult>;
  /** Release local resources. Does NOT stop the agent JVM. */
  close(): void;
}

export type AgentResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

export interface AgentStatus {
  hmclVersion: string;
  workdir: string;
  java: string;
  versions: string[];
  running: boolean;
  gamePid?: number | null;
}

/** Input of the launch_game tool. */
export interface LaunchRequest {
  /** Instance id to launch (a version dir name under <workdir>/versions/). */
  version?: string;
  /** Offline player name (default 'Steve'). */
  username?: string;
  /** Max heap in MB. */
  maxMemory?: number;
  /** Java binary override. */
  javaPath?: string;
  /** Extra JVM args appended after the defaults. */
  extraArgs?: string[];
}

export interface LaunchInfo {
  pid: number;
  instanceId: string;
  gameVersion: string;
  loader?: string;
  java: string;
  logPath?: string;
}

/**
 * FULL TOOL SET (docs agent: keep README's tool table in sync):
 *  check_environment            — java/HMCL jar/agent jar/workdir/versions summary
 *  install_hmcl                 — download HMCL jar (and build agent jar if missing) into <workdir>/hmcl/
 *  start_hmcl                   — spawn HMCL headless with -javaagent; wait for agent /status
 *  stop_hmcl                    — stop the headless HMCL JVM (agent /shutdown)
 *  list_versions                — scan <workdir>/versions/ for <id>/<id>.json
 *  install_version              — agent: install a vanilla Minecraft version (HMCL download pipeline)
 *  search_modpacks              — Modrinth / CurseForge REST search
 *  get_modpack                  — project + latest version details
 *  download_modpack             — download the pack file into <workdir>/mcpacks/ (sha1 verified)
 *  install_modpack              — download (if id given) then agent-install the file into an instance
 *  list_modpacks                — scan <workdir>/versions/<id>/modpack.json
 *  search_mods                  — HMCL MODS repositories search (Modrinth / CurseForge)
 *  get_mod                      — mod project + version details
 *  download_mod                 — download a mod file into <workdir>/modfiles/ (sha1 verified)
 *  install_mod                  — download (or local path) + place the file into <instance>/mods/
 *  list_mods                    — list the .jar files of <instance>/mods/
 *  list_loader_versions         — loader versions (fabric/forge/neoforge/quilt/...) for a MC version
 *  install_loader               — install a loader into an existing instance or as a new instance
 *  list_remote_versions         — installable Minecraft versions from the remote list
 *  launch_game                  — agent: launch instance (offline account) as child process
 *  stop_game                    — agent: stop the running game process
 */
