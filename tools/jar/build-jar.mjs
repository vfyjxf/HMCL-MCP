#!/usr/bin/env node
/**
 * Builds the self-contained `hmcl-mcp.jar`.
 *
 * The jar bundles everything needed to run the MCP server with `java -jar`:
 *   /launcher  — the Java launcher (compiled from tools/jar/launcher/Launcher.java)
 *   /app       — the compiled MCP server (dist/) + its production dependencies
 *   /runtime   — the Node runtime (node.exe) that executes /app
 *   /hmcl      — HMCL.jar + hmcl-agent.jar + the JavaFX jars for the agent
 *
 * Usage: node tools/jar/build-jar.mjs [--no-node] [--skip-agent]
 *   --no-node     do not embed a Node runtime (the launcher falls back to PATH)
 *   --skip-agent  reuse the existing agent/build output instead of rebuilding it
 */

import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const STAGE_DIR = path.join(BUILD_DIR, 'stage');
const OUT_JAR = path.join(BUILD_DIR, 'hmcl-mcp.jar');

const args = new Set(process.argv.slice(2));
const EMBED_NODE = !args.has('--no-node');
const SKIP_AGENT = args.has('--skip-agent');

const log = (msg) => console.log(`[build-jar] ${msg}`);

function run(cmd, cmdArgs, opts = {}) {
  const res = cp.spawnSync(cmd, cmdArgs, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed with code ${res.status}`);
  }
}

function copyInto(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(src, destDir, { recursive: true });
}

// ---------------------------------------------------------------- 1. clean
fs.rmSync(STAGE_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGE_DIR, { recursive: true });
log('staging directory reset');

// ---------------------------------------------------------------- 2. build
log('building the MCP server (tsc) ...');
run('npm', ['run', 'build']);

if (!SKIP_AGENT) {
  log('building the java agent ...');
  run('npm', ['run', 'build:agent']);
}

// ---------------------------------------------------------------- 3. app
const appDir = path.join(STAGE_DIR, 'app');
fs.mkdirSync(appDir, { recursive: true });
copyInto(path.join(PROJECT_ROOT, 'dist'), path.join(appDir, 'dist'));

// Build id: the launcher uses it to decide whether the cached bundle in
// <workdir>/.launcher/app is still current (re-extracting ~3000 node_modules
// files on every start would be needlessly slow).
let buildId;
try {
  buildId = cp.execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: PROJECT_ROOT, encoding: 'utf8',
  }).trim();
} catch {
  buildId = 'unknown';
}
buildId = `${buildId}-${Date.now().toString(36)}`;
fs.writeFileSync(path.join(appDir, '.build-id'), buildId + '\n');
log(`app build id = ${buildId}`);

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
// Only the runtime-relevant fields; devDependencies are intentionally dropped.
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      type: 'module',
      private: true,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ) + '\n',
);
log('app package.json written (production dependencies only)');

log('installing production dependencies into the staging app ...');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir });

// ---------------------------------------------------------------- 4. runtime
const runtimeDir = path.join(STAGE_DIR, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
if (EMBED_NODE) {
  const nodeExe = process.execPath; // the node currently running this script
  const target = path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(nodeExe, target);
  const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  log(`embedded node runtime (${mb} MB) from ${nodeExe}`);
} else {
  log('skipping the node runtime (--no-node): the launcher will use PATH');
}

// ---------------------------------------------------------------- 5. hmcl
const hmclStage = path.join(STAGE_DIR, 'hmcl');
fs.mkdirSync(hmclStage, { recursive: true });
const hmclJar = path.join(PROJECT_ROOT, 'agent', 'lib', 'HMCL-3.16.3.jar');
if (fs.existsSync(hmclJar)) {
  fs.copyFileSync(hmclJar, path.join(hmclStage, 'HMCL.jar'));
  log('staged HMCL.jar');
} else {
  log('WARNING: agent/lib/HMCL-3.16.3.jar is missing — the jar will download HMCL.jar on first run');
}
const agentJar = path.join(PROJECT_ROOT, 'agent', 'build', 'hmcl-agent.jar');
if (!fs.existsSync(agentJar)) {
  throw new Error('agent/build/hmcl-agent.jar is missing — run `npm run build:agent` first');
}
fs.copyFileSync(agentJar, path.join(hmclStage, 'hmcl-agent.jar'));
for (const name of fs.readdirSync(path.join(PROJECT_ROOT, 'agent', 'build'))) {
  if (/^javafx-.+-win\.jar$/.test(name)) {
    fs.copyFileSync(path.join(PROJECT_ROOT, 'agent', 'build', name), path.join(hmclStage, name));
  }
}
log('staged hmcl-agent.jar + javafx jars');

// ---------------------------------------------------------------- 6. launcher
const classesDir = path.join(STAGE_DIR, 'classes');
fs.mkdirSync(classesDir, { recursive: true });
log('compiling the java launcher ...');
run('javac', ['-encoding', 'UTF-8', '-d', classesDir,
  path.join(PROJECT_ROOT, 'tools', 'jar', 'launcher', 'Launcher.java')]);

// ---------------------------------------------------------------- 7. jar
fs.rmSync(OUT_JAR, { force: true });
// `-C <dir> <name>` means "descend into <dir>, then add <name>" — so the app /
// runtime / hmcl trees are added relative to the staging root to keep their
// top-level names inside the jar.
const jarArgs = [
  '--create', '--file', OUT_JAR,
  '--main-class', 'launcher.Launcher',
  '-C', classesDir, '.',
  '-C', STAGE_DIR, 'app',
];
if (EMBED_NODE) {
  jarArgs.push('-C', STAGE_DIR, 'runtime');
}
jarArgs.push('-C', STAGE_DIR, 'hmcl');
run('jar', jarArgs);

const mb = (fs.statSync(OUT_JAR).size / 1024 / 1024).toFixed(1);
log(`built ${OUT_JAR} (${mb} MB)`);
log('run it with:  java -jar build/hmcl-mcp.jar');
