import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

const SETTINGS_NS = "web-search-follow-model";
const FOLLOW_MODEL_PROVIDER_ID = "follow-model";
const DEFAULT_INDEPENDENT_PROVIDER_ID = "deepseek-official";
const MAX_PROVIDER_ID_LENGTH = 128;

export const Config = z.object({
  mode: z.union(["follow-model", "disabled", "independent"]).default("follow-model"),
  independentProvider: z.string().default(DEFAULT_INDEPENDENT_PROVIDER_ID),
});

function normalizedSelection(value = {}) {
  return {
    mode: value.mode ?? "follow-model",
    independentProvider: typeof value.independentProvider === "string"
      ? value.independentProvider.trim()
      : DEFAULT_INDEPENDENT_PROVIDER_ID,
  };
}

function validateSelection(value) {
  const selection = normalizedSelection(value);
  if (selection.mode !== "independent") return;
  const provider = selection.independentProvider;
  if (provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(provider)) {
    throw new Error("Independent web search requires a valid Harness search Provider ID.");
  }
  if (provider === FOLLOW_MODEL_PROVIDER_ID) {
    throw new Error("Use follow-model mode instead of selecting the follow-model Provider as an independent service.");
  }
}

function sameSelection(left, right) {
  return left.mode === right.mode && left.independentProvider === right.independentProvider;
}

export default class WebSearchSelection extends Service {
  static Config = Config;
  static inject = ["settings", "loader"];

  constructor(ctx, config = {}) {
    super(ctx, "webSearchSelection");
    const scope = ctx.settings.register(SETTINGS_NS, Config, {
      base: config,
      applies: "live",
      validate: validateSelection,
    });
    this.active = normalizedSelection(scope.get());
    this.pending = undefined;
    this.applyQueue = Promise.resolve();
    scope.watch(async (next) => {
      const target = normalizedSelection(next);
      const task = this.applyQueue.then(async () => {
        if (sameSelection(target, this.active)) return;
        const previous = this.active;
        try {
          await this.applySelection(ctx, previous, target);
        } catch (error) {
          try {
            await this.reloadAffectedEntries(ctx, target, previous);
          } catch (rollbackError) {
            ctx.logger.error("web-search-selection: failed to restore the previous live routing");
            ctx.logger.error(rollbackError);
          }
          // Keep the persisted UI value aligned with the route that actually remains active.
          await scope.replace(previous);
          ctx.logger.error("web-search-selection: rejected a live routing update and restored the previous selection");
          ctx.logger.error(error);
        }
      });
      this.applyQueue = task.catch((error) => {
        ctx.logger.error("web-search-selection: live routing update failed");
        ctx.logger.error(error);
      });
      await task;
    });
  }

  get searchProvider() {
    const selection = this.pending ?? this.active;
    return selection.mode === "independent"
      ? selection.independentProvider
      : FOLLOW_MODEL_PROVIDER_ID;
  }

  get searchEnabled() {
    return (this.pending ?? this.active).mode !== "disabled";
  }

  async applySelection(ctx, previous, target) {
    this.pending = target;
    try {
      await this.reloadAffectedEntries(ctx, previous, target);
      this.active = target;
    } finally {
      this.pending = undefined;
    }
  }

  async reloadAffectedEntries(ctx, previous, target) {
    if (this.providerFor(previous) !== this.providerFor(target)) {
      await this.reloadWebProvider(ctx, this.providerFor(target));
    }
  }

  providerFor(selection) {
    return selection.mode === "independent"
      ? selection.independentProvider
      : FOLLOW_MODEL_PROVIDER_ID;
  }

  async reloadWebProvider(ctx, provider) {
    const id = "web";
    const entries = [...ctx.loader.entries()].filter((entry) => entry.options.id === id && entry.fiber?.uid && !entry.disabled);
    if (entries.length !== 1) {
      throw new Error(`Harness extension API is incompatible: expected one active loader entry named ${id}, found ${entries.length}.`);
    }
    const entry = entries[0];
    if (typeof entry.options.config !== "object" || entry.options.config === null || Array.isArray(entry.options.config)) {
      throw new Error(`Harness extension API is incompatible: loader entry ${id} has no object configuration.`);
    }
    await entry.update({
      config: { ...entry.options.config, searchProvider: provider },
    });
    await ctx.loader.await();
  }
}

export {
  DEFAULT_INDEPENDENT_PROVIDER_ID,
  FOLLOW_MODEL_PROVIDER_ID,
  SETTINGS_NS,
  normalizedSelection,
  validateSelection,
};
