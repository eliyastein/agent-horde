import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanStopRequestedFor, writeHeartbeat } from "../ledger/run-signals.js";
import { envNumber } from "../format.js";
import { ReminderGate, goalReminder } from "../reminder.js";
import { runHordeAction } from "./actions.js";
import { pendingVerificationHint, solvedHint } from "./hints.js";
import { HordeParams } from "./params.js";
import { compactReceipt } from "./collaboration-view.js";
import { registerInbox } from "./inbox.js";

/** Goal reminder cadence in horde-tool calls and in milliseconds; 0 disables a trigger. */
const REMIND_CALLS = envNumber("PI_HORDE_REMIND_CALLS", 8);

const REMIND_MS = envNumber("PI_HORDE_REMIND_MS", 600_000);

/** Tool actions that write a ledger, and therefore count as liveness. */
const MUTATING_ACTIONS = new Set([
  "post", "idea", "claim", "done", "drop", "rule-out", "finding", "fact", "assert", "confirm",
  "contest", "retract", "supersede", "resource", "solved", "confirm-solved", "contest-solved",
  "verify", "message", "ack", "respond", "resolve", "defer", "attach", "review", "artifact", "resource-state",
]);

export function registerMemberTool(pi: ExtensionAPI): void {
  const hordeDir = process.env.PI_HORDE_DIR;
  const member = process.env.PI_HORDE_NAME;
  if (!hordeDir || !member) {
    throw new Error("agent-horde: PI_HORDE_DIR and PI_HORDE_NAME must be set for a horde member");
  }
  const attempt = process.env.PI_HORDE_ATTEMPT ?? `pid-${process.pid}`;
  const activeRun = process.env.PI_HORDE_RUN;
  if (activeRun) registerInbox(pi, { hordeDir, runId: activeRun, actor: member, attempt });
  // One member per process, so one gate is the per-member reminder counter.
  const reminders = new ReminderGate(REMIND_CALLS, REMIND_MS);
  pi.registerTool({
    name: "horde",
    label: "Horde",
    description:
      "Coordinate with the other horde members through the shared .horde/ files. " +
      "list: print the live IDEAS.md checklist. post: append a message to BOARD.md. " +
      "idea: add a checklist item to IDEAS.md (if it duplicates an existing idea, the " +
      "existing id is returned instead). " +
      "claim / done / drop: change the status of idea #id (done and drop accept an optional " +
      "note in text). finding: append a scoped finding to FINDINGS.md (claimed idea and concern " +
      "are required; importance, confidence, and support are optional; the first line is the title). " +
      "resource: claim a shared resource (lab, harness, dataset, or corpus) by name so other members " +
      "reuse it instead of rebuilding; resources: list what is already claimed. " +
      "solved: propose the complete answer for independent validation and coverage checking. " +
      "concerns: print the concern glossary; verify: record an independent reproduction of F#. " +
      "Collaboration: inspect target F#/A#/I#/R# for its revision; attach evidence to anyone's work; " +
      "message sends targeted questions/challenges/review-request; inbox shows obligations; ack/respond by recipient, " +
      "resolve/defer by requester. artifact publishes a retained file revision; review checks exact assertions " +
      "on that revision with evidence refs. resource-state reserves ports and publishes readiness with a lease. " +
      "collaboration returns a paged summary; target filters it, offset/limit page it, detail=full returns full bodies. " +
      "inspect also retrieves complete E#/V#/Q# records. review with evidenceText optionally attaches evidence in the same atomic call. " +
      "Write receipts omit echoed prose; inspect the returned E# to retrieve it. Reads of legacy boards go through read.",
    promptSnippet:
      "horde: post to the board, add/claim/finish ideas, claim shared resources, report " +
      "solved, record and verify findings in .horde/",
    parameters: HordeParams,
    async execute(toolCallId, params) {
      const runId = process.env.PI_HORDE_RUN;
      const result = await runHordeAction(hordeDir, member, params, runId, { attempt, requestId: toolCallId });
      const runDir = runId ? path.join(hordeDir, "runs", runId) : undefined;
      if (runDir && MUTATING_ACTIONS.has(params.action)) touchHeartbeat(runDir, member);
      let text = compactReceipt(result.text, params) + solvedHint(hordeDir, runId, member, params.action);
      // A verifier's coverage claim is only a snapshot. Append the live pending queue
      // after every verify so a finding filed later cannot read as already checked.
      if (runId && params.action === "verify" && /verifier/i.test(process.env.PI_HORDE_ROLE ?? "")) {
        text += pendingVerificationHint(hordeDir, runId, member);
      }
      const winding = Boolean(runId && cleanStopRequestedFor(hordeDir, runId, member));
      if (runId && !winding && reminders.tick()) {
        text += goalReminder(hordeDir, runId, member, process.env.PI_HORDE_ROLE);
      }
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, id: result.id },
      };
    },
  });
}

/** Liveness is best effort: a failed heartbeat write must not fail the member's action. */
function touchHeartbeat(runDir: string, member: string): void {
  try {
    writeHeartbeat(runDir, member);
  } catch {
    // The run directory may already be gone during finalize.
  }
}
