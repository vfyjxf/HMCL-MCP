package launcher;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Entry point of the self-contained {@code hmcl-mcp.jar}.
 *
 * <p>The jar bundles four things:
 * <ul>
 *   <li>{@code /app} — the compiled MCP server ({@code dist/}) plus its production
 *       dependencies, laid out as a normal Node ESM package;</li>
 *   <li>{@code /runtime/node.exe} — the Node runtime used to execute it;</li>
 *   <li>{@code /hmcl} — {@code HMCL.jar}, {@code hmcl-agent.jar} and the JavaFX jars
 *       the agent needs on its classpath;</li>
 *   <li>{@code /launcher} — this class.</li>
 * </ul>
 *
 * <p>On startup the resources are unpacked into {@code <workdir>/.launcher} (cached
 * between runs) and {@code /hmcl} is seeded into {@code <workdir>/hmcl} when missing, so
 * the {@code install_hmcl} tool has nothing left to download. Then the Node process is
 * started with the parent's stdio inherited — the MCP JSON-RPC stream goes straight
 * through, which is exactly what a stdio MCP client expects.
 */
public final class Launcher {

    private static final String APP_VERSION = "0.1.0";

    private Launcher() {
    }

    public static void main(String[] args) throws Exception {
        Path jar = locateJar();
        Path workdir = resolveWorkdir();
        Path hmclDir = resolveHmclDir(workdir);
        Path runtimeDir = workdir.resolve(".launcher");

        log("hmcl-mcp launcher " + APP_VERSION);
        log("  jar      = " + jar);
        log("  workdir  = " + workdir);

        seedHmclFiles(jar, hmclDir);
        Path nodeExe = unpackRuntime(jar, runtimeDir, workdir);

        Path appDir = runtimeDir.resolve("app");
        List<String> env = new ArrayList<>();

        ProcessBuilder pb = new ProcessBuilder(
                nodeExe.toString(),
                appDir.resolve("dist").resolve("index.js").toString());
        pb.directory(appDir.toFile());
        pb.redirectInput(ProcessBuilder.Redirect.INHERIT);
        pb.redirectOutput(ProcessBuilder.Redirect.INHERIT);
        pb.redirectError(ProcessBuilder.Redirect.INHERIT);
        pb.environment().put("HMCL_MCP_HMCL_DIR", hmclDir.toString());
        pb.environment().put("HMCL_MCP_WORKDIR", workdir.toString());
        // Keep the unpacked app from being scanned by the MCP server's own file probes.
        pb.environment().put("HMCL_MCP_BUNDLED", "1");

        log("  node     = " + nodeExe);
        log("  app      = " + appDir.resolve("dist").resolve("index.js"));
        log("  hmcl dir = " + hmclDir);

        Process proc = pb.start();
        int code = proc.waitFor();
        log("node exited with code " + code);
        System.exit(code);
    }

    /** Absolute path of the running jar (or the classes dir when run from an IDE). */
    private static Path locateJar() throws Exception {
        Path self = Paths.get(Launcher.class.getProtectionDomain()
                .getCodeSource().getLocation().toURI());
        return self.toAbsolutePath().normalize();
    }

    private static Path resolveWorkdir() {
        String raw = System.getenv("HMCL_MCP_WORKDIR");
        if (raw == null || raw.isBlank()) {
            raw = Paths.get(System.getProperty("user.home"), ".hmcl-mcp").toString();
        }
        Path p = Paths.get(raw.trim());
        if (p.toString().startsWith("~")) {
            p = Paths.get(System.getProperty("user.home"), p.toString().substring(1));
        }
        return p.toAbsolutePath().normalize();
    }

    private static Path resolveHmclDir(Path workdir) {
        String raw = System.getenv("HMCL_MCP_HMCL_DIR");
        if (raw == null || raw.isBlank()) {
            return workdir.resolve("hmcl");
        }
        return Paths.get(raw.trim()).toAbsolutePath().normalize();
    }

    /**
     * Copies the bundled HMCL runtime into {@code hmclDir} — only files that are not
     * there yet, so an existing installation (or a newer HMCL.jar) is never overwritten.
     */
    private static void seedHmclFiles(Path jar, Path hmclDir) throws IOException {
        Files.createDirectories(hmclDir);
        copyIfAbsent(jar, "/hmcl/HMCL.jar", hmclDir.resolve("HMCL.jar"));
        copyIfAbsent(jar, "/hmcl/hmcl-agent.jar", hmclDir.resolve("hmcl-agent.jar"));
        // JavaFX jars are matched by the client as /^javafx-.+-win\.jar$/.
        for (String name : bundledNames(jar, "hmcl")) {
            if (name.startsWith("javafx-") && name.endsWith(".jar")) {
                copyIfAbsent(jar, "/hmcl/" + name, hmclDir.resolve(name));
            }
        }
    }

    /**
     * Unpacks the Node runtime and the app bundle into {@code runtimeDir}.
     *
     * @return the node executable to use — the bundled one when present, otherwise
     *         {@code node} from {@code PATH} (so the jar still works on Linux/macOS
     *         where no Windows binary can be shipped).
     */
    private static Path unpackRuntime(Path jar, Path runtimeDir, Path workdir) throws IOException {
        Files.createDirectories(runtimeDir);

        String bundled = "/runtime/" + nodeBinaryName();
        Path nodeExe = runtimeDir.resolve(nodeBinaryName());
        if (hasResource(jar, bundled)) {
            copyIfAbsent(jar, bundled, nodeExe);
            nodeExe.toFile().setExecutable(true);
        } else {
            log("no bundled Node runtime for " + System.getProperty("os.name")
                    + " — falling back to 'node' from PATH");
            nodeExe = Paths.get("node");
        }

        unpackApp(jar, runtimeDir.resolve("app"));
        return nodeExe;
    }

    /**
     * Extracts {@code /app} into {@code appDir}.
     *
     * <p>The app tree holds the whole {@code node_modules} of the server, so it is
     * extracted only when the build id changed — a marker file inside the jar is
     * compared with the one already on disk.
     */
    private static void unpackApp(Path jar, Path appDir) throws IOException {
        String buildId = readResourceString(jar, "/app/.build-id");
        Path marker = appDir.resolve(".build-id");
        String current = Files.exists(marker) ? Files.readString(marker).trim() : "";

        if (!current.equals(buildId)) {
            log("unpacking the server bundle ...");
            deleteTree(appDir);
            Files.createDirectories(appDir);
            copyTree(jar, "app", appDir);
            if (!buildId.isEmpty()) {
                Files.writeString(marker, buildId);
            }
            log("  bundle unpacked (" + buildId + ")");
        } else {
            log("  bundle already unpacked (" + buildId + ")");
        }

        Path entry = appDir.resolve("dist").resolve("index.js");
        if (!Files.isRegularFile(entry)) {
            throw new IOException("the server bundle was not unpacked correctly: " + entry + " is missing");
        }
    }

    /** Reads a small text resource from the jar; returns "" when absent. */
    private static String readResourceString(Path jar, String resource) {
        try (InputStream in = Launcher.class.getResourceAsStream(resource)) {
            if (in == null) {
                return "";
            }
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return "";
        }
    }

    /** Extracts every file under {@code dir} in the jar into {@code targetDir}.
     *  Note: jar entry names have no leading slash ("app/dist/index.js"). */
    private static void copyTree(Path jar, String dir, Path targetDir) throws IOException {
        int prefix = dir.length() + 1;
        try (java.util.jar.JarFile jf = new java.util.jar.JarFile(jar.toFile())) {
            var entries = jf.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                String name = entry.getName();
                if (!name.startsWith(dir + "/") || entry.isDirectory()) {
                    continue;
                }
                Path out = targetDir.resolve(name.substring(prefix));
                Files.createDirectories(out.getParent());
                try (InputStream in = jf.getInputStream(entry);
                     OutputStream os = Files.newOutputStream(out)) {
                    in.transferTo(os);
                }
            }
        }
    }

    /** Recursively deletes a directory tree (best effort). */
    private static void deleteTree(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return;
        }
        try (var stream = Files.walk(dir)) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort
                }
            });
        }
    }

    private static String nodeBinaryName() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")
                ? "node.exe"
                : "node";
    }

    /** Copies {@code resource} to {@code target} unless the target already exists. */
    private static void copyIfAbsent(Path jar, String resource, Path target) throws IOException {
        if (Files.exists(target)) {
            return;
        }
        try (InputStream in = Launcher.class.getResourceAsStream(resource)) {
            if (in == null) {
                return;
            }
            Files.createDirectories(target.getParent());
            try (OutputStream out = Files.newOutputStream(target)) {
                in.transferTo(out);
            }
            log("  seeded " + target.getFileName());
        }
    }

    private static boolean hasResource(Path jar, String resource) {
        try (InputStream in = Launcher.class.getResourceAsStream(resource)) {
            return in != null;
        } catch (IOException e) {
            return false;
        }
    }

    /** Lists the file names directly under a directory resource inside the jar. */
    private static List<String> bundledNames(Path jar, String dir) {
        List<String> names = new ArrayList<>();
        try (java.util.jar.JarFile jf = new java.util.jar.JarFile(jar.toFile())) {
            var e = jf.entries();
            while (e.hasMoreElements()) {
                String name = e.nextElement().getName();
                if (name.startsWith(dir + "/") && name.indexOf('/', dir.length() + 1) < 0) {
                    names.add(name.substring(dir.length() + 1));
                }
            }
        } catch (IOException ignored) {
            // Non-jar classpath entry: nothing to seed.
        }
        return names;
    }
    private static void log(String message) {
        System.err.println("[hmcl-mcp-launcher] " + message);
    }
}
