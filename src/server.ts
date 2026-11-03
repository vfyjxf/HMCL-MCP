/**
 * MCP server assembly (see docs/research/mcp-sdk.md).
 *
 * Tool modules (src/hmcl/tools.ts, src/modpack/modpack.ts) are being built in
 * parallel; if one is missing at build/runtime time, its tools are skipped with
 * a stderr warning instead of crashing the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Ctx, ToolDef } from './types.js';

/** Tool count of the most recent createMcpServer() call (for the startup banner). */
let lastToolCount = 0;

export function getLastToolCount(): number {
  return lastToolCount;
}

interface ToolModule {
  createHmclTools?: (ctx: Ctx) => ToolDef[];
  createModpackTools?: (ctx: Ctx) => ToolDef[];
  createModTools?: (ctx: Ctx) => ToolDef[];
}

/** Load `relative` (a .js specifier), falling back to the .ts source in dev (tsx). */
async function loadToolModule<T>(relative: string, ctx: Ctx): Promise<T | null> {
  const jsUrl = new URL(relative, import.meta.url);
  const tsUrl = new URL(relative.replace(/\.js$/, '.ts'), import.meta.url);
  const target = existsSync(fileURLToPath(jsUrl))
    ? jsUrl.href
    : existsSync(fileURLToPath(tsUrl))
      ? tsUrl.href
      : null;
  if (!target) {
    ctx.log(
      `WARN: tool module ${relative} not found (being built in parallel?) — its tools are unavailable`,
    );
    return null;
  }
  return (await import(target)) as T;
}

/** Gather every ToolDef from the tool modules (missing modules are skipped). */
async function collectTools(ctx: Ctx): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];
  const hmcl = await loadToolModule<ToolModule>('./hmcl/tools.js', ctx);
  if (hmcl?.createHmclTools) {
    tools.push(...hmcl.createHmclTools(ctx));
  }
  const modpack = await loadToolModule<ToolModule>('./modpack/modpack.js', ctx);
  if (modpack?.createModpackTools) {
    tools.push(...modpack.createModpackTools(ctx));
  }
  const mods = await loadToolModule<ToolModule>('./mod/mods.js', ctx);
  if (mods?.createModTools) {
    tools.push(...mods.createModTools(ctx));
  }
  return tools;
}

/** Build the MCP server and register every HMCL tool. */
export async function createMcpServer(ctx: Ctx): Promise<McpServer> {
  const server = new McpServer({ name: 'hmcl-mcp', version: '0.1.0' });

  const tools = await collectTools(ctx);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      ctx.log(`WARN: duplicate tool name '${tool.name}' — skipping the later registration`);
      continue;
    }
    seen.add(tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        const result = await tool.handler(args as Record<string, unknown>);
        if (result.ok) {
          return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
        }
        // SDK converts a thrown Error into a clean `isError: true` result.
        throw new Error(result.error);
      },
    );
  }
  lastToolCount = tools.length;
  return server;
}
