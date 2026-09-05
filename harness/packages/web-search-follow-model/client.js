window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-web-search-follow-model",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const namespace = "web-search-follow-model";
    const localeNamespace = "desktop.webSearch";
    const modes = ["follow-model", "disabled", "independent"];
    const dictionaries = {
      en: {
        title: "Web search (follow model)", description: "Search follows the model used by each conversation.",
        mode: "Search routing", "follow-model": "Follow current model", disabled: "Disable web search",
        independent: "Independent search service", provider: "Independent search Provider",
        providerHint: "Enter a Harness search Provider ID, for example deepseek-official.",
        reset: "Restore defaults", save: "Save", discard: "Discard changes", pending: "Unsaved",
        failed: "Changes could not be completed. Review the settings and try again.",
        active: "Active", saved: "Saved; applying", applying: "Applying", activationFailed: "Search settings are not active. Retry or choose another service.",
        invalid: "Enter a valid independent search Provider ID.",
        readOnly: "These settings are read-only."
      },
      zh: {
        title: "联网搜索（跟随模型）", description: "联网搜索跟随每个会话使用的模型。",
        mode: "联网搜索", "follow-model": "跟随当前模型", disabled: "禁用联网搜索",
        independent: "独立搜索服务", provider: "独立搜索提供方",
        providerHint: "填写 Harness 搜索 Provider ID，例如 deepseek-official。",
        reset: "恢复默认", save: "保存", discard: "放弃修改", pending: "未保存",
        failed: "修改未能完成，请检查设置后重试。",
        active: "已生效", saved: "已保存，等待生效", applying: "应用中", activationFailed: "搜索设置尚未生效，请重试或选择其他服务。",
        invalid: "请填写有效的独立搜索 Provider ID。",
        readOnly: "这些设置为只读。"
      },
      "zh-TW": {
        title: "聯網搜尋（跟隨模型）", description: "聯網搜尋跟隨每個工作階段使用的模型。",
        mode: "聯網搜尋", "follow-model": "跟隨目前模型", disabled: "停用聯網搜尋",
        independent: "獨立搜尋服務", provider: "獨立搜尋提供方",
        providerHint: "填寫 Harness 搜尋 Provider ID，例如 deepseek-official。",
        reset: "恢復預設", save: "儲存", discard: "放棄修改", pending: "未儲存",
        failed: "修改未能完成，請檢查設定後重試。",
        active: "已生效", saved: "已儲存，等待生效", applying: "套用中", activationFailed: "搜尋設定尚未生效，請重試或選擇其他服務。",
        invalid: "請填寫有效的獨立搜尋 Provider ID。",
        readOnly: "這些設定為唯讀。"
      }
    };
    const css = `
      .desktop-search-card{min-width:0;list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
      .desktop-search-card summary{cursor:pointer;padding:14px 16px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
      .desktop-search-card summary small{display:block;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400}
      .desktop-search-body{margin:0 16px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2);display:grid;gap:12px;min-width:0}
      .desktop-search-body label{display:grid;gap:6px;font-size:13px;min-width:0}
      .desktop-search-body select,.desktop-search-body input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 10px;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l4);border-radius:8px}
      .desktop-search-body footer{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
      .desktop-search-body button{font:inherit;font-size:13px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;cursor:pointer}
      .desktop-search-body button[type=submit]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
      .desktop-search-body :disabled{opacity:.45;cursor:default}
      .desktop-search-body p{margin:0;font-size:12px;overflow-wrap:anywhere}
      .desktop-search-body [role=alert]{color:var(--dsw-alias-label-error)}
      .desktop-search-body :focus-visible,.desktop-search-card summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    `;

    // Own the settings contribution so repository upgrades cannot drop a core UI patch.
    class SearchSettingsController {
      constructor(scope, activation) {
        this.scope = scope;
        this.activation = activation;
        this.activationPhase = "saved";
        this.drafts = new Map();
        this.listeners = new Set();
        this.saving = false;
        this.failed = false;
        this.publish();
        this.unsubscribe = scope.subscribe(() => { this.publish(); void this.refreshActivation(); });
        void this.refreshActivation();
      }
      getSnapshot = () => this.snapshot;
      subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
      dispose = () => { this.unsubscribe(); this.listeners.clear(); };
      async refreshActivation(apply = false) {
        const request = this.activationRequest = (this.activationRequest ?? 0) + 1;
        try {
          const status = await this.activation(apply, this.scope.getSnapshot().revision);
          if (request !== this.activationRequest) return status;
          this.activationPhase = status.phase;
          this.publish();
          return status;
        } catch {
          if (request === this.activationRequest) { this.activationPhase = "failed"; this.publish(); }
        }
      }
      publish() {
        const current = this.scope.getSnapshot();
        const value = { mode: "follow-model", independentProvider: "deepseek-official", ...current.value };
        const base = { mode: "follow-model", independentProvider: "deepseek-official", ...current.base };
        for (const [field, draft] of this.drafts) value[field] = draft === null ? base[field] : draft;
        this.snapshot = {
          ...value, available: current.status === "ready", writable: current.writable,
          overridden: Object.keys(current.user ?? {}).some(key => key === "mode" || key === "independentProvider"),
          dirty: this.operations().length > 0, saving: this.saving, failed: this.failed,
          activationPhase: this.activationPhase,
          invalid: !modes.includes(value.mode) || (value.mode === "independent" && (
            typeof value.independentProvider !== "string" || value.independentProvider.length === 0
            || value.independentProvider.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(value.independentProvider)
            || value.independentProvider === "follow-model"
          ))
        };
        for (const listener of this.listeners) listener();
      }
      operations() {
        const current = this.scope.getSnapshot();
        return [...this.drafts].flatMap(([field, value]) => {
          if (value === null) return Object.hasOwn(current.user ?? {}, field) ? [{ op: "unset", path: [field] }] : [];
          return value === current.value?.[field] ? [] : [{ op: "set", path: [field], value }];
        });
      }
      edit = (field, value) => {
        if (this.saving || !this.snapshot.writable || !["mode", "independentProvider"].includes(field)) return;
        if (this.drafts.size === 0) this.revision = this.scope.getSnapshot().revision;
        this.drafts.set(field, value);
        this.failed = false;
        this.publish();
      };
      reset = () => {
        if (this.saving || !this.snapshot.writable) return;
        this.revision = this.scope.getSnapshot().revision;
        this.drafts = new Map([["mode", null], ["independentProvider", null]]);
        this.failed = false;
        this.publish();
      };
      discard = () => {
        if (this.saving) return;
        this.drafts.clear();
        this.failed = false;
        this.publish();
      };
      save = async () => {
        if (!this.snapshot.available || !this.snapshot.writable || this.saving || this.snapshot.invalid || (!this.snapshot.dirty && this.activationPhase !== "failed")) return;
        const ops = this.operations();
        const desired = { mode: this.snapshot.mode, independentProvider: this.snapshot.independentProvider };
        this.saving = true;
        this.failed = false;
        this.publish();
        try {
          await this.scope.mutate(ops, this.revision);
          this.activationPhase = "applying";
          this.publish();
          const activation = await this.refreshActivation(true);
          const user = this.scope.getSnapshot().user ?? {};
          this.failed = activation?.phase !== "active" || activation.selection?.mode !== desired.mode
            || activation.selection?.independentProvider !== desired.independentProvider
            || !ops.every(op => op.op === "unset" ? !Object.hasOwn(user, op.path[0]) : user[op.path[0]] === op.value);
          if (!this.failed) this.drafts.clear();
          else this.revision = this.scope.getSnapshot().revision;
        } catch {
          this.failed = true;
        } finally {
          this.saving = false;
          this.publish();
        }
      };
      inject() {
        return { hooks: { searchSettings: this }, edit: this.edit, reset: this.reset, discard: this.discard, save: this.save };
      }
    }

    function SearchSettingsCard(props) {
      const state = props.useSearchSettings(value => value);
      const t = props.t;
      if (!state.available) return null;
      const disabled = !state.writable || state.saving;
      return h("li", { className: "desktop-search-card" }, h("details", null,
        h("summary", null, t("title"), state.dirty ? ` (${t("pending")})` : "", h("small", null, t("description"))),
        h("form", { className: "desktop-search-body", onSubmit: event => { event.preventDefault(); void props.save(); } },
          h("label", null, t("mode"), h("select", {
            id: "plugin-config-web-search-mode", value: state.mode, disabled,
            onChange: event => props.edit("mode", event.target.value)
          }, modes.map(mode => h("option", { key: mode, value: mode }, t(mode))))),
          state.mode === "independent" ? h("label", null, t("provider"),
            h("input", {
              id: "plugin-config-web-search-provider", value: state.independentProvider, disabled,
              list: "plugin-config-web-search-provider-options", spellCheck: false,
              onChange: event => props.edit("independentProvider", event.target.value)
            }),
            h("datalist", { id: "plugin-config-web-search-provider-options" },
              h("option", { value: "deepseek-official" })
            ),
            h("p", null, t("providerHint"))
          ) : null,
          !state.writable ? h("p", null, t("readOnly")) : null,
          h("p", { role: state.activationPhase === "failed" ? "alert" : "status" }, t(state.activationPhase === "failed" ? "activationFailed" : state.activationPhase)),
          state.invalid || state.failed ? h("p", { role: "alert" }, t(state.invalid ? "invalid" : "failed")) : null,
          h("footer", null,
            h("button", { type: "button", disabled: disabled || !state.overridden, onClick: props.reset }, t("reset")),
            h("button", { type: "button", disabled: state.saving || (!state.dirty && !state.failed), onClick: props.discard }, t("discard")),
            h("button", { type: "submit", disabled: disabled || (!state.dirty && state.activationPhase !== "failed") || state.invalid }, t("save"))
          )
        )
      ));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(localeNamespace, dictionaries), "web-search: settings dictionaries");
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "@deepseek-ai/dsh-web-search-follow-model";
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      }, "web-search: settings styles");
      const controller = new SearchSettingsController(ctx.settingsScope.bind({ namespace }), async (apply, revision) => {
        const result = await ctx.connection.rpc.call("/desktop-web-search", apply ? "apply" : "status", { revision }, AbortSignal.timeout(65_000));
        if (!result.ok) throw new Error("Search activation could not be confirmed.");
        return result.value;
      });
      ctx.effect(() => controller.dispose, "web-search: settings scope");
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item", key: namespace, locale: localeNamespace,
        inject: () => controller.inject()
      }, SearchSettingsCard));
    }

    return { inject: ["slots", "locale", "settingsScope", "connection"], apply, SearchSettingsController, dictionaries };
  }
});
