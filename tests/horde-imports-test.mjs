// Every relative value import in the extension names a real export. jiti only
// transpiles, so a misnamed import after moving code would otherwise load as
// undefined and fail only when that path runs.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti, DEPS, extensionDir, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "tests" || entry.name.startsWith(".") ? [] : sourceFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const IMPORT = /^import\s+(type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+"(\.[^"]+)";/gm;

const files = sourceFiles(extensionDir);
assert.ok(files.length > 5, `expected extension sources under ${extensionDir}`);
let checked = 0;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const [, typeOnly, defaultName, braces, spec] of source.matchAll(IMPORT)) {
    if (typeOnly) continue;
    const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
    assert.ok(fs.existsSync(target), `${path.relative(extensionDir, file)}: ${spec} does not exist`);
    const names = (braces ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && !item.startsWith("type "))
      .map((item) => item.split(/\s+as\s+/)[0]);
    if (defaultName) names.push("default");
    if (names.length === 0) continue;
    const mod = await jiti.import(target);
    for (const name of names) {
      assert.ok(
        name in mod,
        `${path.relative(extensionDir, file)}: "${name}" is not exported by ${spec}`,
      );
      checked++;
    }
  }
}
assert.ok(checked > 50, `only ${checked} imports checked; is the import regex still matching?`);
console.log(`horde-imports-test: ${checked} imports across ${files.length} files OK`);
