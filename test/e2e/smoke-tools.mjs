#!/usr/bin/env node
/**
 * Smoke test for the NEW tools (mods / loaders / remote versions) — runs the
 * real MCP server + real javaagent + real network, but skips modpacks/launch.
 *
 * Usage:  node test/e2e/smoke-tools.mjs [--fresh]
 *   --fresh  wipe the workdir first (default: reuse so failed runs can resume)
 *
 * Flow:
 *   1. initialize + tools/list (expect all 21 tools)
 *   2. start_hmcl
 *   3. list_remote_versions (release) — list_remote_versions
 *   4. list_loader_versions fabric 1.20.4 — picks the newest loader version
 *   5. install_loader fabric (new instance "smoke-fabric") — vanilla+loader build
 *   6. search_mods "sodium" (gameVersion 1.20.4) + get_mod + download_mod
 *   7. install_mod (sodium) into the new instance + list_mods
 *   8. stop_hmcl
 */

import cp from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKDIR = path.join(PROJECT_ROOT, 'test', 'tmp', 'smoke-workdir');
const HMCL_DIR = path.join(WORKDIR, 'hmcl');
const AGENT_PORT = 28523;
const AGENT_TOKEN = 'smoke-token';
const MC_VERSION = '1.20.4';
const INSTANCE = 'smoke-fabric';

const EXPECTED_TOOLS = [
  'check_environment', 'install_hmcl', 'start_hmcl', 'stop_hmcl',
  'list_versions', 'install_version',
  'search_modpacks', 'get_modpack', 'download_modpack', 'install_modpack', 'list_modpacks',
  'launch_game', 'stop_game',
  'search_mods', 'get_mod', 'download_mod', 'install_mod', 'list_mods',
  'list_loader_versions', 'install_loader', 'list_remote_versions',
].sort();

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client = null;
let transport = null;
let serverStderr = '';
let stderrLogStream = null;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, pass: true, ms: Date.now() - t0 });
    console.log(`[PASS] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (info) console.log(`       ${String(info).split('\n').join('\n       ')}`);
  } catch (err) {
    results.push({ name, pass: false, ms: Date.now() - t0, error: err.message });
    console.error(`[FAIL] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${err.message}`);
  }
}

async function call(name, args, timeoutMs = 180_000) {
  const res = await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: timeoutMs });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* error message */ }
  return { isError: res.isError === true, text, parsed };
}

async function callOk(name, args, timeoutMs = 180_000) {
  const res = await call(name, args, timeoutMs);
  if (res.isError) throw new Error(`tool ${name} failed: ${res.text || '(empty)'}`);
  return res.parsed;
}

async function agentProbe() {
  try {
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/status`, {
      headers: { 'X-HMCL-Agent-Token': AGENT_TOKEN },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitAgentDown(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await agentProbe())) return true;
    await sleep(500);
  }
  return false;
}

function seedWorkdir(fresh) {
  if (fresh && existsSync(WORKDIR)) {
    rmSync(WORKDIR, { recursive: true, force: true });
  }
  mkdirSync(HMCL_DIR, { recursive: true });
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

async function runFlow() {
  await step('1. initialize + tools/list (21 tools)', async () => {
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
    client = new Client({ name: 'hmcl-mcp-smoke', version: '0.0.1' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
    assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
    assert(extra.length === 0, `unexpected tools: ${extra.join(', ')}`);
    return `${names.length} tools registered`;
  });

  await step('2. start_hmcl', async () => {
    const res = await call('start_hmcl', {}, 180_000);
    if (res.isError) {
      await sleep(5000);
      const res2 = await call('start_hmcl', {}, 180_000);
      assert(!res2.isError, `start_hmcl failed twice: ${res.text} | ${res2.text}`);
    }
    const deadline = Date.now() + 90_000;
    let status = null;
    while (Date.now() < deadline) {
      const env = await callOk('check_environment', {});
      if (env.agentRunning) { status = env.agent; break; }
      await sleep(3000);
    }
    assert(status, 'agent never became reachable within 90s');
    return `hmclVersion=${status.hmclVersion}`;
  });

  await step('3. list_remote_versions (release)', async () => {
    const data = await callOk('list_remote_versions', { type: 'release' }, 180_000);
    assert(Array.isArray(data.versions) && data.versions.length > 0, `no versions: ${JSON.stringify(data).slice(0, 200)}`);
    assert(data.versions.every((v) => v.type === 'release'), `non-release leaked: ${JSON.stringify(data.versions.find((v) => v.type !== 'release'))}`);
    assert(data.versions.some((v) => v.id === MC_VERSION), `${MC_VERSION} not listed`);
    return `${data.versions.length} releases; newest: ${data.versions[0].id}`;
  });

  await step(`4. list_loader_versions fabric ${MC_VERSION}`, async () => {
    const data = await callOk('list_loader_versions', { loader: 'fabric', gameVersion: MC_VERSION }, 180_000);
    assert(Array.isArray(data.versions) && data.versions.length > 0, `no loader versions: ${JSON.stringify(data).slice(0, 200)}`);
    const first = data.versions[0];
    assert(first.id, `loader version missing id: ${JSON.stringify(first)}`);
    assert(first.fullVersion, `loader version missing fullVersion: ${JSON.stringify(first)}`);
    return `${data.versions.length} fabric versions; newest: ${first.id} (${first.fullVersion})`;
  });

  await step(`5. install_loader fabric -> new instance "${INSTANCE}"`, async () => {
    const existing = await callOk('list_versions', {});
    if (Array.isArray(existing) && existing.some((v) => v.id === INSTANCE)) {
      return `reuse: instance ${INSTANCE} already installed`;
    }
    const loaders = await callOk('list_loader_versions', { loader: 'fabric', gameVersion: MC_VERSION }, 180_000);
    const newest = loaders.versions[0];
    let res = null;
    let timedOut = false;
    try {
      res = await call('install_loader', {
        loader: 'fabric', versionId: newest.id, gameVersion: MC_VERSION, name: INSTANCE,
      }, 900_000);
    } catch (err) {
      // A client-side MCP timeout (the agent keeps installing) — recoverable by polling.
      if (!/timeout|timed out/i.test(String(err?.message ?? err))) throw err;
      timedOut = true;
    }
    if (timedOut) {
      console.error('       install_loader client timeout (expected on slow links) — polling list_versions for the instance');
      const deadline = Date.now() + 600_000;
      let found = false;
      while (Date.now() < deadline) {
        const versions = await callOk('list_versions', {});
        if (Array.isArray(versions) && versions.some((v) => v.id === INSTANCE && v.hasJar)) { found = true; break; }
        await sleep(10_000);
      }
      assert(found, `instance ${INSTANCE} never appeared within 10 min of install_loader`);
      return 'recovered: instance appeared after client timeout';
    }
    // The agent answered within the window: an isError is a definite refusal/failure,
    // NOT a slow link — fail fast instead of polling for an instance that won't appear.
    assert(!res.isError, `install_loader failed: ${res.text}`);
    const versions = await callOk('list_versions', {});
    const entry = Array.isArray(versions) ? versions.find((v) => v.id === INSTANCE) : null;
    assert(entry, `instance ${INSTANCE} missing after install: ${JSON.stringify(versions)}`);
    assert(entry.hasJar, `instance has no jar (loader libs missing?): ${JSON.stringify(entry)}`);
    return `installed ${newest.fullVersion}; entry=${JSON.stringify(entry)}`;
  });

  // Network-dependent step: Modrinth's API/CDN is unreachable from some networks
  // (direct CN links). Fail-soft into the local-path variant instead of failing.
  let modDl = null;
  const isNetworkError = (err) => /timed out|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|network/i.test(err.message);
  await step('6. search_mods sodium + get_mod + download_mod (Modrinth)', async () => {
    try {
      const hits = await callOk('search_mods', { query: 'sodium', gameVersion: MC_VERSION, limit: 5 }, 120_000);
      assert(Array.isArray(hits) && hits.length >= 1, `no mod hits: ${JSON.stringify(hits).slice(0, 200)}`);
      const top = hits[0];
      assert(top.id, `hit missing id: ${JSON.stringify(top)}`);
      const detail = await callOk('get_mod', { id: top.id }, 120_000);
      assert(detail.summary && detail.summary.id === top.id, `summary mismatch: ${JSON.stringify(detail.summary)}`);
      assert(Array.isArray(detail.versions) && detail.versions.length > 0, `no versions: ${JSON.stringify(detail).slice(0, 200)}`);
      const v = detail.versions.find((x) => Array.isArray(x.gameVersions) && x.gameVersions.includes(MC_VERSION))
        ?? detail.versions[0];
      const dl = await callOk('download_mod', { id: top.id, versionId: v.id }, 600_000);
      assert(dl.path && existsSync(dl.path), `downloaded file missing: ${JSON.stringify(dl)}`);
      modDl = { id: top.id, versionId: v.id, filename: dl.filename };
      return `mod: ${top.id}; version: ${v.id}; file: ${dl.filename} (${dl.size} bytes)`;
    } catch (err) {
      if (isNetworkError(err)) {
        console.error('       [info] Modrinth API/CDN unreachable — skipping the download part; install_mod falls back to path mode');
        return 'SKIPPED (Modrinth unreachable from this network; chain still validated via path mode in step 7)';
      }
      throw err;
    }
  });

  await step(`7. install_mod into "${INSTANCE}" + list_mods`, async () => {
    let inst;
    if (modDl) {
      try {
        inst = await callOk('install_mod', { id: modDl.id, versionId: modDl.versionId, instance: INSTANCE }, 600_000);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        console.error('       [info] Modrinth download timed out — falling back to install_mod path mode');
      }
    }
    if (!inst) {
      // Fallback: place a local jar through the path mode (no Modrinth needed).
      const localJar = path.join(PROJECT_ROOT, 'agent', 'build', 'hmcl-agent.jar');
      inst = await callOk('install_mod', { path: localJar, instance: INSTANCE }, 120_000);
    }
    assert(inst.path && inst.modsDir, `install_mod returned no path: ${JSON.stringify(inst)}`);
    assert(String(inst.modsDir).includes(INSTANCE), `modsDir not in the instance: ${JSON.stringify(inst)}`);
    const mods = await callOk('list_mods', { instance: INSTANCE }, 120_000);
    assert(Array.isArray(mods.mods) && mods.mods.some((m) => m.filename === inst.filename),
      `list_mods missing ${inst.filename}: ${JSON.stringify(mods)}`);
    return `${mods.mods.length} mod(s) in ${INSTANCE}: ${mods.mods.map((m) => m.filename).join(', ')}`;
  });

  await step('8. stop_hmcl', async () => {
    const res = await call('stop_hmcl', {}, 30_000);
    assert(!res.isError, `stop_hmcl failed: ${res.text}`);
    const down = await waitAgentDown(30_000);
    assert(down, 'agent still answering 30s after stop_hmcl');
    return 'agent down';
  });
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  seedWorkdir(fresh);
  try {
    await runFlow();
  } catch (err) {
    results.push({ name: 'HARNESS', pass: false, ms: 0, error: err.message });
    console.error(`[FAIL] harness error: ${err.message}`);
  }
  try {
    if (client && (await agentProbe())) {
      await call('stop_hmcl', {}, 30_000).catch(() => {});
      await waitAgentDown(15_000);
    }
    if (client) await client.close();
  } catch { /* ignore */ }
  if (stderrLogStream) stderrLogStream.end();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n============ SMOKE SUMMARY ============');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
    if (!r.pass && r.error) console.log(`       ${String(r.error).split('\n').join('\n       ')}`);
  }
  console.log(`${passed}/${results.length} steps passed, ${failed.length} failed`);
  if (failed.length > 0) {
    const lines = serverStderr.split(/\r?\n/).filter(Boolean).slice(-40).join('\n');
    console.error(`\nServer stderr tail:\n${lines}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack ?? err}`);
  process.exit(2);
});
