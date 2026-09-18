import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

const SETTINGS_NS = "web-search-follow-model";
const SETTINGS_API_PATH = "/api/desktop.web-search";
const FOLLOW_MODEL_PROVIDER_ID = "follow-model";
const OFFICIAL_PROVIDER_ID = "deepseek-official";
const MODES = ["follow-model", "web-search", "disabled"];

export const Config = z.object({
  mode: z.union(MODES).default("follow-model"),
});

function normalizedSelection(value = {}) {
  return { mode: MODES.includes(value.mode) ? value.mode : "follow-model" };
}

function validateSelection(value) {
  const mode = value?.mode;
  if (mode !== undefined && !MODES.includes(mode)) {
    throw new Error(`Web search mode must be one of ${MODES.join(", ")}.`);
  }
}

function sameSelection(left, right) {
  return left.mode === right.mode;
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
    // Settings 0.1.6 requires a plain object for replace(); an unset user section
    // reads as undefined and would make the rollback throw instead of restoring.
    this.activeUser = this.section(ctx).user ?? {};
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
    ctx.inject(["connection"], current => {
      // The shared /api carrier owns authentication, authority checks and body limits.
      current.effect(() => current.connection.fetch.register({
        path: SETTINGS_API_PATH,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: async request => {
          if (request.method === "POST") {
            let payload;
            try { payload = await request.json(); }
            catch { return Response.json({ error: "invalid-request" }, { status: 400 }); }
            if (!Number.isSafeInteger(payload?.revision) || payload.revision < 0) {
              return Response.json({ error: "invalid-request" }, { status: 400 });
            }
            if (!ctx.settings.writable || payload.revision !== this.section(ctx).revision) {
              return Response.json({ error: "conflict" }, { status: 409 });
            }
            if (this.phase === "failed") this.enqueue(ctx, scope.get());
          }
          await this.applyQueue;
          return Response.json(this.activationStatus(ctx), { headers: { "cache-control": "no-store" } });
        },
      }), "web-search-selection: settings API");
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
        await this.applySelection(ctx, target);
        this.active = target;
        this.activeUser = user ?? {};
        this.failure = undefined;
        this.phase = sameSelection(target, normalizedSelection(this.section(ctx).value)) ? "active" : "saved";
      } catch {
        this.pending = previous;
        let restored = false;
        try {
          await this.applySelection(ctx, previous);
          restored = true;
        } catch { /* Admission remains closed on failed restoration. */ }
        this.failure = restored ? "apply-failed" : "restore-failed";
        // CAS prevents an older failed application from overwriting a newer save.
        this.rollbackSelection = previous;
        try { await ctx.settings.replace(SETTINGS_NS, previousUser ?? {}, revision); }
        catch (error) {
          // A conflict means a newer save already won and must not be overwritten;
          // anything else is a genuine rollback fault and must not hide behind that name.
          this.failure = error?.code === "SETTINGS_CONFLICT" ? "rollback-conflict" : "rollback-failed";
        }
        finally { this.rollbackSelection = undefined; }
        this.phase = "failed";
        ctx.logger.error("web-search-selection: routing activation failed (%s)", this.failure);
      } finally { this.pending = undefined; }
    }).catch(() => { this.phase = "failed"; this.failure = "apply-failed"; });
    return this.applyQueue;
  }

  get searchProvider() {
    return this.providerFor(this.pending ?? this.active);
  }

  get searchEnabled() {
    return this.phase === "active" && this.active.mode !== "disabled";
  }

  providerFor(selection) {
    return selection.mode === "web-search" ? OFFICIAL_PROVIDER_ID : FOLLOW_MODEL_PROVIDER_ID;
  }

  /**
   * Point the seam at the provider this selection names, and refuse the selection when the
   * seam cannot actually serve it. A profile that leaves the upstream plugin out has no
   * deepseek-official provider, so "web-search" fails here rather than being forced back
   * into a profile that deliberately dropped it.
   */
  async applySelection(ctx, selection) {
    const provider = this.providerFor(selection);
    await this.reloadWebProvider(ctx, provider);
    // "disabled" closes admission on its own; asserting there would let a broken extension
    // entry block the one selection that needs no provider at all.
    if (selection.mode !== "disabled") this.assertProviderUsable(ctx, provider);
  }

  /**
   * Fail activation when the seam cannot serve the selected provider. Without this the loader
   * update succeeds, the settings card reports "active", and every later search throws
   * WEB_PROVIDER_CONFIGURED_MISSING instead. Credential validity stays a runtime concern: the
   * upstream provider resolves its key through its own settings section and a launch-environment
   * fallback, and reproducing that here would report a missing key that actually resolves.
   */
  assertProviderUsable(ctx, provider) {
    const providers = ctx.get("web")?.searchProviders;
    if (!(providers instanceof Map)) {
      throw new Error("Harness extension API is incompatible: web.searchProviders");
    }
    const registered = providers.get(provider);
    if (registered === undefined) {
      throw new Error(`No web search provider named "${provider}" is registered.`);
    }
    if (typeof registered.available !== "function" || !registered.available()) {
      throw new Error(`Web search provider "${provider}" is registered but unavailable.`);
    }
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
  MODES,
  OFFICIAL_PROVIDER_ID,
  FOLLOW_MODEL_PROVIDER_ID,
  SETTINGS_NS,
  SETTINGS_API_PATH,
  normalizedSelection,
  validateSelection,
};
