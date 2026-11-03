/**
 * Unit tests for the new tool modules:
 *   - src/mod/mods.ts   (search_mods / get_mod / download_mod / install_mod / list_mods)
 *   - src/hmcl/tools.ts (list_remote_versions / list_loader_versions / install_loader)
 *   - src/server.ts     (all 21 tools registered)
 *
 * Only the local validation branches are exercised (no agent, no network):
 * handlers must return {ok:false} with an actionable message instead of
 * touching ensureAgent when required inputs are missing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Ctx, ToolDef } from '../../src/types.ts';
import { createModTools } from '../../src/mod/mods.ts';
import { createHmclTools } from '../../src/hmcl/tools.ts';
import { createMcpServer, getLastToolCount } from '../../src/server.ts';

let workdir: string;
let ctx: Ctx;
let modTools: ToolDef[];
let hmclTools: ToolDef[];

before(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmcl-mcp-mod-tools-test-'));
  ctx = {
    workdir,
    hmclDir: path.join(workdir, 'hmcl'),
    javaPath: null,
    curseforgeApiKey: null,
    agentPort: 49153, // unused loopback port — nothing should reach the network
    agentToken: 'test-token',
    log: () => {},
  };
  modTools = createModTools(ctx);
  hmclTools = createHmclTools(ctx);
});

after(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

function handlerOf(tools: ToolDef[], name: string): ToolDef['handler'] {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} not registered`);
  return tool.handler;
}

function handler(name: string): ToolDef['handler'] {
  const tool = [...modTools, ...hmclTools].find((t) => t.name === name);
  assert.ok(tool, `tool ${name} not registered`);
  return tool.handler;
}

describe('mod tools registration + validation', () => {
  it('registers the 5 mod tools with zod schemas', () => {
    const names = modTools.map((t) => t.name).sort();
    assert.deepEqual(names, ['download_mod', 'get_mod', 'install_mod', 'list_mods', 'search_mods']);
    for (const tool of modTools) {
      assert.ok(tool.description.length > 20, `thin description for ${tool.name}`);
      assert.ok(tool.inputSchema, `no schema for ${tool.name}`);
    }
  });

  it('search_mods fails on an empty query', async () => {
    const res = await handlerOf(modTools, 'search_mods')({ query: '   ' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /query/);
  });

  it('get_mod fails without an id', async () => {
    const res = await handlerOf(modTools, 'get_mod')({});
    assert.equal(res.ok, false);
  });

  it('install_mod requires instance + (id or path)', async () => {
    const noInstance = await handlerOf(modTools, 'install_mod')({ id: 'sodium' });
    assert.equal(noInstance.ok, false);
    if (!noInstance.ok) assert.match(noInstance.error, /instance/);

    const noSource = await handlerOf(modTools, 'install_mod')({ instance: 'inst' });
    assert.equal(noSource.ok, false);
    if (!noSource.ok) assert.match(noSource.error, /id .*or.* path/);
  });

  it('install_mod fails when the local path does not exist', async () => {
    const res = await handlerOf(modTools, 'install_mod')({
      instance: 'inst',
      path: path.join(workdir, 'no-such-mod.jar'),
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /not found/i);
  });

  it('list_mods requires an instance', async () => {
    const res = await handlerOf(modTools, 'list_mods')({});
    assert.equal(res.ok, false);
  });
});

describe('loader + remote-version tools validation', () => {
  it('registers list_remote_versions / list_loader_versions / install_loader', () => {
    const names = hmclTools.map((t) => t.name);
    for (const expected of ['list_remote_versions', 'list_loader_versions', 'install_loader']) {
      assert.ok(names.includes(expected), `${expected} not registered`);
    }
  });

  it('list_loader_versions rejects an unknown loader', async () => {
    // zod schema itself rejects; simulate a bypassed schema by calling with a bad value
    const tool = hmclTools.find((t) => t.name === 'list_loader_versions')!;
    assert.ok(tool.inputSchema.loader, 'loader schema missing');
    const res = await handler('list_loader_versions')({ loader: 'not-a-loader', gameVersion: '1.21.4' });
    assert.equal(res.ok, false);
  });

  it('list_loader_versions requires a gameVersion', async () => {
    const res = await handler('list_loader_versions')({ loader: 'fabric', gameVersion: '  ' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /gameVersion/);
  });

  it('install_loader requires versionId or fullVersion', async () => {
    const res = await handler('install_loader')({ loader: 'fabric', gameVersion: '1.21.4' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /versionId|fullVersion/);
  });

  it('install_loader requires instance or gameVersion beyond the version selector', async () => {
    const res = await handler('install_loader')({ loader: 'forge', versionId: '51.0.5' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /instance|gameVersion/);
  });
});

describe('server registration', () => {
  it('registers all 21 tools (13 hmcl/modpack + 5 mod + 3 loader/remote)', async () => {
    const ctxWithLog: Ctx = { ...ctx, log: (m) => { if (m.startsWith('WARN')) throw new Error(m); } };
    await createMcpServer(ctxWithLog);
    assert.equal(getLastToolCount(), 21);
  });
});
