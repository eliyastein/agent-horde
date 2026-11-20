import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi's compaction budgets for one model, as `SettingsManager.getCompactionSettings` resolves them. */
export interface CompactionBudget {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** The model fields the cap reads; every other field is carried over unchanged. */
interface CappableModel {
  provider: string;
  id: string;
  contextWindow: number;
}

/** The capped model to switch to, or why the cap was not applied. */
export type CapDecision<M> = { model: M } | { skip: string };

/**
 * Clone `model` with a context window of `cap + reserveTokens`, so pi's threshold compaction
 * (`tokens > contextWindow - reserveTokens`) fires once the context passes `cap`.
 *
 * Args:
 *   model: The session's current model; the clone keeps every field but `contextWindow`.
 *   cap: Context size in tokens at which compaction should fire.
 *   budget: pi's compaction settings resolved for `model`.
 *
 * Returns:
 *   The clone, or a skip reason when compaction is disabled, the cap is below the floor
 *   (`reserveTokens + keepRecentTokens`, under which every turn would compact again), or the
 *   window is already no larger than the capped one.
 */
export function cappedModel<M extends CappableModel>(
  model: M,
  cap: number,
  budget: CompactionBudget,
): CapDecision<M> {
  const { enabled, reserveTokens, keepRecentTokens } = budget;
  if (!enabled) return { skip: "compaction is disabled in pi's settings" };
  const floor = reserveTokens + keepRecentTokens;
  if (cap < floor) {
    return {
      skip: `context cap ${cap} is below ${floor} tokens (compaction reserveTokens ` +
        `${reserveTokens} + keepRecentTokens ${keepRecentTokens}); raise it`,
    };
  }
  const contextWindow = cap + reserveTokens;
  if (model.contextWindow <= contextWindow) {
    return {
      skip: `${model.provider}/${model.id} has a ${model.contextWindow}-token window, ` +
        `so pi already compacts at or below the cap`,
    };
  }
  return { model: { ...model, contextWindow } };
}

function warn(message: string): void {
  process.stderr.write(`agent-horde: --context-cap not applied: ${message}\n`);
}

/**
 * `--context-cap` on the member side: at the first session start, switch to a copy of the model
 * that advertises a smaller context window, so pi's own threshold compaction runs mid-run at the
 * cap. The switch resets the thinking level to the settings default, so the level from the
 * command line is restored right after. The decision is made once; the handler then unhooks.
 */
export function registerContextCap(pi: ExtensionAPI, cap: number): void {
  const off = pi.on("session_start", async (_event, ctx) => {
    off();
    if (!ctx.model) {
      warn("the session has no model");
      return;
    }
    const budget = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
    const decision = cappedModel(ctx.model, cap, budget);
    if ("skip" in decision) {
      warn(decision.skip);
      return;
    }
    const thinking = pi.getThinkingLevel();
    if (!(await pi.setModel(decision.model))) {
      warn(`no API key for ${ctx.model.provider}/${ctx.model.id}`);
      return;
    }
    pi.setThinkingLevel(thinking);
  });
}
