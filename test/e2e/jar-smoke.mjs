#!/usr/bin/env node
/**
 * Smoke test for the packaged `build/hmcl-mcp.jar`.
 *
 * Boots the jar exactly like an MCP client would (`java -jar ...` over stdio),
 * runs the protocol handshake and lists the tools. With --full it also calls
 * check_environment, which makes the launcher seed HMCL.jar / hmcl-agent.jar /
 * JavaFX and start the real headless HMCL agent from inside the jar.
 *
 * Usage: node test/e2e/jar-smoke.mjs [--full]
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const JAR = path.join(PROJECT_ROOT, 'build', 'hmcl-mcp.jar');
const WORKDIR = path.join(PROJECT_ROOT, 'test', 'tmp', 'jar-workdir');
const FULL = process.argv.includes('--full');

const EXPECTED_TOOLS = [
  'check_environment', 'install_hmcl', 'start_hmcl', 'stop_hmcl',
  'list_versions', 'install_version',
  'search_modpacks', 'get_modpack', 'download_modpack', 'install_modpack', 'list_modpacks',
  'launch_game', 'stop_game',
  'search_mods', 'get_mod', 'download_mod', 'install_mod', 'list_mods',
  'list_loader_versions', 'install_loader', 'list_remote_versions',
].sort();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

if (!existsSync(JAR)) {
  console.error(`jar not found: ${JAR}\nbuild it with: node tools/jar/build-jar.mjs`);
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: 'java',
  args: ['-jar', JAR],
  env: { ...process.env, HMCL_MCP_WORKDIR: WORKDIR },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (d) => { stderr += d.toString(); });

const client = new Client({ name: 'jar-smoke', version: '1.0.0' });
const t0 = Date.now();
await client.connect(transport);
console.log(`[PASS] connected + initialize (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`[PASS] tools/list -> ${names.length} tools`);
assert(names.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length} tools, got ${names.length}`);
const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
console.log('       ' + names.join(', '));

if (FULL) {
  console.log('[....] calling check_environment (starts the real HMCL agent) ...');
  const t1 = Date.now();
  const res = await client.callTool({ name: 'check_environment', arguments: {} }, undefined, { timeout: 300_000 });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`[PASS] check_environment (${((Date.now() - t1) / 1000).toFixed(1)}s):`);
  console.log(text.split('\n').map((l) => '       ' + l).join('\n'));
  assert(!res.isError, `check_environment failed: ${text.slice(0, 400)}`);
}

if (process.argv.includes('--agent')) {
  console.log('[....] starting the HMCL agent from inside the jar ...');
  const t2 = Date.now();
  const start = await client.callTool({ name: 'start_hmcl', arguments: {} }, undefined, { timeout: 300_000 });
  const startText = (start.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert(!start.isError, `start_hmcl failed: ${startText.slice(0, 600)}`);
  console.log(`[PASS] start_hmcl (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  console.log(startText.split('\n').slice(0, 12).map((l) => '       ' + l).join('\n'));

  const versions = await client.callTool({ name: 'list_versions', arguments: {} }, undefined, { timeout: 60_000 });
  const vText = (versions.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`[PASS] list_versions -> ${vText.slice(0, 200).replace(/\s+/g, ' ')}`);

  const stop = await client.callTool({ name: 'stop_hmcl', arguments: {} }, undefined, { timeout: 60_000 });
  const stopText = (stop.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`[PASS] stop_hmcl -> ${stopText.replace(/\s+/g, ' ').slice(0, 200)}`);
}

await client.close();
if (stderr.trim()) {
  console.log('--- launcher/stderr ---');
  console.log(stderr.trim().split('\n').slice(-12).join('\n'));
}
console.log('ALL PASS');
process.exit(0);
