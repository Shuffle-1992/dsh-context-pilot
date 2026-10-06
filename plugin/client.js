window.__ModuleLoader__.load({
	id: "@local/dsh-context-pilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-context-pilot client 半（M4.5 插件详情页配置卡片）。
		 *
		 * 结构完全照 dsh-connect-zcode lib/client.js 的信封与卡注册（不发明 API）：
		 * - ModuleLoader 信封（自足 bundle，无构建步骤；唯一外部 require 是宿主提供的 react）；
		 * - 卡注册 plugins.bundle.config，key = bundle 包名（slot 契约）；
		 * - 设置读写走 configForms 软探测 + 命名空间重绑定（zcode/trae 同款），
		 *   写后必须回读校验（set() resolve ≠ 真存进去了）；
		 * - apply() 整体 try/catch，失败只 console.error，绝不抛（宿主详情页不被打崩）。
		 */
		const react = require("react"); // B6（审查）：无重赋值，const
		const el = react.createElement;
		/* B6（审查）：散挂 window 的 6 个全局名收敛为单命名空间（防与其他插件撞名、便于整体清理）。
		 * 控制台取证路径变更：__DSH_CONTEXT_PILOT__.sid / .hudDebug / .gen 一次可读全貌。 */
		const NS = (window.__DSH_CONTEXT_PILOT__ = window.__DSH_CONTEXT_PILOT__ || {});

		/** 卡片 key = bundle 包名（plugins.bundle.config slot 契约）。 */
		const BUNDLE_KEY = "@local/dsh-context-pilot";
		/** 设置命名空间匹配（host 的 settingsNs = Loader entry id，本插件）。 */
		const NS_PATTERN = /context-pilot/i;
		const LOG = "[dsh-context-pilot/client]";
		/** HUD 轮询面（client→host remote；host 侧 wire.host.mjs ctx.provide 注册）。 */
		const HUD_FACE = "dshContextPilot";
		/** remote 贡献声明（与 wire.host.mjs FACE_METHOD_TABLE 逐字对账——漂移=调用静默失败）。 */
		const REMOTE_CONTRIBUTION = {
			package: "@local/dsh-context-pilot",
			descriptors: [
				{
					id: `@local/dsh-context-pilot#${HUD_FACE}/getHud`,
					service: HUD_FACE,
					namespace: HUD_FACE,
					method: "getHud",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "sid",
							wire: "sid",
							source: "json",
							acceptsUndefined: true,
							codec: { mode: "strict", typeSymbol: `@local/dsh-context-pilot#${HUD_FACE}/getHud:sid`, create: () => ({ parse: (value) => value }) },
						},
					],
					result: {
						mode: "strict",
						typeSymbol: `@local/dsh-context-pilot#${HUD_FACE}/getHud:result`,
						create: () => ({ parse: (value) => value }),
					},
				},
			],
		};

		/** 字段描述符（与 host.impl.mjs M3_DEFAULTS / plugin-config.schema.mjs 一一对应）。 */
		const FIELDS = [
			{ key: "enabled", label: "总开关", type: "bool", def: true, hint: "关闭后不注入、不决策、不压缩" },
			{ key: "dryRun", label: "演习模式", type: "bool", def: false, hint: "只记录决策，不真执行压缩" },
			{ key: "criticalRatio", label: "危险线", type: "num", def: 0.85, hint: "占用达此值：任务执行前/空闲时无条件强制压缩" },
			{ key: "marker", label: "压缩标记", type: "text", def: "[cp:compact]", hint: "模型回复尾行标记；置空字符串关闭标记通道" },
			{ key: "markerMinRatio", label: "标记最低占用", type: "num", def: 0.2, hint: "低于此占用，标记不触发压缩（无意义）" },
			{ key: "armedTtlMs", label: "标记武装有效期(ms)", type: "int", def: 120000 },
			{ key: "policyCardMinRatio", label: "压缩决策提示词注入", type: "num", def: 0.3, hint: "占用达此值（0-1）才注入压缩决策提示词；低于此不注入（省 token）" },
			{ key: "highRatio", label: "审计参考线", type: "num", def: 0.6, hint: "仅审计口径" },
			{ key: "lightTaskChars", label: "轻任务字符阈值", type: "int", def: 4000, hint: "仅审计口径" },
			{ key: "sweepMinIntervalMs", label: "兜底扫除最小间隔(ms)", type: "int", def: 600000, hint: "危险线兜底受限；标记模式不受限" },
		];

		//#region helpers
		/** 剥 volatile 活引用（zcode unwrapLiveDeep 同款）。 */
		function unwrapLiveDeep(value) {
			if (value === null || typeof value !== "object") return value;
			if (typeof value.get === "function") return unwrapLiveDeep(value.get());
			if (Array.isArray(value)) return value.map((entry) => unwrapLiveDeep(entry));
			const source = value;
			const out = {};
			for (const key of Object.keys(source)) out[key] = unwrapLiveDeep(source[key]);
			return out;
		}
		/** 字段值规范化（写前/回读比对同一口径）。 */
		function canon(field, value) {
			if (field.type === "bool") return value === true;
			if (field.type === "num") { const n = Number(value); return Number.isFinite(n) ? n : null; }
			if (field.type === "int") { const n = Math.round(Number(value)); return Number.isFinite(n) ? n : null; }
			return typeof value === "string" ? value : void 0;
		}
		/** 解析输入框字符串 → 字段类型值；非法返回 null。 */
		function parseInput(field, raw) {
			if (field.type === "bool") return raw === true;
			if (field.type === "text") return typeof raw === "string" ? raw : null;
			/* C5（审查）：清空输入拦为 null——原 Number('')=0 会把 armedTtlMs/比率存成 0（armedTtl=0 即标记通道废）。
			 * null 走表单既有的「输入不合法」错误提示路径。 */
			if (typeof raw === "string" && raw.trim() === "") return null;
			const n = Number(raw);
			if (!Number.isFinite(n)) return null;
			if (field.type === "int") return Math.round(n);
			return n;
		}
		/**
		 * 写一个设置字段并回读校验（zcode writeField 同款纪律）：
		 * set() resolve false = Host 拒绝；resolve true 也不代表落盘，必须读回比对。
		 */
		async function writeField(scope, field, value) {
			if (!scope || typeof scope.set !== "function") throw new Error("设置服务不可用，面板处于只读状态。");
			if ((await scope.set(field.key, value)) === false) {
				throw new Error(`Host 拒绝写入 ${field.label}（${field.key}）。常见原因：设置命名空间未就绪，可稍后重试。`);
			}
			const readBack = canon(field, unwrapLiveDeep(scope.getSnapshot().value)?.[field.key]);
			if (JSON.stringify(readBack) !== JSON.stringify(canon(field, value))) {
				throw new Error(`写入未被持久化（${field.label} 读回值与写入值不一致），界面即将回弹。`);
			}
		}
		//#endregion
		//#region 样式（一次性注入；token 名来自 zcode 实测清单，回退值主题无关）
		const PANEL_CSS = [
			".dcp-panel{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,currentColor)}",
			".dcp-summary{color:var(--dsw-alias-label-secondary,currentColor);opacity:.85}",
			".dcp-grid{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".dcp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".dcp-label{width:170px;color:var(--dsw-alias-label-secondary,currentColor);flex:none}",
			".dcp-input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,currentColor);padding:3px 8px;font-size:12px;min-width:110px}",
			".dcp-hint{color:var(--dsw-alias-label-secondary,currentColor);opacity:.75;font-size:11px}",
			".dcp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
			".dcp-btn{padding:4px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,currentColor);cursor:pointer;font-size:12px}",
			".dcp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}",
			".dcp-btn:disabled{opacity:.5;cursor:not-allowed}",
			".dcp-btn-primary{border-color:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-brand-primary,currentColor);font-weight:600}",
			".dcp-msg-ok{color:var(--dsw-alias-state-success-primary,currentColor);font-weight:600;font-size:12px}",
			".dcp-msg-error{color:var(--dsw-alias-state-error-primary,currentColor);font-weight:600;font-size:12px;word-break:break-all}"
		].join("\n");
		if (typeof document !== "undefined") {
			const cssId = "dsh-context-pilot/client.css";
			if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-context-pilot";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = PANEL_CSS;
				document.head.appendChild(styleTag);
			}
		}
		//#endregion
		//#region 卡片组件
		/** props.view：'summary'（详情页顶部一行）| 'page'（完整表单）。settingsScope 走闭包。 */
		function PilotPanelCard({ view }) {
			const snapshot = settingsScope.getSnapshot();
			const writable = snapshot.writable === true;
			const stored = unwrapLiveDeep(snapshot.value) ?? {};
			const [rev, setRev] = react.useState(0);
			/** 草稿：{key: 原始输入串/布尔}；null = 未编辑。 */
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [message, setMessage] = react.useState(void 0);
			react.useEffect(() => {
				if (settingsScope.subscribe === void 0) return void 0;
				return settingsScope.subscribe(() => setRev((v) => v + 1));
			}, [settingsScope]);
			const valueOf = (field) => {
				if (draft !== null && Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key];
				const v = stored[field.key];
				return v === void 0 ? field.def : v;
			};
			const dirty = draft !== null && FIELDS.some((f) => {
				const cur = parseInput(f, valueOf(f));
				const base = canon(f, stored[f.key] === void 0 ? f.def : stored[f.key]);
				return cur === null || JSON.stringify(canon(f, cur)) !== JSON.stringify(base);
			});
			const setField = (field, raw) => {
				setDraft((d) => ({ ...(d ?? {}), [field.key]: raw }));
				setMessage(void 0);
			};
			const save = async () => {
				if (saving || draft === null) return;
				setSaving(true);
				setMessage(void 0);
				try {
					for (const field of FIELDS) {
						if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue;
						const parsed = parseInput(field, draft[field.key]);
						if (parsed === null) throw new Error(`${field.label}：输入不是合法的${field.type === "text" ? "字符串" : "数值"}。`);
						const base = canon(field, stored[field.key] === void 0 ? field.def : stored[field.key]);
						if (JSON.stringify(canon(field, parsed)) === JSON.stringify(base)) continue; // 未变不写
						await writeField(settingsScope, field, parsed);
					}
					setDraft(null);
					setMessage({ kind: "ok", text: "已保存并回读校验通过。" });
				} catch (error) {
					setMessage({ kind: "error", text: String(error?.message ?? error) });
				} finally {
					setSaving(false);
				}
			};
			if (view === "summary") {
				const crit = Math.round(valueOf(FIELDS.find((f) => f.key === "criticalRatio")) * 100);
				const marker = valueOf(FIELDS.find((f) => f.key === "marker"));
				return el("span", { className: "dcp-summary" },
					`危险线 ${crit}% ｜ 标记 ${marker ? marker : "关闭"} ｜ 演习 ${valueOf(FIELDS.find((f) => f.key === "dryRun")) ? "开" : "关"}`);
			}
			return el("div", { className: "dcp-panel" },
				el("div", { className: "dcp-grid" },
					FIELDS.map((field) => el("div", { className: "dcp-row", key: field.key },
						el("label", { className: "dcp-label", title: field.hint }, field.label),
						field.type === "bool"
							? el("input", {
								type: "checkbox", disabled: !writable || saving,
								checked: valueOf(field) === true,
								onChange: (e) => setField(field, e.target.checked),
							})
							: el("input", {
								className: "dcp-input", type: field.type === "text" ? "text" : "number",
								step: field.type === "num" ? 0.05 : field.type === "int" ? 100 : void 0,
								disabled: !writable || saving,
								value: String(valueOf(field)),
								onChange: (e) => setField(field, e.target.value),
							}),
						el("span", { className: "dcp-hint" }, field.hint ?? ""),
					)),
				),
				el("div", { className: "dcp-actions" },
					el("button", {
						className: "dcp-btn", disabled: !writable || saving || draft === null,
						onClick: () => { setDraft(null); setMessage(void 0); },
					}, "放弃修改"),
					el("button", {
						className: "dcp-btn dcp-btn-primary", disabled: !writable || saving || !dirty,
						onClick: save,
					}, saving ? "保存中…" : "保存"),
					writable ? null : el("span", { className: "dcp-hint" }, "设置命名空间不可写（尚未就绪），当前只读。"),
					message !== void 0 ? el("span", { className: message.kind === "ok" ? "dcp-msg-ok" : "dcp-msg-error", role: "status" }, message.text) : null,
				),
				el("div", { className: "dcp-hint" },
					"保存写入插件配置并触发重载；标记通道：模型回复尾行写标记 → 本轮结束自动压缩（详见政策卡）。"),
			);
		}
		/** 错误边界：渲染异常只留痕，绝不冒泡打崩插件详情页。 */
		function CardBoundary(props) {
			try {
				return el(PilotPanelCard, props);
			} catch (error) {
				console.warn(`${LOG} 卡片渲染失败:`, error && error.message);
				return null;
			}
		}
		//#endregion
		//#region apply
		const name = "dsh-context-pilot-client";
		/**
		 * client 服务 inject：slots（卡注入）+ locale + remote + typert。
		 * 机制（zcode 实证）：configForms 由 dsh-client-ui-settings 的 client 半提供，
		 * 而它要求组合里先有 remote 服务才激活——缺 remote ⇒ configForms 恒 undefined ⇒ 面板永久只读。
		 * settingsScope 闭包绑定（bundle.config 卡不依赖 inject 载荷，browser-kit 同款）。
		 * typert（browser-kit client.js:504 同款）：$mount 的硬依赖——缺它 ⇒ $mount 抛
		 * `cannot get property "typert" without inject`（2026-10-06 实证）⇒ HUD 轮询面挂不上。
		 */
		const inject = ["slots", "locale", "remote", "typert"];
		let settingsScope = { getSnapshot: () => ({ status: "unavailable", value: void 0, writable: false }), subscribe: void 0, set: () => Promise.resolve(false) };
		let hudRemoteSvc = null; // getHud 轮询面句柄（ctx.inject 捕获）
		function apply(ctx) {
			try {
				const forms = ctx.get ? ctx.get("configForms") : void 0;
				/** 命名空间重绑定（zcode :479-519 同款）：镜像就绪前 writable=false，面板只读。 */
				let current;
				let currentOff;
				const listeners = new Set();
				const notify = () => { for (const listener of [...listeners]) listener(); };
				const scope = {
					getSnapshot: () => (current !== void 0 ? current.getSnapshot() : settingsScope.getSnapshot()),
					subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
					set: (field, value) => (current !== void 0 ? current.set(field, value) : Promise.resolve(false)),
				};
				const rebind = () => {
					let served;
					try {
						served = (forms?.describe().getSnapshot().view?.namespaces ?? []).find((entry) => NS_PATTERN.test(entry.ns));
					} catch { /* 形状未就绪 */ }
					const next = served === void 0 || forms === void 0 ? void 0 : forms.get(served.ns);
					if (next !== current) {
						currentOff?.();
						current = next;
						currentOff = current?.subscribe(notify);
						notify();
					}
					if (next === void 0) {
						try { (forms?.describe()).load?.(); } catch { /* 尽力加载 */ }
					}
				};
				rebind();
				forms?.describe().subscribe?.(rebind);
				settingsScope = scope;
				ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
					{ name: "plugins.bundle.config", key: BUNDLE_KEY, priority: 30, inject: () => ({}) },
					CardBoundary,
				));
				console.info(`${LOG} 配置卡片已注册（plugins.bundle.config）`);
				/* M5 HUD：client→host 轮询面挂载（configEditor 推送通道已判死，见 §6 M5）。 */
				try {
					const mount = ctx?.remote && ctx.remote.$mount;
					if (typeof mount === "function") {
						/* C6（审查）：$mount 失败退避重试（共 3 次尝试）——face/typert 时序性未就绪可自愈；
						 * 结构性失败（如缺 typert inject）多两条 warn 而已。 */
						let mountTries = 0;
						const tryMount = () => {
							mountTries += 1;
							Promise.resolve(mount.call(ctx.remote, REMOTE_CONTRIBUTION))
								.then(() => console.info(`${LOG} $mount 成功（第 ${mountTries} 次尝试）`))
								.catch((e) => {
									console.warn(`${LOG} $mount 失败（第 ${mountTries} 次尝试，HUD 无数据，不影响其他功能）:`, e && e.message);
									if (mountTries <= 2) setTimeout(tryMount, mountTries === 1 ? 3000 : 10000);
								});
						};
						tryMount();
					}
					if (typeof ctx?.inject === "function") {
						/* 回调参数是 scope，服务在 scope.remote.<名>（browser-kit pitfalls 同款——2026-10-06 实证：
						 * 直接把参数当服务存 ⇒ getHud 非函数 ⇒ 轮询静默空转，弹窗永远「暂无压缩记录」） */
						ctx.inject([`remote.${HUD_FACE}`], (scope) => {
							try {
								const svc = scope && scope.remote && scope.remote[HUD_FACE];
								if (svc && typeof svc.getHud === "function") {
									hudRemoteSvc = svc;
									console.info(`${LOG} remote.${HUD_FACE} 就绪（inject 子作用域）`);
									/* C6（审查）：就绪即拉一次——首帧数据不再干等下一个 5s tick（弹窗开着才有效） */
									if (typeof NS.pullHud === "function") NS.pullHud();
								}
							} catch { /* 就绪回调异常不影响条目 */ }
						});
					}
				} catch (e) {
					console.warn(`${LOG} HUD 轮询面挂载失败（吞）:`, e && e.message);
				}
				/* sessionId 捕获（按会话过滤 HUD）：钩一次 fetch，从任意 API URL 抓 sessionId=；
				 * 页面已发出的历史请求从 resource timing 补捞。会话切换后 5s 内自动跟随。 */
				try {
					if (!NS.sidHook) {
						NS.sidHook = true;
						const origFetch = window.fetch;
						if (typeof origFetch === "function") {
							window.fetch = function (...args) {
								try {
									const u = String((args[0] && args[0].url) || args[0] || "");
									const m = /sessionId=(session-[A-Za-z0-9-]+)/.exec(u);
									if (m) NS.sid = m[1];
								} catch { /* 忽略 */ }
								return origFetch.apply(this, args);
							};
						}
						try {
							for (const e of performance.getEntriesByType("resource")) {
								const m = /sessionId=(session-[A-Za-z0-9-]+)/.exec(e.name || "");
								if (m) NS.sid = m[1];
							}
						} catch { /* 忽略 */ }
					}
				} catch { /* 忽略 */ }
				installPopupToggle();
			} catch (error) {
				console.error(`${LOG} client 面板加载失败（host 半不受影响）:`, error);
			}
		}
		//#endregion
		//#region 上下文弹窗开关（M4.6）
		/**
		 * 在原生「上下文已用 x%」悬浮弹窗里加一个插件总开关（DOM 注入 + 守卫重挂）。
		 * 妥协声明（browser-kit toolbar 注入同款）：弹窗是宿主内部组件、无官方插槽，
		 * DSH 升级可能失效——失效只是开关不见了，注入/压缩功能与配置卡片不受影响。
		 * 写入走 settingsScope.set('enabled') + 回读校验；host 端 effEnabled() 活读，即时生效。
		 */
		function installPopupToggle() {
			try {
				if (typeof MutationObserver === "undefined" || !document?.body) return;
				/* P37 多实例纪律：新 apply 先断旧观察器/旧轮询，绝不两个实例同时拉锯 */
				if (NS.popupObserver) {
					try { NS.popupObserver.disconnect(); } catch { /* 忽略 */ }
				}
				if (NS.popupTimer) {
					try { clearInterval(NS.popupTimer); } catch { /* 忽略 */ }
				}
				/* C4（审查）：订阅登记——弹窗关闭后行随面板离开 DOM，登记表统一退订，
				 * 防 settingsScope.listeners 里死回调随弹窗反复重开而累积空转。 */
				const liveRows = [];
				const sweepRows = () => {
					for (let i = liveRows.length - 1; i >= 0; i--) {
						const rec = liveRows[i];
						if (rec.row.isConnected) continue;
						if (typeof rec.off === "function") { try { rec.off(); } catch { /* 忽略 */ } }
						liveRows.splice(i, 1);
					}
				};
				let scheduled = false;
				/** 主题判定：沿祖先找第一个不透明背景按亮度判暗/亮；兜底按 body 文字色反推（亮字=暗主题）。 */
				const isDarkBg = (el) => {
					try {
						let node = el;
						for (let i = 0; node && i < 8; i++) {
							const bg = String(getComputedStyle(node).backgroundColor || "");
							const rgb = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
							const al = bg.match(/,\s*([\d.]+)\s*\)/);
							if (rgb && (!al || Number(al[1]) > 0.5)) {
								return (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) < 128;
							}
							node = node.parentElement;
						}
						const fg = String(getComputedStyle(document.body).color || "");
						const f = fg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
						if (f) return (0.2126 * Number(f[1]) + 0.7152 * Number(f[2]) + 0.0722 * Number(f[3])) > 128;
					} catch { /* 忽略 */ }
					return true;
				};
				const buildRow = (panel) => {
					const row = document.createElement("div");
					row.dataset.dcpToggle = "1";
					/* 结构复刻原生明细行（ContextMeter .row = [8px 色块 + 6px 间距] + 文字）：
						行左缘即面板色块列起点（padding-left:0）→ 图标对齐色块列、文字对齐 dt 文字列，零测量天然同轴 */
					row.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 12px 6px 0;border-top:1px solid rgba(128,128,128,.25);text-align:left;";
					const icon = document.createElement("span");
					icon.style.cssText = "display:inline-block;width:8px;height:8px;border-radius:2px;background:#4c7dff;flex:none;";
					const label = document.createElement("span");
					label.textContent = "上下文领航";
					label.title = "注入 + 压缩总开关（关闭 = 恢复原生 DSH 行为）";
					label.style.cssText = "flex:1 1 auto;opacity:.85;white-space:nowrap;";
					/** 滑动开关：原生 checkbox 隐入底层（保点击/键盘可达），外观仿宿主 switch（主题 token 自适应深浅色）。 */
					const wrap = document.createElement("label");
					wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;flex:none;";
					const box = document.createElement("span");
					box.style.cssText = "position:relative;display:inline-block;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.45));transition:background .15s;cursor:pointer;";
					const input = document.createElement("input");
					input.type = "checkbox";
					input.setAttribute("role", "switch");
					input.setAttribute("aria-label", "上下文领航总开关");
					input.style.cssText = "position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;";
					const knob = document.createElement("span");
					knob.style.cssText = "position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:left .15s;pointer-events:none;";
					box.appendChild(input);
					box.appendChild(knob);
					wrap.appendChild(box);
					wrap.appendChild(document.createTextNode("启用"));
					const sync = () => {
						try {
							const s = settingsScope.getSnapshot();
							const raw = s?.value?.enabled;
							const value = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
							input.checked = value !== false;
							/* 双主题配色：开=品牌蓝（两主题通用）；关=轨道/旋钮按面板明暗反色，两态一眼可辨 */
							const dark = isDarkBg(panel);
							box.style.background = input.checked ? "#4c7dff" : dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.24)";
							knob.style.background = input.checked ? "#ffffff" : dark ? "#d5dae2" : "#ffffff";
							knob.style.boxShadow = input.checked ? "0 1px 2px rgba(0,0,0,.35)" : dark ? "none" : "0 1px 3px rgba(0,0,0,.25)";
							knob.style.left = input.checked ? "18px" : "2px";
							input.disabled = s?.writable !== true;
							wrap.style.opacity = s?.writable === true ? "1" : ".55";
							label.style.opacity = s?.writable === true ? ".85" : ".45";
							wrap.title = s?.writable === true ? "关闭 = 完全恢复原生 DSH 行为" : "设置命名空间未就绪，暂不可切换";
						} catch { /* 快照失败保持现状 */ }
					};
					input.addEventListener("change", async () => {
						const next = input.checked;
						input.disabled = true;
						try {
							if ((await settingsScope.set("enabled", next)) === false) throw new Error("Host 拒绝写入");
							const backRaw = unwrapLiveDeep(settingsScope.getSnapshot().value)?.enabled;
							if (backRaw !== next) throw new Error("写入未持久化，已回弹");
						} catch (error) {
							console.warn(`${LOG} 弹窗开关写入失败:`, error && error.message);
						} finally {
							sync();
						}
					});
					if (typeof settingsScope.subscribe === "function") liveRows.push({ row, off: settingsScope.subscribe(sync) }); // C4：off 在册
					sync();
					row.appendChild(icon);
					row.appendChild(label);
					row.appendChild(wrap);
					return row;
				};
				/** M5 HUD 行：最近压缩摘要 + 武装/待执行徽章。数据源 = host 轮询 getHud（5s）覆盖 + 配置镜像兜底。 */
				const buildHudRow = () => {
					const row = document.createElement("div");
					row.dataset.dcpHud = "1";
					/* HUD 行水平居中（用户要求）：对称 padding + justify-content:center，文字+徽章整组居中 */
					row.style.cssText = "display:flex;align-items:center;justify-content:center;gap:8px;padding:2px 12px 8px;text-align:center;";
					const label = document.createElement("span");
					label.style.cssText = "opacity:.72;white-space:nowrap;";
					const chips = document.createElement("span");
					chips.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex:none;";
					const chip = (text, color) => {
						const c = document.createElement("span");
						c.textContent = text;
						c.style.cssText = `display:inline-block;padding:0 6px;border-radius:6px;font-size:11px;line-height:16px;border:1px solid ${color};color:${color};`;
						return c;
					};
					let hudRemote = null; // getHud 结果（覆盖配置镜像同名字段）
					const renderHud = () => {
						try {
							const cfg = unwrapLiveDeep(settingsScope.getSnapshot()?.value) ?? {};
							const v = { ...cfg, ...(hudRemote ?? {}) };
							const act = typeof v.hudLastAct === "string" && v.hudLastAct ? v.hudLastAct : "";
							label.textContent = act ? `最近压缩 ${act}` : "本会话暂无压缩记录";
							/* 悬停 = 本会话最近压缩列表（新→旧，最多 5 条）+ 取证指纹 */
							const actLines = Array.isArray(v.acts) && v.acts.length ? v.acts : (act ? [act] : []);
							row.title = `${actLines.length ? actLines.join("\n") : "（本会话暂无压缩记录）"}\n—— dcp: gen=${v.gen || "?"} sid=${(NS.sid || "").slice(0, 13) || "?"}`;
							chips.replaceChildren();
							if (v.hudArmed === "armed") chips.appendChild(chip("武装中", "#4c7dff"));
							let pendingTask = "";
							try { const p = JSON.parse(v.hudPending || "null"); if (p && p.task) pendingTask = String(p.task); } catch { /* 非 JSON 忽略 */ }
							if (pendingTask) {
								const c = chip("待执行", "#e3b341");
								c.title = `压缩后自动恢复执行：${pendingTask}`;
								chips.appendChild(c);
							}
							if (v.dryRun === true) chips.appendChild(chip("演习", "rgba(128,128,128,.9)"));
						} catch { /* 快照失败保持现状 */ }
					};
					if (typeof settingsScope.subscribe === "function") liveRows.push({ row, off: settingsScope.subscribe(renderHud) }); // C4：off 在册
					renderHud();
					/* 5s 轮询 host（wire.host.mjs getHud → state.m5.hud）；立即拉一次 */
					/* face 代理返回 {ok,value} 信封（browser-kit client.js:2098 同款实测坑）：必须拆包，
					 * 否则 r.hudLastAct 恒 undefined ⇒ HUD 永远空态。无信封形态（直连）原样透传。 */
					const unwrapEnv = (raw) => {
						if (raw && typeof raw === "object" && "value" in raw) {
							return raw.ok ? raw.value : { ok: false, error: (raw.error && raw.error.message) || String(raw.error ?? "remote error") };
						}
						return raw;
					};
					let everConnected = false; // C4：首次 pull 时 row 尚未 append（isConnected=false 属正常），只在「曾连过又断开」时自停
					let myTimerId = null;
					let myPullFn = null;
					/** C4：停止本行轮询——只在计时器/桥仍属于本行时清，防旧行的回调误清新行（弹窗关→开瞬间竞态）。 */
					const stopPolling = () => {
						if (myTimerId != null && NS.hudTimer === myTimerId) {
							try { clearInterval(myTimerId); } catch { /* 忽略 */ }
							NS.hudTimer = null;
						}
						myTimerId = null;
						if (myPullFn != null && NS.pullHud === myPullFn) NS.pullHud = null;
						myPullFn = null;
					};
					const pullHud = async () => {
						try {
							/* C4（审查）：行已随弹窗关闭离开 DOM → 自停 5s 轮询（订阅退订由 sweepRows 就近接管） */
							if (row.isConnected) everConnected = true;
							else if (everConnected) {
								stopPolling();
								return;
							}
							if (!hudRemoteSvc || typeof hudRemoteSvc.getHud !== "function") {
								NS.hudDebug = { svc: false, at: Date.now() };
								return;
							}
							const sidNow = NS.sid || "";
							let r = unwrapEnv(await hudRemoteSvc.getHud(sidNow));
							if ((!r || !r.ok) && sidNow) {
								/* 协议未生效（旧 face/typert 未重载）时带参可能被拒：退回无参全局查询 */
								r = unwrapEnv(await hudRemoteSvc.getHud(""));
							}
							if (r && r.ok) {
								hudRemote = {
									hudLastAct: r.hudLastAct || "",
									hudArmed: r.hudArmed || "",
									hudPending: r.hudPending || "",
									gen: r.gen || "",
									acts: Array.isArray(r.acts) ? r.acts : null,
								};
								NS.hudDebug = { svc: true, ok: true, act: r.hudLastAct ?? null, gen: r.gen ?? null, acts: Array.isArray(r.acts) ? r.acts.length : null, sid: (NS.sid || "").slice(0, 13) || null, at: Date.now() };
								renderHud();
							} else {
								NS.hudDebug = { svc: true, ok: false, r: r && r.error || JSON.stringify(r)?.slice(0, 120), at: Date.now() };
							}
						} catch (e) {
							NS.hudDebug = { svc: true, err: String((e && e.message) || e).slice(0, 160), at: Date.now() };
						}
					};
					NS.pullHud = pullHud; // C6：就绪回调可立即触发首拉（跨行桥；行移除时置 null）
					myPullFn = pullHud;
					pullHud();
					/* 重挂防护：清掉上一行留下的旧轮询（弹窗每次重开都会重建本行） */
					if (NS.hudTimer) { try { clearInterval(NS.hudTimer); } catch { /* 忽略 */ } }
					myTimerId = setInterval(() => { try { pullHud(); } catch { /* 忽略 */ } }, 5000);
					NS.hudTimer = myTimerId;
					row.appendChild(label);
					row.appendChild(chips);
					return row;
				};
				/** 弹窗根定位（v3，源码取证版）：dsh-client-ui-conversation 的 ContextMeter 面板
				 *  经 createPortal(…, document.body) 挂到 body 直下，role="dialog"、
				 *  aria-label=context.used（zh「上下文已用」/ en "of context used"）——
				 *  属性选择器一击命中；找不到时兜底扫同源 iframe（聊天视图若被沙箱进子框架）。 */
				const PANEL_SELECTORS = [
					'div[role="dialog"][aria-label="上下文已用"]',
					'div[role="dialog"][aria-label="of context used"]',
				].join(",");
				const queryPanel = (doc) => {
					try { return doc.querySelector(PANEL_SELECTORS); } catch { return null; }
				};
				const findPanel = () => {
					const direct = queryPanel(document);
					if (direct) return direct;
					try {
						for (const frame of document.querySelectorAll("iframe")) {
							let inner; try { inner = frame.contentDocument; } catch { continue; }
							const hit = inner ? queryPanel(inner) : null;
							if (hit) return hit;
						}
					} catch { /* 跨域帧不可入 */ }
					return null;
				};
			/* D3（审查）：开关行与 HUD 行拆独立安装（各自「已挂」守卫）——aria 定位/宿主改版导致其一失效时
			 * 另一行不受牵连（原实现只守卫开关行，HUD 行会被连坐跳过），也为「HUD 行可关」留位。 */
			const installToggleRow = (panel) => {
				if (panel.querySelector("[data-dcp-toggle]")) return false;
				panel.appendChild(buildRow(panel));
				return true;
			};
			const installHudRow = (panel) => {
				if (panel.querySelector("[data-dcp-hud]")) return false;
				panel.appendChild(buildHudRow());
				return true;
			};
			const tryInject = () => {
				try {
					sweepRows(); // C4：先退订已离开 DOM 的行的订阅
					const panel = findPanel();
					if (!panel) return;
					installToggleRow(panel);
					installHudRow(panel);
				} catch { /* 注入失败不影响其他功能 */ }
			};
				const observer = new MutationObserver(() => {
					if (scheduled) return;
					scheduled = true;
					setTimeout(() => { scheduled = false; tryInject(); }, 120);
				});
				observer.observe(document.body, { childList: true, subtree: true });
				NS.popupObserver = observer;
				/* 1.2s 轮询兜底：MutationObserver 时序/路径再诡异也漏不过轮询（query 成本可忽略） */
				NS.popupTimer = setInterval(() => { try { tryInject(); } catch { /* 忽略 */ } }, 1200);
				tryInject();
				console.info(`${LOG} 上下文弹窗开关已挂（v3 aria 定位 + 轮询兜底）`);
			} catch (error) {
				console.warn(`${LOG} 弹窗开关安装失败（不影响其他功能）:`, error && error.message);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
