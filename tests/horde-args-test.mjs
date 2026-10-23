import assert from "node:assert/strict";
import { createJiti } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { parseHordeArgs, MAX_MEMBERS } = await jiti.import("../src/args.ts");

assert.deepEqual(parseHordeArgs(""), { kind: "usage" });
assert.deepEqual(parseHordeArgs("   "), { kind: "usage" });
assert.deepEqual(parseHordeArgs("help"), { kind: "help" });

assert.deepEqual(parseHordeArgs("status"), { kind: "status", target: { kind: "all" } });
assert.deepEqual(parseHordeArgs("status member-2"), {
  kind: "status",
  target: { kind: "members", names: ["member-2"] },
});

assert.deepEqual(parseHordeArgs("stop"), {
  kind: "stop",
  mode: "hard",
  target: { kind: "all" },
  postmortem: false,
  graceMs: undefined,
});
assert.deepEqual(parseHordeArgs(" stop-hard 2 "), {
  kind: "stop",
  mode: "hard",
  target: { kind: "members", names: ["member-2"] },
  postmortem: false,
  graceMs: undefined,
});
assert.deepEqual(parseHordeArgs("stop-clean"), {
  kind: "stop",
  mode: "clean",
  target: { kind: "all" },
  postmortem: false,
  graceMs: undefined,
});
assert.deepEqual(parseHordeArgs("stop-clean member-1, member-3"), {
  kind: "stop",
  mode: "clean",
  target: { kind: "members", names: ["member-1", "member-3"] },
  postmortem: false,
  graceMs: undefined,
});
assert.deepEqual(parseHordeArgs("stop-clean postmortem"), {
  kind: "stop",
  mode: "clean",
  target: { kind: "all" },
  postmortem: true,
  graceMs: undefined,
});
assert.deepEqual(parseHordeArgs("stop-clean postmortem member-2 --grace 45"), {
  kind: "stop",
  mode: "clean",
  target: { kind: "members", names: ["member-2"] },
  postmortem: true,
  graceMs: 45_000,
});
assert.equal(parseHordeArgs("stop-clean --grace").kind, "usage");
assert.equal(parseHordeArgs("stop-hard postmortem").kind, "usage");

assert.deepEqual(parseHordeArgs("pause 3"), {
  kind: "pause",
  target: { kind: "members", names: ["member-3"] },
});
assert.deepEqual(parseHordeArgs("resume all"), { kind: "resume", target: { kind: "all" } });
assert.equal(parseHordeArgs("pause member-99").kind, "usage");
assert.match(parseHordeArgs("pause member-99").error, /invalid target/);

assert.deepEqual(parseHordeArgs("5 find auth bypasses"), {
  kind: "run",
  count: 5,
  prompt: "find auth bypasses",
});
assert.deepEqual(parseHordeArgs("1 multi\nline prompt"), {
  kind: "run",
  count: 1,
  prompt: "multi\nline prompt",
});
assert.equal(parseHordeArgs("0 x").kind, "usage");
assert.match(parseHordeArgs("0 x").error, /1 to 12/);
assert.equal(parseHordeArgs(`${MAX_MEMBERS + 1} x`).kind, "usage");
assert.equal(parseHordeArgs("abc x").kind, "usage");
assert.equal(parseHordeArgs("5").kind, "usage");
assert.match(parseHordeArgs("5").error, /prompt is required/);

// A numeric prompt keeps working even when it names a subcommand.
assert.deepEqual(parseHordeArgs("1 status"), { kind: "run", count: 1, prompt: "status" });
assert.deepEqual(parseHordeArgs("2 stop-clean"), { kind: "run", count: 2, prompt: "stop-clean" });
assert.deepEqual(parseHordeArgs("plan 3 alpha layer; beta layer; gamma layer"), {
  kind: "run",
  count: 3,
  prompt: "alpha layer; beta layer; gamma layer",
  plan: ["alpha layer", "beta layer", "gamma layer"],
});
assert.equal(parseHordeArgs("plan 3 onlyone").kind, "usage");
assert.equal(parseHordeArgs("plan x a; b").kind, "usage");


// --dashboard launch flag, before or after the count, with or without a port.
const dash = { kind: "run", count: 3, prompt: "find bugs", dashboard: {} };
assert.deepEqual(parseHordeArgs("--dashboard 3 find bugs"), dash);
assert.deepEqual(parseHordeArgs("3 --dashboard find bugs"), dash);
const dashPort = { kind: "run", count: 3, prompt: "find bugs", dashboard: { port: 8080 } };
assert.deepEqual(parseHordeArgs("--dashboard=8080 3 find bugs"), dashPort);
assert.deepEqual(parseHordeArgs("3 --dashboard=8080 find bugs"), dashPort);
assert.deepEqual(parseHordeArgs("plan --dashboard 2 a; b"), {
  kind: "run", count: 2, prompt: "a; b", plan: ["a", "b"], dashboard: {},
});
assert.deepEqual(parseHordeArgs("plan 2 --dashboard=9000 a; b"), {
  kind: "run", count: 2, prompt: "a; b", plan: ["a", "b"], dashboard: { port: 9000 },
});
// A flag inside the prompt is prompt text; a leading flag wins over a trailing one.
assert.deepEqual(parseHordeArgs("3 find --dashboard bugs"), {
  kind: "run", count: 3, prompt: "find --dashboard bugs",
});
assert.deepEqual(parseHordeArgs("--dashboard=1 3 --dashboard=2 x"), {
  kind: "run", count: 3, prompt: "x", dashboard: { port: 1 },
});
for (const bad of ["--dashboard=abc 3 x", "--dashboard=0 3 x", "--dashboard=70000 3 x", "3 --dashboard=abc x"]) {
  assert.equal(parseHordeArgs(bad).kind, "usage", bad);
  assert.match(parseHordeArgs(bad).error, /invalid --dashboard/, bad);
}
assert.match(parseHordeArgs("--dashboard").error, /count is required/);
assert.match(parseHordeArgs("--dashboard 3").error, /prompt is required/);
assert.equal(parseHordeArgs("--dashboard status").kind, "usage");
console.log("PASS: horde-args-test dashboard flag");

// --no-verifier launch flag, alone or combined with --dashboard, in any order.
const noVerifier = { kind: "run", count: 3, prompt: "x", noVerifier: true };
assert.deepEqual(parseHordeArgs("--no-verifier 3 x"), noVerifier);
assert.deepEqual(parseHordeArgs("3 --no-verifier x"), noVerifier);
assert.deepEqual(parseHordeArgs("--no-verifier --dashboard 3 x"), { ...noVerifier, dashboard: {} });
assert.deepEqual(parseHordeArgs("--dashboard=8080 --no-verifier 3 x"), {
  ...noVerifier, dashboard: { port: 8080 },
});
assert.deepEqual(parseHordeArgs("3 --dashboard --no-verifier x"), { ...noVerifier, dashboard: {} });
assert.deepEqual(parseHordeArgs("plan --no-verifier 2 a; b"), {
  kind: "run", count: 2, prompt: "a; b", plan: ["a", "b"], noVerifier: true,
});
assert.deepEqual(parseHordeArgs("3 find --no-verifier bugs"), {
  kind: "run", count: 3, prompt: "find --no-verifier bugs",
});
assert.match(parseHordeArgs("--no-verifier").error, /count is required/);
assert.equal(parseHordeArgs("--no-verifier status").kind, "usage");
console.log("PASS: horde-args-test no-verifier flag");

// --until-stop launch flag, in any position, combinable with the other flags.
const untilStop = { kind: "run", count: 3, prompt: "x", untilStop: true };
assert.deepEqual(parseHordeArgs("--until-stop 3 x"), untilStop);
assert.deepEqual(parseHordeArgs("3 --until-stop x"), untilStop);
assert.deepEqual(parseHordeArgs("--no-verifier --until-stop 3 x"), { ...untilStop, noVerifier: true });
assert.equal(parseHordeArgs("--until-stop status").kind, "usage");
console.log("PASS: horde-args-test until-stop flag");
