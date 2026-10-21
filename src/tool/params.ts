import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { FINDING_CONFIDENCES, FINDING_IMPORTANCE, FINDING_SUPPORT } from "../ledger/findings.js";

export const HordeParams = Type.Object({
  action: StringEnum(
    [
      "list",
      "post",
      "idea",
      "claim",
      "done",
      "drop",
      "rule-out",
      "finding",
      "findings",
      "fact",
      "facts",
      "assert",
      "confirm",
      "contest",
      "retract",
      "supersede",
      "claims",
      "resource",
      "resources",
      "solved",
      "confirm-solved",
      "contest-solved",
      "concerns",
      "verify", "amend", "inbox", "message", "ack", "respond", "resolve", "defer",
      "attach", "review", "reattest", "artifact", "resource-state", "collaboration", "inspect",
    ] as const,
    {
      description:
        "list/findings/facts/claims/resources/concerns: read shared state; post: BOARD.md; " +
        "idea/claim/done/drop/rule-out: checklist (rule-out is a terminal negative); " +
        "finding: FINDINGS.md with a claimed idea, a concern slug, and optional importance/" +
        "confidence/support; amend: rewrite the body prose of your own F#id at its current revision; " +
        "verify: record your independent reproduction of finding F#id with the support level you reached; " +
        "fact: FACTS.md; assert/confirm/contest/retract/supersede: change claim C#id state; " +
        "resource: claim a shared dataset, harness, corpus, or sandbox (with cleanup) before building it; " +
        "solved: propose the goal answered; confirm-solved/contest-solved: validate or refute it; " +
        "reattest: carry your earlier review of F#/A# forward to its current revision with evidence that the checked behaviour is unchanged",
    },
  ),
  detail: Type.Optional(StringEnum(["summary", "full"] as const, { description: "Collaboration reads default to summaries; full returns complete page bodies, inspected subjects or write receipts. inspect E#/V#/Q# always returns the full record." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Collaboration page offset, applied to each collection; see next cursors." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Collaboration records per collection (default 25)." })),
  evidenceText: Type.Optional(Type.String({ description: "For review: atomically attach this full evidence text and review it in one call. Optional artifactPath retains a file. Existing refs may also be supplied." })),
  target: Type.Optional(Type.String({ description: "Target F#, I#, R#, A#, answer, or Q# for messages. inspect also reads complete E# events/evidence and V# reviews. collaboration can filter by target." })),
  responseTarget: Type.Optional(Type.String({ description: "Explicit corrected response target: a finding attached to the challenged I#, or the successor of a superseded F#. Use with respond/resolve." })),
  revision: Type.Optional(Type.String({ description: "Exact target revision/hash reviewed or challenged; required for review." })),
  to: Type.Optional(Type.String({ description: "Recipient member-N; defaults to target owner." })),
  kind: Type.Optional(StringEnum(["question", "blocker", "review-request", "challenge", "handoff", "decision"] as const)),
  blocking: Type.Optional(Type.Boolean({ description: "Unresolved feedback blocks acceptance (default for challenges/blockers)." })),
  refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence E# IDs backing this message/review/resolution." })),
  relation: Type.Optional(StringEnum(["supports", "contradicts", "extends"] as const)),
  verdict: Type.Optional(StringEnum(["supports", "partially-supports", "refutes", "inconclusive"] as const)),
  checked: Type.Optional(Type.String({ description: "Exact assertions checked and method; required for review." })),
  unchecked: Type.Optional(Type.String({ description: "Assertions inside the target's stated claim or criteria that you did not check; empty only for full coverage of that scope. Disclosures outside the criteria go in limits." })),
  limits: Type.Optional(Type.String({ description: "For review: limits outside the target's declared claim or criteria (one engine, no hardened deployment). Recorded on the acceptance as limits, never as blockers." })),
  artifactKind: Type.Optional(StringEnum(["runnable", "document"] as const, { description: "Artifact classification, immutable after publication. Default runnable requires tested/reproduced review. document permits full-scope sourced/derived review of its stated criteria, not runtime acceptance." })),
  artifactPath: Type.Optional(Type.String({ description: "File path relative to this run, under artifacts/, retained by content hash." })),
  criteria: Type.Optional(Type.String({ description: "Artifact acceptance criteria, including positive/negative tests." })),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Targets this artifact depends on; their current revisions are pinned." })),
  resourceState: Type.Optional(StringEnum(["building", "ready", "broken", "retired"] as const)),
  ports: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }))),
  leaseSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
  generation: Type.Optional(Type.Integer({ minimum: 0, description: "Expected resource generation. Required after the first resource-state update." })),
  requestId: Type.Optional(Type.String({ description: "Stable retry key for collaboration mutations within this session attempt." })),
  text: Type.Optional(
    Type.String({
      description:
        "Message, idea text, finding text, resource name, or note for done/drop/rule-out. Required for " +
        "message, ack, respond, resolve, defer, attach (the observation) and review (the decision summary)",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description:
        "For a resource: a short pointer (path, command, or fact id) others should reuse. For done/drop/rule-out: " +
        "the result line, when text is not given",
    }),
  ),
  cleanup: Type.Optional(
    Type.String({
      description:
        "For a resource: shell command the parent runs at finalize to tear it down, e.g. 'docker rm -f mylab'",
    }),
  ),
  id: Type.Optional(
    Type.Integer({
      description:
        "Idea id (the number after #) for claim/done/drop/rule-out, C# for claims, or F# for " +
        "verify",
    }),
  ),
  idea: Type.Optional(
    Type.Integer({ description: "For a finding: the idea #id it addresses, if any" }),
  ),
  importance: Type.Optional(
    StringEnum(FINDING_IMPORTANCE, {
      description:
        "For a finding: how much it matters for the task - critical/high/medium/low/info (optional)",
    }),
  ),
  confidence: Type.Optional(
    StringEnum(FINDING_CONFIDENCES, { description: "For a finding: high/medium/low (optional)" }),
  ),
  support: Type.Optional(
    StringEnum(FINDING_SUPPORT, {
      description:
        "For a finding: how strongly it is supported - reproduced / tested / derived / sourced / " +
        "speculative (required for finding and verify)",
    }),
  ),
  concern: Type.Optional(
    Type.String({
      description:
        "For a finding: required root-cause plus entry-point slug, e.g. oauth-login-state or query-socketio-authz",
    }),
  ),
  concernDef: Type.Optional(
    Type.String({
      description:
        "For a finding with a concern new to CONCERNS.md: one line naming its root cause and " +
        "entry point",
    }),
  ),
  concernNew: Type.Optional(
    Type.Boolean({
      description:
        "For a finding: register the concern even though it resembles an existing slug " +
        "(needs concernDef)",
    }),
  ),
  deltaOf: Type.Optional(
    Type.Integer({
      description: "For a finding or fact: F#/T# this is new evidence for (bypasses duplicate detection)",
    }),
  ),
  supersedes: Type.Optional(
    Type.Integer({ description: "For a finding: F# this finding corrects or overturns" }),
  ),
});

export type HordeToolParams = {
  action:
    | "list"
    | "post"
    | "idea"
    | "claim"
    | "done"
    | "drop"
    | "rule-out"
    | "finding"
    | "findings"
    | "fact"
    | "facts"
    | "assert"
    | "confirm"
    | "contest"
    | "retract"
    | "supersede"
    | "claims"
    | "resource"
    | "resources"
    | "solved"
    | "confirm-solved"
    | "contest-solved"
    | "concerns"
    | "verify" | "amend" | "inbox" | "message" | "ack" | "respond" | "resolve" | "defer"
    | "attach" | "review" | "reattest" | "artifact" | "resource-state" | "collaboration" | "inspect";
  detail?: "summary" | "full";
  offset?: number;
  limit?: number;
  evidenceText?: string;
  target?: string;
  revision?: string;
  responseTarget?: string;
  to?: string;
  kind?: "question" | "blocker" | "review-request" | "challenge" | "handoff" | "decision";
  blocking?: boolean;
  refs?: string[];
  relation?: "supports" | "contradicts" | "extends";
  verdict?: "supports" | "partially-supports" | "refutes" | "inconclusive";
  checked?: string;
  unchecked?: string;
  limits?: string;
  artifactPath?: string;
  artifactKind?: "runnable" | "document";
  criteria?: string;
  dependsOn?: string[];
  resourceState?: "building" | "ready" | "broken" | "retired";
  ports?: number[];
  leaseSeconds?: number;
  generation?: number;
  requestId?: string;
  text?: string;
  note?: string;
  cleanup?: string;
  id?: number;
  idea?: number;
  importance?: string;
  confidence?: string;
  support?: string;
  concern?: string;
  concernDef?: string;
  concernNew?: boolean;
  deltaOf?: number;
  supersedes?: number;
};
