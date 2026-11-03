/**
 * Client for the HMCL javaagent HTTP API (see types.ts "CROSS-MODULE CONTRACTS"
 * and agent/README.md for the protocol).
 *
 * `ensureAgent(ctx)` checks whether an agent is already answering on
 * 127.0.0.1:<port>; if not, it spawns a headless HMCL JVM with the
 * `-javaagent` and waits up to 60s for `/status` to respond. The agent's
 * non-daemon HTTP thread keeps the JVM alive, so it persists across MCP server
 * restarts until `stop_hmcl` (POST /shutdown) is called.
 *
 * Failure policy:
 *  - `ensureAgent` throws with a clear, fix-oriented message when the agent
 *    cannot be started (missing jars / java, startup timeout, token mismatch).
 *  - `status()` / `launch()` return `AgentStatus` / `LaunchInfo` and throw on
 *    transport or agent errors — their return types carry no error variant.
 *  - `installVersion` / `installModpack` / `stopLaunch` never throw for
 *    user-level failures: agent-reported or transport errors are returned as
 *    `{ ok: false, error }`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import path from 'node:path';
import type {
  AgentHandle,
  AgentResult,
  AgentStatus,
  Ctx,
  LaunchInfo,
  LaunchRequest,
  LoaderInstallRequest,
  ModInstallRequest,
  ModpackSource,
} from './types.js';

const PING_TIMEOUT_MS = 1_000; // probe whether an agent is already running
const READY_TIMEOUT_MS = 60_000; // max wait for the freshly spawned agent
const READY_POLL_MS = 500;
const INSTALL_TIMEOUT_MS = 1_800_000; // version/modpack installs are slow (can exceed 10 min on bmclapi)
const LAUNCH_TIMEOUT_MS = 900_000; // pre-launch completion check may download libraries/assets
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Module-level lock so concurrent ensureAgent() calls share one spawn. */
let pendingEnsure: Promise<AgentHandle> | null = null;

/** Start the headless HMCL agent if none is responding, then return a client. */
export function ensureAgent(ctx: Ctx): Promise<AgentHandle> {
  if (!pendingEnsure) {
    pendingEnsure = doEnsureAgent(ctx).finally(() => {
      pendingEnsure = null;
    });
  }
  return pendingEnsure;
}

/** GET /status with the token header; null on any network error/timeout. */
async function probeStatus(ctx: Ctx, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${ctx.agentPort}/status`, {
      headers: { 'X-HMCL-Agent-Token': ctx.agentToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // connection refused / timeout / DNS — treat as "not running"
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}

/** Validate a /status response; throws with a fix-oriented message on failure. */
async function assertHealthyStatus(res: Response, ctx: Ctx): Promise<void> {
  if (res.ok) return;
  const body = await safeText(res);
  if (res.status === 403) {
    throw new Error(
      `agent on 127.0.0.1:${ctx.agentPort} rejected X-HMCL-Agent-Token — ` +
        `HMCL_MCP_AGENT_TOKEN does not match the running agent (or a stale agent is running with a different token).`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `agent on 127.0.0.1:${ctx.agentPort} responded but has no /status endpoint — ` +
        `the agent jar version does not match this server. Re-run install_hmcl.`,
    );
  }
  throw new Error(
    `agent error: HTTP ${res.status}${body ? `: ${body}` : ''} (127.0.0.1:${ctx.agentPort})`,
  );
}

/** Find javafx-base/graphics jars in hmclDir; returns them (or null if unusable). */
function findJavafxJars(hmclDir: string): string[] | null {
  let entries: string[];
  try {
    entries = readdirSync(hmclDir);
  } catch {
    return null;
  }
  const javafx = entries
    .filter((f) => /^javafx-.+-win\.jar$/.test(f))
    .map((f) => path.join(hmclDir, f))
    .sort();
  const hasBase = javafx.some((f) => path.basename(f).startsWith('javafx-base-'));
  const hasGraphics = javafx.some((f) => path.basename(f).startsWith('javafx-graphics-'));
  return hasBase && hasGraphics ? javafx : null;
}

async function doEnsureAgent(ctx: Ctx): Promise<AgentHandle> {
  // 1) Already running?
  const probe = await probeStatus(ctx, PING_TIMEOUT_MS);
  if (probe) {
    await assertHealthyStatus(probe, ctx);
    ctx.log(`agent already running on 127.0.0.1:${ctx.agentPort}`);
    return new AgentClient(ctx);
  }

  // 2) Required files present?
  const hmclJar = path.join(ctx.hmclDir, 'HMCL.jar');
  const agentJar = path.join(ctx.hmclDir, 'hmcl-agent.jar');
  const missing: string[] = [];
  if (!existsSync(hmclJar)) missing.push(`HMCL.jar (${hmclJar})`);
  if (!existsSync(agentJar)) missing.push(`hmcl-agent.jar (${agentJar})`);
  if (missing.length > 0) {
    throw new Error(
      `missing ${missing.join(' and ')} in ${ctx.hmclDir} — ` +
        `run the install_hmcl tool first (it downloads HMCL.jar and builds hmcl-agent.jar).`,
    );
  }
  const javafxJars = findJavafxJars(ctx.hmclDir);
  if (!javafxJars) {
    throw new Error(
      `no javafx-base-*-win.jar / javafx-graphics-*-win.jar found in ${ctx.hmclDir} — ` +
        `install_hmcl should have placed them there; HMCL cannot start without JavaFX on the classpath.`,
    );
  }

  // 3) Spawn the headless HMCL JVM.
  mkdirSync(ctx.hmclDir, { recursive: true });
  const logPath = path.join(ctx.hmclDir, 'hmcl.log');
  // Raw fd (not a stream): spawn() rejects streams whose fd is still null,
  // and a raw fd is inherited by the child without buffering surprises.
  const logFd = openSync(logPath, 'a');
  let logClosed = false;
  const closeLog = (): void => {
    if (!logClosed) {
      logClosed = true;
      try {
        closeSync(logFd);
      } catch {
        // already closed
      }
    }
  };
  const classpath = [hmclJar, ...javafxJars].join(path.delimiter); // ';' on win32, ':' elsewhere
  const java = ctx.javaPath ?? 'java';
  const args = [
    // The agent JVM is headless (no launcher UI, no game heap); a small explicit
    // heap keeps the default G1 reservation from exhausting small Windows page
    // files ("os::commit_memory failed; 页面文件太小" crashes were observed).
    '-Xmx512m',
    '-Xms64m',
    `-javaagent:${agentJar}`,
    `-Dhmcl.agent.port=${ctx.agentPort}`,
    `-Dhmcl.agent.token=${ctx.agentToken}`,
    `-Dhmcl.gameDir=${ctx.workdir}`,
    `-Dhmcl.home=${ctx.workdir}`,
    `-Dhmcl.dir=${ctx.workdir}`,
    ...(ctx.curseforgeApiKey
      ? [`-Dhmcl.curseforge.apikey=${ctx.curseforgeApiKey}`]
      : []),
    '-cp',
    classpath,
    'hmcl.agent.AgentMain',
  ];
  let proc: ChildProcess;
  try {
    proc = spawn(java, args, { windowsHide: true, stdio: ['ignore', logFd, logFd] });
  } catch (err) {
    closeLog();
    throw new Error(
      `failed to spawn java ('${java}'): ${(err as Error).message} — ` +
        `install JDK 21 or set HMCL_MCP_JAVA to a valid java executable.`,
    );
  }
  let spawnError: Error | null = null as Error | null;
  proc.once('error', (err) => {
    spawnError = err;
    closeLog();
  });
  proc.once('exit', closeLog);
  ctx.log(`spawned headless HMCL: java='${java}' port=${ctx.agentPort} log=${logPath}`);

  // 4) Wait for /status to answer (up to 60s, polling every 500ms).
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // TS cannot see the callback assignment for narrowing, so read the
    // declared type explicitly instead of relying on the closure capture.
    const spawnErr = spawnError as Error | null;
    if (spawnErr) {
      throw new Error(
        `failed to start java ('${java}'): ${spawnErr.message} — ` +
          `install JDK 21 or set HMCL_MCP_JAVA to a valid java executable.`,
      );
    }
    if (proc.exitCode !== null) {
      throw new Error(
        `HMCL agent exited during startup (exit code ${proc.exitCode}) — check the log: ${logPath}`,
      );
    }
    const res = await probeStatus(ctx, 1_500);
    if (res) {
      await assertHealthyStatus(res, ctx);
      ctx.log(`HMCL agent ready on 127.0.0.1:${ctx.agentPort}`);
      return new AgentClient(ctx);
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(
    `HMCL agent did not become ready within ${READY_TIMEOUT_MS / 1000}s — check the log: ${logPath}`,
  );
}

/** Marker error used internally to distinguish our own timeout from transport failures. */
const TIMEOUT_MARKER = 'agent request timed out (internal marker)';

/**
 * Loopback HTTP JSON request via node:http. NOT fetch/undici: undici's default
 * 300 s headers/body timeout kills long synchronous agent operations (version
 * install, modpack install, launch pre-check) before the agent can answer, and
 * surfaces as a misleading "fetch failed". Here the only timeout is `timeoutMs`
 * (plus the AbortSignal-free socket timeout set on the request).
 */
function httpJson(
  ctx: Ctx,
  method: 'GET' | 'POST',
  apiPath: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: ctx.agentPort,
        path: apiPath,
        method,
        headers: {
          'X-HMCL-Agent-Token': ctx.agentToken,
          'Content-Type': 'application/json',
          ...(payload !== null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          let data: unknown = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text; // non-JSON body — surfaced as an error by the caller
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
        res.on('error', (err) => {
          reject(
            new Error(`agent not reachable at 127.0.0.1:${ctx.agentPort}${apiPath}: ${err.message}`),
          );
        });
      },
    );
    req.on('timeout', () => {
      // Destroy with the marker so the 'error' handler can report a precise message.
      req.destroy(new Error(TIMEOUT_MARKER));
    });
    req.on('error', (err) => {
      if (err.message === TIMEOUT_MARKER) {
        reject(
          new Error(
            `agent request at 127.0.0.1:${ctx.agentPort}${apiPath} timed out after ` +
              `${Math.round(timeoutMs / 1000)}s — a long agent operation (version/modpack install, ` +
              'launch pre-check) may still be running in the background; re-check with ' +
              'list_versions / check_environment before retrying',
          ),
        );
        return;
      }
      reject(new Error(`agent not reachable at 127.0.0.1:${ctx.agentPort}${apiPath}: ${err.message}`));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Validate an agent HTTP status (node:http path); throws fix-oriented errors. */
function assertStatus(status: number, data: unknown, apiPath: string, ctx: Ctx): void {
  if (status >= 200 && status < 300) return;
  if (status === 403) {
    throw new Error(
      `agent on 127.0.0.1:${ctx.agentPort} rejected X-HMCL-Agent-Token — ` +
        `HMCL_MCP_AGENT_TOKEN does not match the running agent (or a stale agent is running with a different token).`,
    );
  }
  if (status === 404) {
    throw new Error(
      `agent on 127.0.0.1:${ctx.agentPort} responded 404 for ${apiPath} — ` +
        `the agent jar version does not match this server. Re-run install_hmcl.`,
    );
  }
  const detail = typeof data === 'string' && data ? `: ${data.slice(0, 300)}` : '';
  throw new Error(`agent error: HTTP ${status}${detail} (127.0.0.1:${ctx.agentPort})`);
}

/** HTTP JSON client for a running agent. */
class AgentClient implements AgentHandle {
  constructor(private readonly ctx: Ctx) {}

  /** GET and return parsed JSON. Throws on transport/protocol errors. */
  private async get<T>(apiPath: string, timeoutMs: number): Promise<T> {
    const { status, data } = await httpJson(this.ctx, 'GET', apiPath, undefined, timeoutMs);
    assertStatus(status, data, apiPath, this.ctx);
    return this.unwrapData<T>(data);
  }

  /**
   * POST a JSON body and unwrap the agent's `{"ok":true, ...payload}` response.
   * Throws on transport errors, 403/5xx, `{ok:false,error}` and unexpected shapes.
   */
  private async post<T>(apiPath: string, body: unknown, timeoutMs: number): Promise<T> {
    const { status, data } = await httpJson(this.ctx, 'POST', apiPath, body, timeoutMs);
    assertStatus(status, data, apiPath, this.ctx);
    return this.unwrapData<T>(data);
  }

  /** Reject `{ok:false,error}` envelopes and unexpected shapes; return the payload object as-is. */
  private unwrapData<T>(data: unknown): T {
    if (isAgentError(data)) {
      throw new Error(`agent error: ${data.error}`);
    }
    if (typeof data !== 'object' || data === null || (data as { ok?: unknown }).ok !== true) {
      throw new Error(`agent error: unexpected response: ${JSON.stringify(data)}`);
    }
    // The agent's envelope is flat ({ok:true, ...payload}); drop the `ok` marker
    // so callers get clean payloads (LaunchInfo / AgentResult.data).
    delete (data as { ok?: unknown }).ok;
    return data as T;
  }

  /** Run an operation, converting every failure into `{ ok: false, error }`. */
  private async asResult<T>(op: () => Promise<T>): Promise<AgentResult> {
    try {
      return { ok: true, data: await op() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async status(): Promise<AgentStatus> {
    return this.get<AgentStatus>('/status', DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async installVersion(mcVersion: string): Promise<AgentResult> {
    // The agent's protocol field is `version` (see agent/src/hmcl/agent/HttpApi.java).
    return this.asResult(() => this.post('/versions/install', { version: mcVersion }, INSTALL_TIMEOUT_MS));
  }

  async installModpack(path: string, name?: string): Promise<AgentResult> {
    const body = name ? { path, name } : { path };
    return this.asResult(() => this.post('/modpack/install', body, INSTALL_TIMEOUT_MS));
  }

  async searchModpacks(source: ModpackSource, query: string, limit?: number): Promise<AgentResult> {
    return this.asResult(() => this.post('/modpack/search', { source, query, limit }, 60_000));
  }

  async getModpack(source: ModpackSource, id: string): Promise<AgentResult> {
    return this.asResult(() => this.post('/modpack/info', { source, id }, 60_000));
  }

  async downloadModpack(source: ModpackSource, id: string, versionId?: string): Promise<AgentResult> {
    const body = versionId ? { source, id, versionId } : { source, id };
    return this.asResult(() => this.post('/modpack/download', body, INSTALL_TIMEOUT_MS));
  }

  async searchMods(
    source: ModpackSource,
    query: string,
    gameVersion?: string,
    limit?: number,
  ): Promise<AgentResult> {
    const body: Record<string, unknown> = { source, query };
    if (gameVersion) body.gameVersion = gameVersion;
    if (typeof limit === 'number' && Number.isFinite(limit)) body.limit = limit;
    return this.asResult(() => this.post('/mods/search', body, 60_000));
  }

  async getMod(source: ModpackSource, id: string): Promise<AgentResult> {
    return this.asResult(() => this.post('/mods/info', { source, id }, 60_000));
  }

  async downloadMod(source: ModpackSource, id: string, versionId?: string): Promise<AgentResult> {
    const body = versionId ? { source, id, versionId } : { source, id };
    return this.asResult(() => this.post('/mods/download', body, INSTALL_TIMEOUT_MS));
  }

  async installMod(req: ModInstallRequest): Promise<AgentResult> {
    return this.asResult(() => this.post('/mods/install', req, INSTALL_TIMEOUT_MS));
  }

  async listMods(instance: string): Promise<AgentResult> {
    return this.asResult(() => this.post('/mods/list', { instance }, DEFAULT_REQUEST_TIMEOUT_MS));
  }

  async listLoaderVersions(loader: LoaderInstallRequest['loader'], gameVersion: string): Promise<AgentResult> {
    return this.asResult(() => this.post('/loaders/list', { loader, gameVersion }, 120_000));
  }

  async installLoader(req: LoaderInstallRequest): Promise<AgentResult> {
    return this.asResult(() => this.post('/loader/install', req, INSTALL_TIMEOUT_MS));
  }

  async listRemoteVersions(type?: 'release' | 'snapshot' | 'all'): Promise<AgentResult> {
    const body = type && type !== 'all' ? { type } : {};
    return this.asResult(() => this.post('/versions/remote', body, 120_000));
  }

  async launch(req: LaunchRequest): Promise<LaunchInfo> {
    return this.post<LaunchInfo>('/launch', req, LAUNCH_TIMEOUT_MS);
  }

  async stopLaunch(): Promise<AgentResult> {
    return this.asResult(() => this.post('/launch/stop', {}, DEFAULT_REQUEST_TIMEOUT_MS));
  }

  /** Release local resources. Deliberately does NOT stop the agent JVM — it is
   * shared and persists; use stop_hmcl (POST /shutdown) to stop it. */
  close(): void {}
}

function isAgentError(data: unknown): data is { ok: false; error: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { ok?: unknown }).ok === false &&
    typeof (data as { error?: unknown }).error === 'string'
  );
}
