#!/usr/bin/env node
/**
 * One-shot CurseForge search verification: boots the headless agent, searches
 * mods via the CurseForge source (HMCL's embedded API key), prints results,
 * and shuts everything down — all within a single process lifetime, so the
 * sandbox cannot reap the JVM between commands.
 *
 * Usage: node test/e2e/cf-search-check.mjs [query1 query2 ...]
 */
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKDIR = path.join(PROJECT_ROOT, 'test', 'tmp', 'smoke-workdir');
const HMCL_DIR = path.join(WORKDIR, 'hmcl');
const PORT = 28525;
const TOKEN = 'cf-check-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = (n) => path.join(HMCL_DIR, n);
const cpSep = process.platform === 'win32' ? ';' : ':';
const classpath = [
  jar('HMCL.jar'), jar('javafx-base-21.0.8-win.jar'),
  jar('javafx-graphics-21.0.8-win.jar'), jar('javafx-controls-21.0.8-win.jar'),
].join(cpSep);

const java = process.env.HMCL_MCP_JAVA || 'java';
const child = cp.spawn(java, [
  '-Xmx512m', '-Xms64m',
  `-Dhmcl.agent.port=${PORT}`,
  `-Dhmcl.agent.token=${TOKEN}`,
  `-Dhmcl.gameDir=${WORKDIR}`,
  `-Dhmcl.home=${path.join(WORKDIR, '.hmcl')}`,
  `-Dhmcl.dir=${path.join(WORKDIR, '.hmcl')}`,
  `-javaagent:${jar('hmcl-agent.jar')}`,
  '-cp', classpath, 'hmcl.agent.AgentMain',
], { cwd: WORKDIR, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', () => { /* keep the pipe drained */ });
console.log(`[boot] agent JVM pid=${child.pid}`);

async function api(p, body, timeoutMs = 90_000) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-HMCL-Agent-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let exitCode = 0;
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(800);
    try {
      const r = await api('/status', null, 3000);
      ready = r.status === 200 && r.json?.ok === true;
    } catch { /* not up yet */ }
  }
  if (!ready) throw new Error('agent did not become ready in 48s');
  console.log('[boot] agent READY\n');

  const argList = process.argv.slice(2);
  const srcIdx = argList.indexOf('--source');
  const source = srcIdx >= 0 ? (argList.splice(srcIdx, 2)[1] ?? 'curseforge') : 'curseforge';
  const infoIdx = argList.indexOf('--info');
  const infoId = infoIdx >= 0 ? (argList.splice(infoIdx, 2)[1] ?? null) : null;
  const dlIdx = argList.indexOf('--download');
  const dlId = dlIdx >= 0 ? (argList.splice(dlIdx, 2)[1] ?? null) : null;
  const queries = argList.length ? argList : ['JEI', 'sodium', 'create'];
  console.log(`[search] source=${source}\n`);

  if (infoId) {
    const r = await api('/mods/info', { source, id: infoId });
    if (r.status !== 200 || r.json?.ok !== true) {
      console.log(`[FAIL] info "${infoId}": HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      exitCode = 1;
    } else {
      const s = r.json.summary ?? {};
      const vs = r.json.versions ?? [];
      console.log(`[OK]   info "${infoId}": title="${s.title}" url=${s.url ?? '-'}`);
      console.log(`       versions (${vs.length}): ${vs.slice(0, 4).map((v) => v.id).join(', ')}`);
    }
  }

  if (dlId) {
    const t0 = Date.now();
    const r = await api('/mods/download', { source, id: dlId, versionId: null }, 300_000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status !== 200 || r.json?.ok !== true) {
      console.log(`[FAIL] download "${dlId}" (${secs}s): ${JSON.stringify(r.json).slice(0, 300)}`);
      exitCode = 1;
    } else {
      console.log(`[OK]   download "${dlId}" (${secs}s): ${r.json.filename} (${r.json.size} bytes) -> ${r.json.path}`);
    }
  }

  for (const q of queries) {
    const t0 = Date.now();
    try {
      const r = await api('/mods/search', { source, query: q, gameVersion: '1.20.4', limit: 5 });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.status !== 200 || r.json?.ok !== true) {
        console.log(`[FAIL] "${q}" (${secs}s): HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
        exitCode = 1;
        continue;
      }
      const mods = r.json.hits ?? [];
      console.log(`[OK]   "${q}" (${secs}s) — ${mods.length} hits, top:`);
      for (const m of mods.slice(0, 5)) {
        console.log(`       - ${String(m.title ?? m.name ?? m.id).slice(0, 40).padEnd(42)} id=${m.id}  dl=${m.downloads ?? '?'}`);
      }
      console.log('');
    } catch (err) {
      console.log(`[FAIL] "${q}": ${err.message}`);
      exitCode = 1;
    }
  }
} catch (err) {
  console.error(`[error] ${err.message}`);
  exitCode = 1;
} finally {
  try { await api('/shutdown', {}, 5000); } catch { /* fall through */ }
  await sleep(1500);
  if (!child.killed) child.kill();
  console.log('[teardown] agent stopped');
}
process.exit(exitCode);
