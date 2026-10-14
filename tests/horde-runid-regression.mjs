// Regression: allocateRunDir must not reuse a run directory that already
// exists for the same second; it appends -1, -2, ...
// This file doubles as the fake `pi --mode json` child.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

delete process.env.PI_HORDE_MEMBER;
delete process.env.PI_HORDE_DIR;
delete process.env.PI_HORDE_NAME;
delete process.env.PI_HORDE_RUN;
process.env.PI_HORDE_POSTMORTEM = "off";
process.env.PI_HORDE_DELIVERABLE = "off";
import { createJiti, DEPS, PI } from "./harness.mjs";

if (process.argv.includes("--mode")) process.exit(0);

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const { default: agentHordeExtension } = await jiti.import(
  "../src/index.ts",
);
const { formatRunId } = await jiti.import("../src/format.ts");

function makePi() {
  const commands = new Map();
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => commands.set(name, def),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: () => {},
  };
  agentHordeExtension(pi);
  return commands.get("agent-horde").handler;
}

let ok = false;
let last = "";
for (let attempt = 0; attempt < 5 && !ok; attempt++) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-runid-"));
  const runsDir = path.join(cwd, ".horde", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const base = formatRunId(new Date());
  fs.mkdirSync(path.join(runsDir, base));
  fs.mkdirSync(path.join(runsDir, base, "sessions"));

  const ui = { notify: () => {}, setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, isProjectTrusted: () => true };
  await makePi()("1 collision test", ctx);
  await new Promise((r) => setTimeout(r, 800));

  const dirs = fs.readdirSync(runsDir).sort();
  last = JSON.stringify(dirs);
  if (dirs.length === 2 && dirs[0] === base && dirs[1] === `${base}-1`) ok = true;
}

if (!ok) throw new Error(`allocateRunDir did not suffix the colliding run dir: ${last}`);
console.log("PASS: horde-runid-regression");
