// Shared bootstrap for the agent-horde tests. Resolves the installed pi package
// and jiti without hardcoding a machine path, so the suite runs on any host.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionDir = path.resolve(here, "..", "src");

function resolvePiDir() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  // The pinned devDependency: the package's exports map hides package.json from
  // require.resolve, so look for the directory itself.
  candidates.push(path.resolve(here, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
  try {
    const require = createRequire(import.meta.url);
    candidates.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
  } catch {
    // Not installed locally; fall through to the global installs.
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) candidates.push(path.join(root, "@earendil-works/pi-coding-agent"));
  } catch {
    // npm not available; fall through.
  }
  const managed = path.join(os.homedir(), ".pi", "agent", "install");
  try {
    const version = fs.readFileSync(path.join(managed, "current-version"), "utf8").trim();
    candidates.push(path.join(managed, "releases", version, "node_modules/@earendil-works/pi-coding-agent"));
  } catch {
    // No managed install; fall through.
  }
  if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent");
  }
  candidates.push("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent");
  candidates.push("/usr/lib/node_modules/@earendil-works/pi-coding-agent");
  const found = candidates.find((dir) => dir && fs.existsSync(path.join(dir, "package.json")));
  if (!found) {
    throw new Error(
      "could not locate @earendil-works/pi-coding-agent; install it or set PI_PACKAGE_DIR",
    );
  }
  return found;
}

export const PI = resolvePiDir();
// Dependencies are nested under the package in npm global installs and hoisted in managed installs.
const nested = path.join(PI, "node_modules");
export const DEPS = fs.existsSync(path.join(nested, "jiti")) ? nested : path.resolve(PI, "..", "..");
const { createJiti } = await import(path.join(DEPS, "jiti", "lib", "jiti.mjs"));
export { createJiti };
