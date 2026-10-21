import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti, DEPS, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const { buildInfo, packageRoot, readBuildInfo } = await jiti.import("../src/build-info.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// This checkout: version from package.json, commit from git, the two memoized together.
assert.equal(packageRoot(), root);
const here = readBuildInfo(root);
assert.equal(here.name, "agent-horde");
assert.equal(here.version, pkg.version);
assert.equal(here.repository, "https://github.com/eliyastein/agent-horde");
const head = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.ok(here.commit === head || here.commit === `${head}-dirty`, `commit ${here.commit} is HEAD ${head}`);
assert.deepEqual(buildInfo(), here);
assert.equal(buildInfo(), buildInfo(), "read once");

// An installed package: no .git of its own, so no commit, even inside a repository that has one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-build-"));
const nested = path.join(tmp, "node_modules", "agent-horde");
fs.mkdirSync(nested, { recursive: true });
execFileSync("git", ["init", "-q", tmp]);
fs.writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "agent-horde", version: "9.9.9", repository: "github:eliyastein/agent-horde" }));
const installed = readBuildInfo(nested);
assert.deepEqual(installed, { name: "agent-horde", version: "9.9.9", commit: undefined, repository: undefined });

// A checkout with no commits yet, and a corrupt .git file, each report no commit rather than failing.
const empty = path.join(tmp, "empty");
fs.mkdirSync(empty);
execFileSync("git", ["init", "-q", empty]);
fs.writeFileSync(path.join(empty, "package.json"), JSON.stringify({ name: "x", version: "0.0.1", repository: { type: "git", url: "git+https://example.com/x.git" } }));
assert.deepEqual(readBuildInfo(empty), { name: "x", version: "0.0.1", commit: undefined, repository: "https://example.com/x" });
const broken = path.join(tmp, "broken");
fs.mkdirSync(broken);
fs.writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent\n");
fs.writeFileSync(path.join(broken, "package.json"), JSON.stringify({ name: "x", version: "0.0.2" }));
assert.equal(readBuildInfo(broken).commit, undefined);

// A missing or incomplete package.json is an install problem and says so.
assert.throws(() => readBuildInfo(tmp), /cannot read .*package\.json.*reinstall/);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x" }));
assert.throws(() => readBuildInfo(tmp), /no name or version/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS: horde-build-info-test");
