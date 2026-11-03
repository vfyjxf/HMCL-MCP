# HMCL MCP Javaagent — HTTP Protocol

The javaagent (`hmcl-agent.jar`, built by `npm run build:agent` / `node agent/build.mjs`)
drives HMCL 3.16.3 headlessly and exposes a loopback HTTP JSON API on `127.0.0.1`.
It is spawned by the Node server (`src/hmcl-client.ts`, `ensureAgent`) like this:

```
java -javaagent:<workdir>/hmcl/hmcl-agent.jar \
     -Dhmcl.home=<workdir>/hmcl \
     -Dhmcl.dir=<workdir>/hmcl \
     -Dhmcl.gameDir=<workdir> \
     -Dhmcl.agent.port=28501 \
     -Dhmcl.agent.token=hmcl-mcp \
     -cp <workdir>/hmcl/HMCL-3.16.3.jar;<workdir>/hmcl/hmcl-agent.jar;<workdir>/hmcl/javafx-base-21.0.8-win.jar;<workdir>/hmcl/javafx-graphics-21.0.8-win.jar;<workdir>/hmcl/javafx-controls-21.0.8-win.jar \
     hmcl.agent.AgentMain
```

- `-Dhmcl.home` / `-Dhmcl.dir` are read by HMCL's `Metadata` static init **before any HMCL
  class loads** — they must be JVM arguments, not set at runtime.
- `-Dhmcl.gameDir` is the game directory: `versions/`, `libraries/`, `assets/`, `logs/` live
  directly inside it. The agent registers it as the selected `GameDirectory` (persisted in
  `game-directories.json`) so HMCL's repository is bound to it.
- The agent process stays alive via a non-daemon keepalive thread; request threads are daemon.
  `POST /shutdown` replies first, then calls `System.exit(0)` after ~200 ms.
- HMCL's own JavaFX GUI is **never started**; only the core + `setting`/`game`/`download`/
  `modpack`/`launch` classes are used. Requires `javafx-base` + `javafx-graphics` +
  `javafx-controls` (pure-Java `-win` jars, version 21.0.8 for HMCL 3.16.3) on the classpath —
  `LauncherSettings` pulls in `FXUtils` which references `javafx.scene.control.Labeled`.

## Conventions

- **Headers**: every request must carry `X-HMCL-Agent-Token: <token>` (default `hmcl-mcp`,
  override with `-Dhmcl.agent.token`). Wrong/missing token → `403`.
- **Content-Type**: request bodies and responses are `application/json; charset=utf-8`.
- **Response shape**: success is `{"ok": true, ...payload}` — payload fields are spread at the
  **top level** next to `ok`. Failure is `{"ok": false, "error": "human readable message"}`.
- All install/launch operations run **synchronously** on the request thread (blocking
  `Task.executor().test()`, which maintains HMCL's task state correctly — plain `Task.run()`
  breaks tasks like the multi-source version list) and are serialized by an internal lock —
  a long download may block its request for minutes.
- HTTP status is `200` for handled failures (`ok:false`), `403` for bad token, `404` for unknown
  routes, `405` for wrong method, `500` for unexpected agent-internal errors.
- Agent logs go to **stderr** with the `[hmcl-agent]` prefix.

## Routes

### `GET /status`

Agent + repository health.

Response:

```json
{
  "ok": true,
  "hmclVersion": "3.16.3",
  "workdir": "D:\\mc",
  "java": "C:\\Program Files\\Java\\jdk-21\\jre",
  "versions": ["1.20.1", "1.20.4"],
  "running": false,
  "gamePid": null
}
```

| field | meaning |
|---|---|
| `hmclVersion` | HMCL version from the jar's `assets/hmcl.properties` (`hmcl.version`) |
| `workdir` | the `-Dhmcl.gameDir` value |
| `java` | `java.home` of the agent JVM |
| `versions` | installed instance ids (sorted) |
| `running` | whether a tracked game process is alive |
| `gamePid` | pid of the running game, omitted when `running` is false |

### `POST /versions/install`

Install a vanilla Minecraft version through HMCL's download pipeline
(`GameBuilder`: version JSON + client jar + libraries + assets index/objects).

Request: `{"version": "1.20.4"}`

Response (success): `{"ok": true, "id": "1.20.4"}`

Common failures (`ok:false`): already installed; version not found in the remote version list
(`error` names the remote list source); network/IO failures from HMCL tasks
(`error` carries `Task.getException()` message); a task timeout (`error` says
`timed out after Ns` — the download source is unreachable; the underlying task may keep
retrying in the background). Note: HMCL's `GameBuilder` **rolls the version back from disk**
when its build fails, so a failed install leaves no half-built instance behind (the client
jar may survive deletion when a verifying thread still holds it open — retry is safe).

### `POST /versions/remote`

List Minecraft versions available for `/versions/install` from the remote version list
(refreshes the list first; same source as the HMCL UI).

Request: `{"type": "release"}` — optional; `"release"` / `"snapshot"` / omitted (= all).

Response (success):

```json
{
  "ok": true,
  "versions": [
    { "id": "1.21.4", "type": "release", "releaseDate": "2024-12-03T12:39:22Z" }
  ]
}
```

### `POST /modpack/search`

Search modpacks through HMCL's own addon repositories (`ModrinthRemoteAddonRepository.MODPACKS`
or `CurseForgeRemoteAddonRepository.MODPACKS` — CurseForge uses HMCL's embedded API key).

Request: `{"source": "modrinth", "query": "fabric", "limit": 20}` — `source` optional
(defaults to modrinth), `limit` clamped to 1..50.

Response (success): `{"ok": true, "hits": [ { "id": "<slug>", "title": "...", "description": "...",
"authors": ["..."], "url": "..." } ], "totalPages": 3}`.

### `POST /modpack/info`

Project summary + version list for one modpack (`id` = Modrinth slug or CurseForge slug).

Request: `{"source": "modrinth", "id": "fabulously-optimized"}`

Response (success): `{"ok": true, "summary": {...}, "versions": [ { "id": "<version name>",
"version": "<version number>", "gameVersions": ["1.21.4"], "loaders": ["fabric"] } ]}` (max 50 versions).

### `POST /modpack/download`

Download a modpack file (SHA-1 verified via HMCL's `FileDownloadTask`) into `<gameDir>/mcpacks/`.
`versionId` matches a version `name` or `version` from `/modpack/info`; omitted = newest.

Request: `{"source": "modrinth", "id": "fabulously-optimized", "versionId": "..."}`

Response (success): `{"ok": true, "id": "<version name>", "version": "<version number>",
"gameVersions": [...], "filename": "pack.mrpack", "path": "D:\\mc\\mcpacks\\pack.mrpack",
"size": 12345, "sha1": "..."}`.

### `POST /mods/search`

Search single mods through HMCL's MODS repositories (`ModrinthRemoteAddonRepository.MODS` /
`CurseForgeRemoteAddonRepository.MODS`). Same shape as `/modpack/search` plus an optional
`gameVersion` filter passed to the repository.

Request: `{"source": "modrinth", "query": "sodium", "gameVersion": "1.21.4", "limit": 20}`

Response (success): `{"ok": true, "hits": [ { "id": "<slug>", "numericId": "306612", "downloads": 642357868, "title": "...", ... } ], "totalPages": N}` — `numericId` and `downloads` are only present for CurseForge hits (`numericId` is the numeric project id CurseForge's detail/file APIs require).

### `POST /mods/info`

Mod project summary + version list. Same shape as `/modpack/info`; each version also carries
`filename` when the file name is known, and `loaders` is a list of ModLoaderType names
(`FABRIC`, `FORGE`, `NEO_FORGE`, `QUILT`, ...).

CurseForge's detail/file APIs only accept the numeric project id, so a non-numeric `id` is
resolved through a slug-matching search first (one extra request); if no mod matches, the
error suggests taking `numericId` from the search results.

### `POST /mods/download`

Download a mod file (SHA-1 verified) into `<gameDir>/modfiles/`. Already-downloaded files are
reused (no re-download when the target exists).

Request: `{"source": "modrinth", "id": "sodium", "versionId": "..."}` — `versionId` optional
(matches the version `name` or `version`; omitted = newest).

Response (success): `{"ok": true, "id": "...", "version": "...", "gameVersions": [...],
"filename": "sodium-0.6.x.jar", "path": "D:\\mc\\modfiles\\sodium-0.6.x.jar", "size": 987654}`.

### `POST /mods/install`

Place a mod into an instance's mods directory (`<gameDir>/versions/<instance>/mods/`). Either
`id` (download via `/mods/download` semantics, cached in `modfiles/`) or `path` (local file)
must be given; `instance` must already be installed.

Request: `{"source": "modrinth", "id": "sodium", "versionId": "...", "instance": "1.21.4-fabric"}`
or `{"path": "D:\\mods\\sodium.jar", "instance": "1.21.4-fabric"}`

Response (success): `{"ok": true, "instance": "1.21.4-fabric",
"modsDir": "D:\\mc\\versions\\1.21.4-fabric\\mods", "filename": "sodium-0.6.x.jar",
"path": "D:\\mc\\versions\\1.21.4-fabric\\mods\\sodium-0.6.x.jar"}`.

### `POST /mods/list`

List the `.jar` files in `<gameDir>/versions/<instance>/mods/`.

Request: `{"instance": "1.21.4-fabric"}`

Response (success): `{"ok": true, "instance": "...", "modsDir": "...",
"mods": [ { "filename": "sodium-0.6.x.jar", "size": 987654 } ]}`.

### `POST /loaders/list`

List loader versions available for one Minecraft version. `loader` must be one of HMCL's
VersionList ids: `fabric`, `forge`, `neoforge`, `quilt`, `optifine`, `liteloader`,
`legacyfabric`, `cleanroom`.

Request: `{"loader": "fabric", "gameVersion": "1.21.4"}`

Response (success):

```json
{
  "ok": true,
  "loader": "fabric",
  "gameVersion": "1.21.4",
  "versions": [
    { "id": "0.16.14", "fullVersion": "fabric-loader-0.16.14-1.21.4", "gameVersion": "1.21.4" }
  ]
}
```

`id` is the loader's own version (`RemoteVersion.getSelfVersion()`); `fullVersion` is the
instance id HMCL would use for a dedicated install.

### `POST /loader/install`

Install a mod loader, two modes:

- **Existing instance** (`instance` given): patches the instance with the loader via
  `DefaultDependencyManager.installLibraryAsync(Version, RemoteVersion)` — the raw
  (unresolved) version is passed in. The call downloads the loader libraries and only
  RETURNS the patched `Version` (id = the loader profile's id); the agent persists it
  with `repository.saveAsync(patched.setId(instance))`, keeping the user-facing id.
  The instance's Minecraft version must match the loader's target (`remote.getGameVersion()`).
- **New instance** (`gameVersion` given, no `instance`): built in TWO phases — first the
  vanilla game via `GameBuilder.name(name).gameVersion(mc).buildAsync()`, verified
  (`hasVersion`), then the loader patch via `installLibraryAsync` on that instance.
  A single all-in-one build would roll the whole version back on any loader-stage failure;
  the two-phase split keeps a playable vanilla instance alive when the loader stage fails.
  `name` defaults to `<mc>-<loader>`; an existing instance with the same name is reused
  (only its loader stage runs, response carries `"reused": true`).

Request: `{"loader": "fabric", "versionId": "0.16.14", "gameVersion": "1.21.4", "name": "my-fabric"}`
or `{"loader": "forge", "versionId": "51.0.5", "instance": "1.20.4"}` — `fullVersion` may replace
`versionId`; `gameVersion` may be omitted when `instance` is given (derived from the instance).

Response (success): `{"ok": true, "instance": "my-fabric", "loader": "fabric",
"loaderVersion": "0.16.14", "fullVersion": "fabric-loader-0.16.14-1.21.4", "gameVersion": "1.21.4"}`
(`gameVersion` only present in the new-instance mode).

All install/refresh/download endpoints bound their blocking wait
(refresh 3 min, file download 8 min, install 20 min, launch completion check 15 min);
a dead download source fails the request with `timed out after Ns` instead of hanging it.

### `POST /modpack/install`

Import a modpack `.zip` file (mrpack / CurseForge / MultiMC / MCBBS / HMCL) into a new
instance under `versions/<name>/`. Manifest encoding is auto-detected (UTF-8, then GBK).

Request: `{"path": "D:\\packs\\pack.zip", "name": "MyPack"}` — `name` is optional; defaults to
the pack's own name.

Response (success):

```json
{
  "ok": true,
  "name": "MyPack",
  "format": "mrpack",
  "gameVersion": "1.20.4",
  "modLoader": "fabric"
}
```

`format` is `"mrpack"` (Modrinth), `"curseforge"` (CurseForge), or `"hmcl"` (MultiMC/MCBBS/
HMCL/server packs). `gameVersion`/`modLoader` are omitted when unknown; `modLoader` is detected
by scanning the installed version's libraries (`fabric`, `quilt`, `forge`, `neoforge`,
`liteloader`, `optifine`).

Common failures: file not found; unsupported/unreadable pack; invalid or conflicting instance name.

### `POST /launch`

Launch an installed instance (offline account). Runs HMCL's pre-launch completion check
(downloads missing libraries/assets), then `DefaultLauncher.launch()`; the game is a child
process whose stdout/stderr is redirected to `<gameDir>/logs/<instance>-<timestamp>.log`.

Request — all fields optional:

```json
{
  "version": "1.20.4",
  "username": "Steve",
  "maxMemory": 4096,
  "javaPath": "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe",
  "extraArgs": ["-Dfoo=bar"]
}
```

| field | default | notes |
|---|---|---|
| `version` | selected instance | instance id (a dir under `versions/`); must be installed |
| `username` | `"Steve"` | offline player name; UUID is derived deterministically |
| `maxMemory` | instance setting | heap in MB (`-Xmx`) |
| `javaPath` | agent JVM's own java | path to a `java`/`java.exe`; probed via HMCL's `JavaInfoUtils` |
| `extraArgs` | `[]` | raw JVM args appended to the launch command (`javaArguments`) |

Response (success):

```json
{
  "ok": true,
  "pid": 4421,
  "instanceId": "1.20.4",
  "gameVersion": "1.20.4",
  "loader": "fabric",
  "java": "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe",
  "logPath": "D:\\mc\\logs\\1.20.4-20260810-101411-123.log"
}
```

`loader` is omitted when the instance has no detected loader. Only one game may run at a time —
a second `/launch` while one is running fails with `ok:false`.

### `POST /launch/stop`

Stop the tracked game process (graceful destroy, force-kill after 5 s if needed).

Response: `{"ok": true, "message": "Stop signal sent to the game process"}` (also succeeds
when nothing is running: `"No game is currently running"`).

### `POST /shutdown`

Reply `{"ok": true, "message": "Shutting down"}` immediately, then terminate the JVM after
~200 ms (the shutdown hook stops the tracked game first). The Node server should call this to
stop the agent and treat the process exit as the success signal.

## Notes / limitations

- `premain` is deliberately a no-op: the agent is always launched via its `Main-Class`
  (`hmcl.agent.AgentMain`). Injecting into a running HMCL GUI JVM is not supported.
- Launch uses HMCL's core `DefaultLauncher` (not the UI's `HMCLGameLauncher`), and skips the
  HMCL-module `MaintainTask`/`NativePatcher` steps — fine for vanilla and modern loader
  versions; very old versions (≤ 1.12) may need the memory patch HMCL normally applies.
- `POST /versions/install` does not download assets (matches the HMCL UI); the first
  `/launch` of an instance downloads them.
- The repository is scanned at agent startup and re-scanned after each install/launch route
  (`repository.refreshVersions()`). Version folders added externally while the agent runs are
  picked up by the next mutating route; `GET /status` alone does not re-scan.
