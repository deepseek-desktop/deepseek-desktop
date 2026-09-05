import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

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
    this.activeUser = this.section(ctx).user;
    this.pending = undefined;
    this.phase = "saved";
    this.failure = undefined;
    this.inFlight = 0;
    this.drained = [];
    this.applyQueue = Promise.resolve();
    ctx.on("settings/updated", (ns, next) => {
      if (ns !== SETTINGS_NS || (this.rollbackSelection && sameSelection(normalizedSelection(next), this.rollbackSelection))) return;
      this.enqueue(ctx, next);
    });
    ctx.inject(["web"], () => {
      if (!this.pending) this.enqueue(ctx, scope.get());
    });
    ctx.inject(["tools"], current => {
      if (typeof current.tools.guard !== "function") throw new Error("Harness requires the public tool guard API for search selection.");
      current.tools.guard(exec => exec.name === "web_search" ? this.admissionFailure() : undefined);
      current.on("tools/execute", (exec, next) => exec.name === "web_search" ? this.runSearch(next) : next());
    });
    ctx.inject(["connection", "webServer"], current => {
      current.connection.rpc.handle("/desktop-web-search", async (endpoint, payload) => {
        if (!["status", "apply"].includes(endpoint)) return { ok: false, error: { code: "not-found", message: "Unknown search settings operation.", details: {} } };
        if (endpoint === "apply") {
          if (!ctx.settings.writable || payload?.revision !== this.section(ctx).revision) {
            return { ok: false, error: { code: "conflict", message: "Search settings changed or are read-only.", details: {} } };
          }
          if (this.phase === "failed") this.enqueue(ctx, scope.get());
        }
        await this.applyQueue;
        return { ok: true, value: this.activationStatus(ctx) };
      });
    });
  }

  section(ctx) {
    return ctx.settings.describe().find(section => section.ns === SETTINGS_NS);
  }

  activationStatus(ctx = this.ctx) {
    return { phase: this.phase, revision: this.section(ctx).revision, selection: this.active, failure: this.failure ?? null };
  }

  admissionFailure() {
    if (this.phase === "active" && this.active.mode !== "disabled") return undefined;
    const lang = process.env.DEEPSEEK_DESKTOP_LOCALE?.toLowerCase() ?? "en";
    if (lang.startsWith("zh-tw") || lang.startsWith("zh-hk")) return "聯網搜尋已停用或設定尚未生效，一般對話和網頁擷取仍可使用。";
    if (lang.startsWith("zh")) return "联网搜索已禁用或设置尚未生效，正常对话和网页抓取仍可使用。";
    return "Web search is disabled or its settings are not active. Chat and web fetch remain available.";
  }

  async runSearch(next) {
    const failure = this.admissionFailure();
    if (failure) throw new WebError(failure, "WEB_SEARCH_SELECTION_INACTIVE");
    this.inFlight++;
    try { return await next(); }
    finally {
      if (--this.inFlight === 0) this.drained.splice(0).forEach(resolve => resolve());
    }
  }

  enqueue(ctx, value) {
    const target = normalizedSelection(value);
    const { revision, user } = this.section(ctx);
    this.phase = "saved";
    this.applyQueue = this.applyQueue.then(async () => {
      if (!sameSelection(target, normalizedSelection(this.section(ctx).value))) return;
      this.phase = "applying";
      if (this.inFlight) await new Promise(resolve => this.drained.push(resolve));
      const previous = this.active;
      const previousUser = this.activeUser;
      this.pending = target;
      try {
        await this.reloadWebProvider(ctx, this.providerFor(target));
        this.active = target;
        this.activeUser = user;
        this.failure = undefined;
        this.phase = sameSelection(target, normalizedSelection(this.section(ctx).value)) ? "active" : "saved";
      } catch {
        this.pending = previous;
        let restored = false;
        try { await this.reloadWebProvider(ctx, this.providerFor(previous)); restored = true; } catch { /* Admission remains closed on failed restoration. */ }
        this.failure = restored ? "apply-failed" : "restore-failed";
        // CAS prevents an older failed application from overwriting a newer save.
        this.rollbackSelection = previous;
        try { await ctx.settings.replace(SETTINGS_NS, previousUser, revision); }
        catch { this.failure = "rollback-conflict"; }
        finally { this.rollbackSelection = undefined; }
        this.phase = "failed";
        ctx.logger.error("web-search-selection: routing activation failed (%s)", this.failure);
      } finally { this.pending = undefined; }
    }).catch(() => { this.phase = "failed"; this.failure = "apply-failed"; });
    return this.applyQueue;
  }

  get searchProvider() {
    const selection = this.pending ?? this.active;
    return selection.mode === "independent"
      ? selection.independentProvider
      : FOLLOW_MODEL_PROVIDER_ID;
  }

  get searchEnabled() {
    return this.phase === "active" && this.active.mode !== "disabled";
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
    // Expressions reflect pending state, not the value captured by the live service.
    if (entry.options.config.searchProvider === provider && ctx.get("web")) return;
    await entry.update({
      config: { ...entry.options.config, searchProvider: provider },
    });
    await ctx.loader.await();
    if (!ctx.get("web")) throw new Error("Harness web service did not become active.");
  }
}

export {
  DEFAULT_INDEPENDENT_PROVIDER_ID,
  FOLLOW_MODEL_PROVIDER_ID,
  SETTINGS_NS,
  normalizedSelection,
  validateSelection,
};
