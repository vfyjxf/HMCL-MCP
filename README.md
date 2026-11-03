# HMCL MCP Server

MCP (Model Context Protocol) server that lets AI agents drive **HMCL** (Hello Minecraft! Launcher, https://hmcl.huangyuhui.net) programmatically: install Minecraft versions, search/download/import modpacks (Modrinth + CurseForge), and launch/stop the game.

HMCL has **no command line interface** (no `--launch`, no `--import`, no headless mode), so this project injects a small **javaagent** into a headless HMCL JVM and drives HMCL's core classes directly. Modpack search/download/install all run through HMCL's own addon repositories inside the agent (Modrinth, and CurseForge with HMCL's embedded API key — no user key needed); listing installed versions/modpacks is a local filesystem scan.

Two ways to run it: from source (`npm install && npm run build`), or as a **single file** — `npm run build:jar` produces `build/hmcl-mcp.jar` (~61 MB) that bundles the MCP server, a Node runtime, the java agent and HMCL itself, so it needs nothing but a JRE. See [Packaging as a single jar](#packaging-as-a-single-jar).

## Architecture

```
┌──────────────────────────────┐   stdio (JSON-RPC only)   ┌────────────────────────────────┐
│  MCP client / AI agent       │ ◀────────────────────────▶ │  Node MCP server (this repo)   │
└──────────────────────────────┘                            └───────────────┬────────────────┘
                                                      filesystem scans      │ HTTP JSON API
                                                <workdir>/versions/,        │ 127.0.0.1:<port>
                                                mcpacks/ (search/download)  │ X-HMCL-Agent-Token
                                                                             ▼
                                                              ┌────────────────────────────────┐
                                                              │  Headless HMCL JVM              │
                                                              │  java -javaagent:hmcl-agent.jar │
                                                              │  -Dhmcl.gameDir=<workdir> …      │
                                                              │  -cp HMCL.jar;javafx-*.jar       │
                                                              │  hmcl.agent.AgentMain            │
                                                              └────────────────────────────────┘
```

- **Node MCP server** (`src/`, TypeScript, stdio transport): registers 21 tools, drives HMCL's own Modrinth/CurseForge repositories for modpack **and single-mod** search/download/install, installs mod loaders (fabric/forge/neoforge/quilt/…) through HMCL's own version lists, scans `<workdir>/versions/` on disk for installed versions and modpacks, and talks to the agent over loopback HTTP.
- **Java agent** (`agent/`, compiled by `npm run build:agent`): injected into HMCL with `-javaagent`; initializes HMCL core headlessly (`SettingsManager.init()` → `DownloadProviders.init()` → `Accounts.init()`) and exposes a loopback HTTP JSON API (`/status`, `/versions/install`, `/versions/remote`, `/mods/*`, `/loaders/list`, `/loader/install`, `/modpack/install`, `/launch`, `/launch/stop`, `/shutdown`) on `127.0.0.1:<port>`. A non-daemon HTTP thread keeps the JVM alive.
- **No launcher GUI**: the HMCL window never opens. When you launch the game, the **game window itself opens normally** (the game is a separate child process).

HMCL-compatible directory layout inside the workdir: `versions/<id>/`, `libraries/`, `assets/`, `mcpacks/` (downloaded pack files), `modfiles/` (downloaded mod files), `hmcl/` (HMCL.jar + hmcl-agent.jar + javafx jars), `.hmcl/` (HMCL 3.16+ workspace config).

## Requirements

Running from source:

- Node.js 18+ (24 recommended) — MCP SDK 1.30.0, `npm install`
- JDK 17+ with `javac` (21 recommended) — HMCL itself requires Java 17; `javac` is needed to compile the agent jar
- Internet access on first run (HMCL jar, javafx jars, Minecraft versions/libraries/assets)

Running the packaged jar instead: only a **JRE 17+** is needed — Node, the MCP server, the agent and
HMCL are all inside the jar. (`javac` is still required to *build* the jar.)

## Tools (21)

| Tool | Args | Description |
|---|---|---|
| `check_environment` | — | Java path + version, workdir, hmcl dir contents (HMCL.jar / hmcl-agent.jar / javafx jars), agent running status, version/modpack counts |
| `install_hmcl` | — | Download latest HMCL jar into `<hmclDir>/HMCL.jar` if missing, then build the agent jar (`node agent/build.mjs`, needs javac) and copy `hmcl-agent.jar` + javafx jars into `<hmclDir>/` |
| `start_hmcl` | — | Start the headless HMCL JVM with the agent (no-op if already running) and return agent `/status` |
| `stop_hmcl` | — | Stop the headless HMCL JVM (agent `/shutdown`) and confirm it is down |
| `list_versions` | — | Scan `<workdir>/versions/`; a dir counts as a version when it contains `<id>/<id>.json` → `[{id, path, hasJar}]` |
| `list_remote_versions` | `type` (`release`\|`snapshot`\|`all`, optional) | List Minecraft versions available for `install_version` from the remote list (BMCLAPI/Mojang) → `[{id, type, releaseDate?}]` |
| `install_version` | `mc_version` (string) | Install a vanilla Minecraft version through the agent's HMCL download pipeline |
| `list_loader_versions` | `loader` (fabric\|forge\|neoforge\|quilt\|optifine\|liteloader\|legacyfabric\|cleanroom), `game_version` (string) | Loader versions available for a Minecraft version → `[{id, fullVersion, gameVersion}]` |
| `install_loader` | `loader`, `version_id` or `full_version`, plus `game_version`+`name` (new instance) or `instance` (existing) | Install a mod loader: for a new instance builds the vanilla game first (json+jar+libraries, no assets) then patches the loader on top and saves; for an existing instance patches it in place (instance id kept). Reuses an existing instance with the same name (`reused: true`) |
| `search_modpacks` | `query` (string), `source` (`modrinth`\|`curseforge`, optional), `limit` (number, optional) | Search modpacks via HMCL's own repositories (CurseForge uses HMCL's embedded key — no user key needed) |
| `get_modpack` | `id` (string), `source` (optional) | Project details + latest version for one modpack (id = Modrinth slug or CurseForge numeric id) |
| `download_modpack` | `id` (string), `versionId` (string, optional), `source` (optional) | Download the pack file into `<workdir>/mcpacks/` (sha1-verified); `versionId` picks a specific version, defaults to latest |
| `install_modpack` | `id` (string, optional), `versionId` (string, optional), `path` (string, optional), `name` (string, optional), `source` (optional) | Download (if `id` given, or `path` to a local file) then agent-install the pack as an instance under `<workdir>/versions/<name>/` |
| `list_modpacks` | — | Scan `<workdir>/versions/*/modpack.json` → `[{name, path, format, gameVersion?, modLoader?}]` (format: `mrpack` / `curseforge` / `hmcl`) |
| `search_mods` | `query` (string), `source` (optional), `gameVersion` (string, optional), `limit` (number, optional) | Search single mods via HMCL's own MODS repositories (Modrinth / CurseForge); results include `numericId` + `downloads` for CurseForge hits |
| `get_mod` | `id` (string), `source` (optional) | Mod project details + version list (`gameVersions`, `loaders`, `filename`); CurseForge slugs are auto-resolved to the numeric project id |
| `download_mod` | `id` (string), `versionId` (string, optional), `source` (optional) | Download a mod file into `<workdir>/modfiles/` (sha1-verified); CurseForge slugs are auto-resolved |
| `install_mod` | `id` or `path`, `versionId` (optional), `instance` (string, required), `source` (optional) | Place a mod .jar into `<workdir>/versions/<instance>/mods/` (downloads via HMCL when `id` is given) |
| `list_mods` | `instance` (string) | List the .jar files in `<workdir>/versions/<instance>/mods/` → `[{filename, size}]` |
| `launch_game` | `version` (string), `username` (string, default Steve), `maxMemory` (number, MB), `javaPath` (string), `extraArgs` (string[]) | Launch an instance as an offline account; the game opens as a child process |
| `stop_game` | — | Stop the running game process (agent `/launch/stop`) |

All handlers return structured data on success and an error message on failure (MCP `isError` result) — they never crash the server.

## Quick start

```bash
npm install          # install dependencies
npm run build        # compile the MCP server → dist/
npm run build:agent  # download javafx jars + compile agent/build/hmcl-agent.jar (javac required)
```

Register the server in your MCP client:

```json
{
  "mcpServers": {
    "hmcl-mcp": {
      "command": "node",
      "args": ["D:/ProjectDir/AgentFarm/HMCL-MCP/dist/index.js"]
    }
  }
}
```

Environment variables can be set in the client's `env` object, in your shell, or via a `.env` file — see [`.env.example`](.env.example) and `docs/setup.md`.

Without a source checkout, build (or download) the single-file jar and point the client at it:

```bash
npm run build:jar   # -> build/hmcl-mcp.jar
java -jar build/hmcl-mcp.jar
```

```json
{
  "mcpServers": {
    "hmcl-mcp": {
      "command": "java",
      "args": ["-jar", "D:/path/to/hmcl-mcp.jar"],
      "env": { "HMCL_MCP_WORKDIR": "D:/mc" }
    }
  }
}
```

See [Packaging as a single jar](#packaging-as-a-single-jar) for details.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HMCL_MCP_WORKDIR` | `~/.hmcl-mcp` | HMCL working directory (game root + user data): `versions/`, `libraries/`, `assets/`, `mcpacks/`, `.hmcl/` |
| `HMCL_MCP_HMCL_DIR` | `<workdir>/hmcl` | Directory holding `HMCL.jar`, `hmcl-agent.jar` and the javafx jars |
| `HMCL_MCP_JAVA` | `java` on PATH | Java binary used to launch the headless HMCL JVM |
| `HMCL_MCP_CURSEFORGE_API_KEY` | *(none)* | Optional CurseForge API key override, passed to HMCL as `-Dhmcl.curseforge.apikey`; without it search/install still work via HMCL's embedded key |
| `HMCL_MCP_AGENT_PORT` | `28501` | Agent HTTP port on `127.0.0.1` |
| `HMCL_MCP_AGENT_TOKEN` | `hmcl-mcp` | Shared token, sent as the `X-HMCL-Agent-Token` header |

## Typical agent workflows

1. **Modpack: search → install → launch**

   `search_modpacks(query: "fabulously optimized")` → `get_modpack(id: "fabulously-optimized")` → `install_modpack(id: "fabulously-optimized", name: "fabulously-optimized")` (downloads and installs in one step, all through HMCL) → `launch_game(version: "fabulously-optimized", username: "Steve")` — note: `launch_game`'s `version` is the **instance name** from `install_modpack`/`list_modpacks`, not the Minecraft version number

2. **Loader instance: pick MC + loader → install → add mods → launch**

   `list_remote_versions(type: "release")` → `list_loader_versions(loader: "fabric", gameVersion: "1.21.4")` → `install_loader(loader: "fabric", versionId: "<loader id>", gameVersion: "1.21.4", name: "my-fabric")` → `search_mods(query: "sodium", gameVersion: "1.21.4")` → `install_mod(id: "sodium", instance: "my-fabric")` → `launch_game(version: "my-fabric")` — `install_loader` also accepts `instance` to patch an already-installed vanilla instance instead of creating a new one

3. **Vanilla: install a version → launch**

   `install_version(mc_version: "1.21.4")` → `launch_game(version: "1.21.4", username: "Steve")`

4. **First run / fresh setup**

   `check_environment` (verify java + hmcl dir) → `install_hmcl` (downloads HMCL.jar, builds the agent jar) → `start_hmcl` (boots the headless JVM, agent responds on `/status`)

5. **Cleanup**

   `stop_game` (stop the running game) → `stop_hmcl` (stop the headless JVM)

## Troubleshooting

- **`javac not found` / java missing**: installing a JDK is the user's responsibility — install JDK 17+ (21 recommended) and make sure both `java` and `javac` are on PATH (or set `HMCL_MCP_JAVA`).
- **First run downloads**: `install_hmcl` downloads HMCL.jar (~10 MB) from GitHub releases and `npm run build:agent` downloads `javafx-base`/`javafx-graphics`/`javafx-controls` from Maven Central — both need internet and can take a minute. `agent/lib/HMCL-3.16.3.jar` is not in git; build:agent expects it there (see docs/setup.md).
- **`install_hmcl` fails with HTTP 403/429**: GitHub API rate limit — download `HMCL-<version>.jar` manually and place it at `<hmclDir>/HMCL.jar` (see `docs/setup.md`), then re-run.
- **CurseForge errors (403)**: missing/invalid API key — CurseForge is optional; use Modrinth (keyless) for search/install. Modpack and mod search both use HMCL's embedded key by default.
- **Modrinth very slow / timed out**: `api.modrinth.com` and `cdn.modrinth.com` are unreachable from some networks. Vanilla/loader downloads go through BMCLAPI (fast in CN); mod downloads are the only path that needs Modrinth — use `source: "curseforge"` instead (its forgecdn CDN is usually reachable and fast), or `install_mod` with a local `path`.
- **Long installs and client timeouts**: `install_version` / `install_loader` / `install_modpack` block the agent for minutes. If your MCP client times the request out, the agent keeps working — re-check with `list_versions` (or `check_environment`) before retrying; the run may already be complete. The agent itself also bounds every blocking task (refresh 3 min, file download 8 min, install 20 min, launch completion check 15 min) and reports `timed out after Ns` instead of hanging forever on a dead download source; note HMCL rolls a failed `GameBuilder` install back from disk, so a timed-out/failing install may leave no instance behind — just retry.
- **Headless means no launcher window**: only the game window appears, on `launch_game`.
- **Port conflict**: change `HMCL_MCP_AGENT_PORT` and restart; the agent binds `127.0.0.1` only.
- **Paths containing `!`**: HMCL refuses to run when the working directory or jar path contains `!` — use a path without it.
- **The jar is slow to start the first time**: it unpacks ~3000 files into `<workdir>/.launcher` on the first run (a few seconds); later runs reuse the cache. If the workdir is on a slow or read-only drive, point `HMCL_MCP_WORKDIR` somewhere writable.
- **The jar finds no `node`**: the bundled runtime is a Windows binary. On Linux/macOS either build with `--no-node` and put Node 18+ on `PATH`, or run from source instead.

## Packaging as a single jar

The whole server (MCP server + Node runtime + the Java agent + HMCL itself) can be packed into
one self-contained file that runs with nothing but a JRE installed:

```bash
npm run build:jar          # -> build/hmcl-mcp.jar  (~61 MB)
java -jar build/hmcl-mcp.jar
```

The jar is a launcher, not a rewrite: on startup it unpacks itself into `<workdir>/.launcher`
(cached between runs), seeds `HMCL.jar` / `hmcl-agent.jar` / the JavaFX jars into
`<workdir>/hmcl` when they are missing, and then starts the Node process with the parent's
stdio inherited — the MCP JSON-RPC stream passes straight through.

What ends up on disk:

```
<workdir>/.launcher/            ← unpacked launcher cache (created by the jar)
├── node.exe                    ← the bundled Node runtime
└── app/                        ← the MCP server + its production node_modules
<workdir>/hmcl/                 ← seeded by the jar, shared with the source install
├── HMCL.jar  hmcl-agent.jar  javafx-*.jar
```

The cache is keyed by a build id (`.build-id` inside `app/`): the first start unpacks ~3000
files and takes a few seconds, every later start reuses the cache and is ready in ~1–2 s.
Existing files in `<workdir>/hmcl` are never overwritten, so an installation that is already
there (or a newer HMCL.jar you dropped in yourself) wins over the bundled copy.

Because the jar already carries HMCL and the agent, `install_hmcl` has nothing left to
download or compile when the jar is used — it only matters for the source install.

Point an MCP client at it like any other server:

```json
{
  "mcpServers": {
    "hmcl": {
      "command": "java",
      "args": ["-jar", "/path/to/hmcl-mcp.jar"],
      "env": { "HMCL_MCP_WORKDIR": "D:/mc" }
    }
  }
}
```

Build options (`node tools/jar/build-jar.mjs`):

| Flag | Effect |
|---|---|
| `--no-node` | do not embed a Node runtime (≈20 MB instead of ≈61 MB); the launcher falls back to `node` from `PATH` (>= 18) |
| `--skip-agent` | reuse the existing `agent/build/` output instead of rebuilding the agent jar |

The bundled `node.exe` is a Windows binary; on Linux/macOS build with `--no-node` and
provide Node 18+ on `PATH`.

Smoke test the packaged jar (boots it over stdio and lists the tools):

```bash
node test/e2e/jar-smoke.mjs              # handshake + tools/list
node test/e2e/jar-smoke.mjs --full       # + check_environment
node test/e2e/jar-smoke.mjs --full --agent  # + start the real HMCL agent and stop it
```

## Docs

- [`docs/setup.md`](docs/setup.md) — manual HMCL install, workdir layout, reusing an existing game directory, security notes
- [`docs/research/`](docs/research/) — research notes (MCP SDK, HMCL Java API, HMCL CLI/modpack formats, Modrinth/CurseForge APIs)
- `src/types.ts` — the shared contract (tools, types, cross-module interfaces)
