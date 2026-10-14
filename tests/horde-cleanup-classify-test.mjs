// A resource teardown is idempotent: removing the target and finding it already
// gone both leave it gone, so only a real error or a timeout is a failure.
import assert from "node:assert/strict";
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
const { classifyCleanup } = await jiti.import("../src/run/finalize.ts");

const R = (over) => ({ code: 0, timedOut: false, stderr: "", ...over });

// Removed the target.
assert.equal(classifyCleanup("docker rm -f lab", R({ code: 0 })), "ok");

// Already gone: pkill with no match exits 1 and prints nothing.
assert.equal(classifyCleanup("pkill -f 'php -S 127.0.0.1:8099'", R({ code: 1 })), "noop");
assert.equal(classifyCleanup("pgrep -f mock", R({ code: 1 })), "noop");
// Container tools say so on stderr.
assert.equal(
  classifyCleanup("docker rm -f lab", R({ code: 1, stderr: "Error: No such container: lab" })),
  "noop",
);
assert.equal(
  classifyCleanup("docker stop lab", R({ code: 1, stderr: "Error response: container lab is not running" })),
  "noop",
);

// Real failures stay failures.
assert.equal(
  classifyCleanup("docker rm -f lab", R({ code: 1, stderr: "permission denied while trying to connect" })),
  "failed",
);
assert.equal(classifyCleanup("docker rm -f lab", R({ code: null, timedOut: true })), "failed");
// A non-kill command that exits 1 with no stderr is not assumed benign.
assert.equal(classifyCleanup("docker rm -f lab", R({ code: 1 })), "failed");

console.log("PASS: horde-cleanup-classify-test");
