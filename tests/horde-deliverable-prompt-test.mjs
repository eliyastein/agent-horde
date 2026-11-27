// The deliverable instructions keep "no recorded attempt" apart from "it was never run".
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
const { deliverableTask } = await jiti.import("../src/run/synthesis.ts");

const task = deliverableTask({ id: "R1", prompt: "audit the loader", runDir: "/tmp/h/runs/R1", hordeDir: "/tmp/h" });
const flat = task.replace(/\s+/g, " ");
assert.match(flat, /only when a finding, fact or review records an attempt at it/, "a negative claim needs a recorded attempt");
assert.match(flat, /write "not attempted in this run" and do not list the item as a defect/, "no attempt is labelled, not reported as a defect");
assert.match(flat, /name the prerequisite as an environment note/, "an environment failure is reported as one");
assert.match(task, /audit the loader/, "the task text is carried into the prompt");

console.log("PASS: horde-deliverable-prompt-test");
