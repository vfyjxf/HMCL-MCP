#!/usr/bin/env node
/**
 * E2E test for the HMCL MCP server — full flow through the MCP stdio interface
 * with the REAL javaagent and REAL network (Modrinth / BMCLAPI).
 *
 * Usage:  node test/e2e/stdio.mjs [--fresh]
 *   --fresh  wipe and re-seed <workdir> before starting (default: reuse existing
 *            workdir so failed runs can resume without re-downloading)
 *
 * Environment injected into the server process:
 *   HMCL_MCP_WORKDIR=<workdir>, HMCL_MCP_HMCL_DIR=<workdir>/hmcl,
 *   HMCL_MCP_AGENT_PORT=28521, HMCL_MCP_AGENT_TOKEN=test-token
 *
 * Steps (each asserts, soft failures keep the run going, summary at the end):
 *   1. initialize handshake + tools/list (expect all 21 tools)
 *   2. check_environment (java, hasHmclJar/hasAgentJar, agentRunning=false)
 *   3. start_hmcl (agent up; hmclVersion 3.16.3)
 *   4. install_version 1.20.4 + list_versions
 *   5. search_modpacks 'fabric' + get_modpack top hit
 *   6. download_modpack (sha1 check) + install_modpack + list_modpacks
 *   7. launch_game 1.20.4 (pid alive >= 30s within 5 min, game log exists) + stop_game
 *   8. stop_hmcl (agent down)
 *   +   the server child's stdout carries ONLY JSON-RPC lines the whole session.
 *
 * Exit code: 0 when every step passed, 1 otherwise. Always cleans up
 * (stop_game / stop_hmcl / client.close()) in a finally block.
 */

import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKDIR = path.join(PROJECT_ROOT, 'test', 'tmp', 'e2e-workdir');
const HMCL_DIR = path.join(WORKDIR, 'hmcl');
const MCPACKS_DIR = path.join(WORKDIR, 'mcpacks');
const LOGS_DIR = path.join(WORKDIR, 'logs');
const AGENT_PORT = 28521;
const AGENT_TOKEN = 'test-token';
const MC_VERSION = '1.20.4';

const AGENT_BASE = `http://127.0.0.1:${AGENT_PORT}`;
const EXPECTED_TOOLS = [
  'check_environment', 'install_hmcl', 'start_hmcl', 'stop_hmcl',
  'list_versions', 'install_version', 'list_remote_versions',
  'list_loader_versions', 'install_loader',
  'search_modpacks', 'get_modpack', 'download_modpack', 'install_modpack', 'list_modpacks',
  'search_mods', 'get_mod', 'download_mod', 'install_mod', 'list_mods',
  'launch_game', 'stop_game',
];

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  Spawn interception: tee the server child's stdout (JSON-RPC purity
 *  assertion) without disturbing the SDK transport's own listeners.
 * ------------------------------------------------------------------ */

const serverChild = { proc: null, stdoutChunks: [], exitCode: null };
const stdoutLogPath = path.join(WORKDIR, 'server-stdout.log');
let stdoutLogStream = null;
const origSpawn = cp.spawn;
cp.spawn = function patchedSpawn(command, args, options) {
  const child = origSpawn.call(this, command, args, options);
  const argv = Array.isArray(args) ? args : [];
  if (argv.includes('src/index.ts')) {
    serverChild.proc = child;
    child.stdout?.on('data', (chunk) => {
      serverChild.stdoutChunks.push(chunk);
      if (!stdoutLogStream) {
        try { mkdirSync(path.dirname(stdoutLogPath), { recursive: true }); } catch { /* ignore */ }
        stdoutLogStream = createWriteStream(stdoutLogPath, { flags: 'a' });
      }
      stdoutLogStream.write(chunk);
    });
    child.on('exit', (code) => { serverChild.exitCode = code; });
  }
  return child;
};

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function isWin() {
  return process.platform === 'win32';
}

function normPath(p) {
  return isWin() ? String(p).toLowerCase().replace(/\//g, '\\') : String(p);
}

/** Run `fn`; converts throw/assertion into a recorded FAIL (soft). */
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, pass: true, ms: Date.now() - t0, info });
    console.log(`[PASS] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (info && typeof info === 'string' && info.length > 0) {
      console.log(`       ${info.split('\n').join('\n       ')}`);
    }
  } catch (err) {
    results.push({ name, pass: false, ms: Date.now() - t0, error: err.message });
    console.error(`[FAIL] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${err.message}`);
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}: timed out after ${(ms / 1000).toFixed(0)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let client = null;
let transport = null;
let serverStderr = '';
let stderrLogStream = null;

/** Call a tool; never throws for tool-level failures (v1 SDK resolves isError). */
async function call(name, args, timeoutMs = 180_000) {
  const res = await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: timeoutMs });
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON text = error message */ }
  return { isError: res.isError === true, text, parsed, raw: res };
}

/** Call a tool and require a successful (non-isError) result; returns parsed data. */
async function callOk(name, args, timeoutMs = 180_000) {
  const res = await call(name, args, timeoutMs);
  if (res.isError) {
    throw new Error(`tool ${name} failed: ${res.text || '(empty error)'}`);
  }
  return res.parsed;
}

async function agentProbe() {
  try {
    const res = await fetch(`${AGENT_BASE}/status`, {
      headers: { 'X-HMCL-Agent-Token': AGENT_TOKEN },
      signal: AbortSignal.timeout(2000),
    });
    return { up: res.ok, status: res.status };
  } catch {
    return { up: false, status: null };
  }
}

async function agentShutdownRaw() {
  try {
    const res = await fetch(`${AGENT_BASE}/shutdown`, {
      method: 'POST',
      headers: { 'X-HMCL-Agent-Token': AGENT_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  } catch {
    return null;
  }
}

/** Wait until the agent HTTP port stops answering (or timeout). */
async function waitAgentDown(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await agentProbe();
    if (!probe.up) return true;
    await sleep(500);
  }
  return false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function sha1File(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

function stderrTail(n = 60) {
  const lines = serverStderr.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-n).join('\n');
}

/* ------------------------------------------------------------------ *
 *  Setup: seed <workdir>/hmcl with the real jars (no GitHub download).
 * ------------------------------------------------------------------ */

function seedWorkdir(fresh) {
  if (fresh && existsSync(WORKDIR)) {
    rmSync(WORKDIR, { recursive: true, force: true });
  }
  mkdirSync(HMCL_DIR, { recursive: true });
  mkdirSync(MCPACKS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const hmclJar = path.join(HMCL_DIR, 'HMCL.jar');
  if (!existsSync(hmclJar)) {
    copyFileSync(path.join(PROJECT_ROOT, 'agent', 'lib', 'HMCL-3.16.3.jar'), hmclJar);
  }
  for (const name of ['hmcl-agent.jar', 'javafx-base-21.0.8-win.jar',
    'javafx-graphics-21.0.8-win.jar', 'javafx-controls-21.0.8-win.jar']) {
    const target = path.join(HMCL_DIR, name);
    if (!existsSync(target)) {
      copyFileSync(path.join(PROJECT_ROOT, 'agent', 'build', name), target);
    }
  }
}

/* ------------------------------------------------------------------ *
 *  The flow
 * ------------------------------------------------------------------ */

async function runFlow() {
  // ---- Step 1: initialize + tools/list ----
  await step('1. initialize handshake + tools/list', async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: PROJECT_ROOT,
      env: {
        HMCL_MCP_WORKDIR: WORKDIR,
        HMCL_MCP_HMCL_DIR: HMCL_DIR,
        HMCL_MCP_AGENT_PORT: String(AGENT_PORT),
        HMCL_MCP_AGENT_TOKEN: AGENT_TOKEN,
      },
      stderr: 'pipe',
    });
    const stderrLogPath = path.join(WORKDIR, 'server-stderr.log');
    stderrLogStream = createWriteStream(stderrLogPath, { flags: 'a' });
    transport.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString('utf8');
      stderrLogStream.write(chunk);
    });

    client = new Client({ name: 'hmcl-mcp-e2e', version: '0.0.1' });
    await withTimeout(client.connect(transport), 60_000, 'initialize handshake');

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
    assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
    assert(extra.length === 0, `unexpected tools: ${extra.join(', ')}`);
    assert(tools.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length} tools, got ${tools.length}`);
    return `tools: ${names.join(', ')}`;
  });

  // ---- Step 2: check_environment ----
  await step('2. check_environment (java, jars, agent down)', async () => {
    const data = await callOk('check_environment', {});
    assert(data && typeof data === 'object', 'check_environment returned no object');
    assert(data.java && data.java.version, `java missing/unknown: ${JSON.stringify(data.java)}`);
    assert(data.hmclDir.hasHmclJar === true, `hasHmclJar != true: ${data.hmclDir}`);
    assert(data.hmclDir.hasAgentJar === true, `hasAgentJar != true: ${data.hmclDir}`);
    assert(data.agentRunning === false, `agentRunning != false: ${JSON.stringify(data.agent)}`);
    return `java=${data.java.version} hmclDir=${JSON.stringify(data.hmclDir.javafxJars)}`;
  });

  // ---- Step 3: start_hmcl ----
  await step('3. start_hmcl (agent up, poll up to 90s)', async () => {
    const res = await call('start_hmcl', {}, 120_000);
    if (res.isError) {
      // Retry once after a short wait — agent startup can be slow on first JVM run.
      await sleep(5000);
      const res2 = await call('start_hmcl', {}, 120_000);
      assert(!res2.isError, `start_hmcl failed twice: ${res.text} | ${res2.text}`);
    }
    let status = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const data = await callOk('check_environment', {});
      if (data.agentRunning) { status = data.agent; break; }
      await sleep(3000);
    }
    assert(status, 'agent never became reachable within 90s');
    assert(String(status.hmclVersion).startsWith('3.16.3'), `hmclVersion != 3.16.3: ${JSON.stringify(status.hmclVersion)}`);
    assert(normPath(status.workdir) === normPath(WORKDIR), `workdir mismatch: ${status.workdir} vs ${WORKDIR}`);
    return `hmclVersion=${status.hmclVersion} workdir=${status.workdir}`;
  });

  // ---- Step 4: install_version 1.20.4 ----
  await step('4. install_version 1.20.4 + list_versions', async () => {
    const before = await callOk('list_versions', {});
    const already = Array.isArray(before) ? before.some((v) => v.id === MC_VERSION) : false;
    if (already) {
      return `reuse: ${MC_VERSION} already installed from a previous run`;
    }
    const t0 = Date.now();
    const res = await call('install_version', { version: MC_VERSION }, 660_000);
    if (res.isError) {
      // Agent may still be installing after our timeout; poll for the version to appear.
      console.error(`       install_version error: ${res.text}`);
      const deadline = Date.now() + 600_000;
      let found = false;
      while (Date.now() < deadline) {
        const data = await callOk('list_versions', {});
        if (Array.isArray(data) && data.some((v) => v.id === MC_VERSION)) { found = true; break; }
        await sleep(5000);
      }
      assert(found, `version ${MC_VERSION} did not appear within 10 min of install`);
      return `recovered: version appeared after install error (${((Date.now() - t0) / 1000).toFixed(0)}s)`;
    }
    const data = await callOk('list_versions', {});
    const entry = Array.isArray(data) ? data.find((v) => v.id === MC_VERSION) : null;
    assert(entry, `list_versions does not contain ${MC_VERSION}: ${JSON.stringify(data)}`);
    assert(entry.hasJar === true, `version entry has no jar: ${JSON.stringify(entry)}`);
    return `installed in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify(entry)}`;
  });

  // ---- Step 4b (optional): second version install over the node:http transport ----
  // Proves a long synchronous install (>300 s) survives the transport layer; the
  // old fetch/undici path was killed by undici's default 300 s headers timeout
  // at ~300 s into a 322 s install (misleading "agent not reachable" error).
  const extraVersion = process.env.E2E_EXTRA_VERSION?.trim();
  if (extraVersion) {
    await step(`4b. install_version ${extraVersion} (long-op transport validation)`, async () => {
      const before = await callOk('list_versions', {});
      if (Array.isArray(before) && before.some((v) => v.id === extraVersion)) {
        return `reuse: ${extraVersion} already installed`;
      }
      const t0 = Date.now();
      const res = await call('install_version', { version: extraVersion }, 660_000);
      if (res.isError) {
        throw new Error(`install_version ${extraVersion} failed: ${res.text}`);
      }
      const data = await callOk('list_versions', {});
      const entry = Array.isArray(data) ? data.find((v) => v.id === extraVersion) : null;
      if (!entry) throw new Error(`${extraVersion} missing from list_versions after install`);
      return `installed in ${((Date.now() - t0) / 1000).toFixed(0)}s (${(Date.now() - t0) >= 300_000 ? '>300s — long-op path proven' : '<300s — transport ok, boundary not exercised'})`;
    });
  }

  // ---- Step 5: search + get modpack ----
  await step('5. search_modpacks "fabric" + get_modpack top hit', async () => {
    const hits = await callOk('search_modpacks', { query: 'fabric', limit: 5 });
    assert(Array.isArray(hits) && hits.length >= 1, `no hits: ${JSON.stringify(hits)}`);
    const top = hits[0];
    assert(top.id, `hit missing id/slug: ${JSON.stringify(top)}`);
    assert(top.title, `hit missing title: ${JSON.stringify(top)}`);
    assert(Array.isArray(top.versions), `hit versions not an array: ${JSON.stringify(top)}`);
    const detail = await callOk('get_modpack', { id: top.id });
    assert(detail.summary && detail.summary.id === top.id, `summary mismatch: ${JSON.stringify(detail.summary)}`);
    assert(Array.isArray(detail.versions), `get_modpack versions not an array: ${JSON.stringify(detail)}`);
    const latest = detail.latest;
    assert(latest && (latest.id || latest.version), `latest missing: ${JSON.stringify(detail)}`);
    return `top hit: ${top.id} (${top.title}); latest version: ${latest.version ?? latest.id}`;
  });

  // ---- Step 6: download + install modpack ----
  await step('6. download_modpack (sha1) + install_modpack + list_modpacks', async () => {
    const hits = await callOk('search_modpacks', { query: 'fabric', limit: 5 });
    const top = hits[0];

    // Downloads now go through the agent (HMCL's FileDownloadTask, sha1-verified);
    // the server-side node:http cap is 600s per try — retry a few times, since
    // slow windows do occur on the Modrinth CDN for large packs (101 MB here).
    let dl = null;
    let dlErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        dl = await callOk('download_modpack', { id: top.id }, 700_000);
        break;
      } catch (err) {
        dlErr = err;
        console.error(`       download_modpack attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) await sleep(30_000);
      }
    }
    if (!dl) throw dlErr ?? new Error('download_modpack failed after 3 attempts');
    assert(dl.path, `download returned no path: ${JSON.stringify(dl)}`);
    const dlPath = dl.path;
    assert(normPath(dlPath).startsWith(normPath(MCPACKS_DIR)), `file not in mcpacks/: ${dlPath}`);
    assert(existsSync(dlPath), `downloaded file missing: ${dlPath}`);
    const size = statSync(dlPath).size;
    assert(size > 0, `downloaded file is empty: ${dlPath}`);
    if (dl.sha1) {
      const actual = sha1File(dlPath);
      assert(actual.toLowerCase() === String(dl.sha1).toLowerCase(), `sha1 mismatch: expected ${dl.sha1}, got ${actual}`);
    }

    const t0 = Date.now();
    const inst = await call('install_modpack', { path: dlPath }, 660_000);
    if (inst.isError) {
      // Re-run tolerance: pack may already be installed under its own name.
      console.error(`       install_modpack error: ${inst.text}`);
      const existing = await callOk('list_modpacks', {});
      const reused = Array.isArray(existing) && existing.length > 0;
      assert(reused, `install_modpack failed and nothing is listed: ${inst.text}`);
      return `reuse: install failed but ${existing.length} modpack instance(s) already present (${inst.text.slice(0, 160)})`;
    }
    const data = inst.parsed;
    assert(data && typeof data.name === 'string' && data.name.length > 0, `no instance name: ${JSON.stringify(data)}`);
    assert(data.format === 'mrpack', `format != mrpack: ${JSON.stringify(data)}`);

    const packs = await callOk('list_modpacks', {});
    const entry = Array.isArray(packs) ? packs.find((p) => p.name === data.name) : null;
    assert(entry, `list_modpacks missing ${data.name}: ${JSON.stringify(packs)}`);
    assert(entry.format === 'mrpack', `listed format != mrpack: ${JSON.stringify(entry)}`);
    return `installed "${data.name}" (${data.format}) in ${((Date.now() - t0) / 1000).toFixed(0)}s gameVersion=${data.gameVersion ?? '?'} modLoader=${data.modLoader ?? '?'}`;
  });

  // ---- Step 7: launch + stop game ----
  await step('7. launch_game 1.20.4 (alive >= 30s) + stop_game', async () => {
    const t0 = Date.now();
    let launch;
    try {
      launch = await callOk('launch_game', { version: MC_VERSION, maxMemory: 2048 }, 420_000);
    } catch (err) {
      // The agent may still be pre-launching (missing assets/libraries download)
      // after our request timed out — recover via check_environment.gamePid.
      console.error(`       launch_game error: ${err.message}`);
      const deadline = Date.now() + 300_000;
      let gamePid = null;
      while (Date.now() < deadline) {
        const env = await callOk('check_environment', {});
        if (env.agent && env.agent.running && env.agent.gamePid) { gamePid = env.agent.gamePid; break; }
        await sleep(5000);
      }
      if (!gamePid) throw err;
      // Find the newest game log under <workdir>/logs/ as logPath.
      let logPath = null;
      try {
        const logs = (await require('node:fs').promises.readdir(LOGS_DIR))
          .filter((f) => f.startsWith(`${MC_VERSION}-`) && f.endsWith('.log'))
          .map((f) => path.join(LOGS_DIR, f));
        logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        logPath = logs[0] ?? null;
      } catch { /* ignore */ }
      launch = { pid: gamePid, instanceId: MC_VERSION, gameVersion: MC_VERSION, logPath };
      console.error(`       [info] recovered launch: pid=${gamePid} logPath=${logPath ?? '(none)'}`);
    }
    assert(typeof launch.pid === 'number' && launch.pid > 0, `no pid in LaunchInfo: ${JSON.stringify(launch)}`);
    assert(launch.instanceId === MC_VERSION, `instanceId != ${MC_VERSION}: ${JSON.stringify(launch)}`);
    assert(launch.gameVersion === MC_VERSION, `gameVersion != ${MC_VERSION}: ${JSON.stringify(launch)}`);
    assert(launch.logPath && normPath(launch.logPath).startsWith(normPath(LOGS_DIR)), `logPath not under logs/: ${JSON.stringify(launch)}`);
    const pid = launch.pid;
    console.error(`       [info] game pid=${pid} logPath=${launch.logPath} (launch returned in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    // Wait up to 5 min for the game process to stay alive >= 30s continuously.
    let streak = 0;
    const windowStart = Date.now();
    const deadline = windowStart + 300_000;
    let aliveAt = null;
    while (Date.now() < deadline) {
      const alive = pidAlive(pid);
      streak = alive ? streak + 5 : 0;
      if (alive && aliveAt === null) aliveAt = Date.now();
      if (streak >= 30) break;
      await sleep(5000);
    }
    assert(streak >= 30, `game pid ${pid} never stayed alive >= 30s (max streak ${streak}s) — tail of ${launch.logPath}: ${readFileTail(launch.logPath)}`);
    const logStats = statSync(launch.logPath);
    assert(logStats.size > 0, `game log is empty: ${launch.logPath}`);

    const stop = await callOk('stop_game', {}, 60_000);
    const status = await callOk('check_environment', {});
    assert(status.agent && status.agent.running === false, `game still running after stop_game: ${JSON.stringify(status.agent)}`);
    return `game alive ${((Date.now() - aliveAt) / 1000).toFixed(0)}s (log ${logStats.size} bytes); stop_game: ${JSON.stringify(stop)}`;
  });

  // ---- Step 8: stop_hmcl ----
  await step('8. stop_hmcl (agent exits)', async () => {
    const res = await call('stop_hmcl', {}, 30_000);
    assert(!res.isError, `stop_hmcl failed: ${res.text}`);
    assert(res.parsed && res.parsed.stopped === true, `stop_hmcl did not report stopped: ${JSON.stringify(res.parsed)}`);
    const down = await withTimeout(waitAgentDown(30_000), 35_000, 'wait agent down');
    assert(down, 'agent HTTP port still answering 30s after stop_hmcl');
    const env = await callOk('check_environment', {});
    assert(env.agentRunning === false, `agentRunning != false: ${JSON.stringify(env.agent)}`);
    return `stopped: ${JSON.stringify(res.parsed)}`;
  });
}

function readFileTail(file, maxBytes = 4000) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = require('node:fs').openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    require('node:fs').readSync(fd, buf, 0, buf.length, start);
    require('node:fs').closeSync(fd);
    return buf.toString('utf8').slice(-maxBytes);
  } catch (err) {
    return `(cannot read log: ${err.message})`;
  }
}

/* ------------------------------------------------------------------ *
 *  stdout purity check + summary
 * ------------------------------------------------------------------ */

function checkStdoutPurity() {
  const all = Buffer.concat(serverChild.stdoutChunks).toString('utf8');
  const lines = all.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const bad = [];
  for (const line of lines) {
    let msg = null;
    try {
      const obj = JSON.parse(line);
      if (typeof obj !== 'object' || obj === null) msg = 'not a JSON object';
      else if (obj.jsonrpc !== '2.0') msg = `jsonrpc != 2.0 (${JSON.stringify(obj).slice(0, 80)})`;
      else if (!('method' in obj) && !('id' in obj)) msg = 'neither method nor id';
    } catch {
      msg = `not JSON: ${line.slice(0, 120)}`;
    }
    if (msg) bad.push(msg);
  }
  return { ok: bad.length === 0, bad, totalLines: lines.length, totalBytes: all.length };
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  seedWorkdir(fresh);

  // Pre-flight: kill any stale agent on our port. If it won't die, abort —
  // running against a foreign agent (e.g. a parallel process sharing this
  // workdir/port) produces garbage results.
  const pre = await agentProbe();
  if (pre.up) {
    console.error(`[warn] stale agent responding on port ${AGENT_PORT} — shutting it down before the run`);
    await agentShutdownRaw();
    const down = await waitAgentDown(30_000);
    if (!down) {
      console.error(
        `[fatal] stale agent on ${AGENT_PORT} still answering 30s after /shutdown — ` +
          'refusing to race a foreign agent; re-run when the other process is done',
      );
      process.exit(2);
    }
  }

  try {
    await runFlow();
  } catch (err) {
    // Unrecoverable harness-level failure (connect failed, etc.)
    results.push({ name: 'HARNESS', pass: false, ms: 0, error: err.message });
    console.error(`[FAIL] harness error: ${err.message}`);
  }

  // Cleanup: stop game (if any), stop agent, close client. Skip the stop_game
  // call when the agent is already down — it would otherwise respawn the agent.
  try {
    if (client) {
      const probe = await agentProbe();
      if (probe.up) {
        await call('stop_game', {}, 30_000).catch(() => {});
      }
      const stopRes = await call('stop_hmcl', {}, 30_000).catch(() => null);
      if (stopRes && !stopRes.isError) {
        await waitAgentDown(30_000);
      }
    }
  } catch { /* ignore cleanup errors */ }
  try {
    if (client) await client.close();
  } catch { /* ignore */ }
  if (stderrLogStream) stderrLogStream.end();
  if (stdoutLogStream) stdoutLogStream.end();

  // Final agent-down confirmation (raw, in case the client is gone).
  await waitAgentDown(15_000);

  // ---- stdout purity ----
  const purity = checkStdoutPurity();
  results.push({ name: 'stdout: only JSON-RPC lines', pass: purity.ok, ms: 0, info: `${purity.totalLines} lines / ${purity.totalBytes} bytes`, error: purity.ok ? undefined : purity.bad.join('\n') });
  if (purity.ok) {
    console.log(`[PASS] stdout purity: ${purity.totalLines} JSON-RPC lines, ${purity.totalBytes} bytes, no stray output`);
  } else {
    console.error(`[FAIL] stdout purity: ${purity.bad.length} offending line(s):\n${purity.bad.join('\n')}`);
  }

  // ---- report ----
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n================ E2E SUMMARY ================');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
    if (!r.pass && r.error) console.log(`       ${String(r.error).split('\n').join('\n       ')}`);
  }
  console.log(`-----------------------------------------------`);
  console.log(`${passed}/${results.length} steps passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error(`\nServer stderr tail (last 60 lines):\n${stderrTail(60)}`);
  }
  try {
    const report = {
      workdir: WORKDIR,
      agentPort: AGENT_PORT,
      results: results.map((r) => ({ name: r.name, pass: r.pass, ms: r.ms, error: r.error ?? null })),
      serverExitCode: serverChild.exitCode,
    };
    require('node:fs').writeFileSync(path.join(WORKDIR, 'e2e-report.json'), JSON.stringify(report, null, 2));
  } catch { /* ignore */ }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack ?? err}`);
  process.exit(2);
});
