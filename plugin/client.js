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

		/** 字段描述符（与 host.impl.mjs M3_DEFAULTS / plugin-config.schema.mjs 一一对应）。
		 *  存储口径：比率类字段为 0-1 小数；时长类字段**存储仍为毫秒**（兼容 host/schema/已有配置），
		 *  scale:1000 仅在 UI 层做「秒 ↔ 毫秒」换算（parseInput/canon/显示/草稿比较统一按秒）。
		 *  备注精简原则（2026-10-07 用户要求）：一行说清用途，不写推荐值枚举（推荐值在计算器里实时算）。 */
		const FIELDS = [
			{ key: "enabled", label: "总开关", type: "bool", def: true, hint: "关闭后完全恢复原生 DSH" },
			{ key: "markerMinRatio", label: "智能压缩线", type: "num", def: 0.2, hint: "占用达此值时，模型可自行决定压缩并自动续跑" },
			{ key: "criticalRatio", label: "强制压缩线", type: "num", def: 0.85, hint: "占用达此值无条件强制压缩（先于 DSH 引擎自动压缩触发）" },
			{ key: "marker", label: "压缩标记", type: "text", def: "[cp:compact]", hint: "模型回复尾行标记；置空则关闭智能压缩" },
			{ key: "armedTtlMs", label: "标记有效期(秒)", type: "int", def: 120000, scale: 1000, hint: "标记后多久内有效" },
			{ key: "sweepMinIntervalMs", label: "强制压缩冷却(秒)", type: "int", def: 600000, scale: 1000, hint: "两次强制压缩的最小间隔" },
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
		/** 字段值规范化（写前/回读比对同一口径）。
		 *  scale>1 的字段（如时长字段存 ms、UI 用秒）：本函数与 parseInput 都工作在**存储口径**（ms）。 */
		function canon(field, value) {
			if (field.type === "bool") return value === true;
			if (field.type === "num") { const n = Number(value); return Number.isFinite(n) ? n : null; }
			if (field.type === "int") { const n = Math.round(Number(value)); return Number.isFinite(n) ? n : null; }
			return typeof value === "string" ? value : void 0;
		}
		/** 解析输入框字符串 → 字段类型值（**存储口径**：scale 字段在此把「秒」换回「毫秒」）；非法返回 null。 */
		function parseInput(field, raw) {
			if (field.type === "bool") return raw === true;
			if (field.type === "text") return typeof raw === "string" ? raw : null;
			/* C5（审查）：清空输入拦为 null——原 Number('')=0 会把 armedTtlMs/比率存成 0（armedTtl=0 即标记通道废）。
			 * null 走表单既有的「输入不合法」错误提示路径。 */
			if (typeof raw === "string" && raw.trim() === "") return null;
			const n = Number(raw);
			if (!Number.isFinite(n)) return null;
			const scaled = field.scale ? n * field.scale : n; // UI 秒 → 存储毫秒
			if (field.type === "int") return Math.round(scaled);
			return scaled;
		}
		/** 存储值 → UI 显示值（scale 字段：毫秒转秒）。 */
		function toUi(field, storedValue) {
			const base = storedValue === void 0 || storedValue === null ? field.def : storedValue;
			if (field.type === "bool") return base === true; // 布尔直通：Number(true)=1 会让 checked===true 判定假阴（实测回归）
			const n = Number(base);
			if (!Number.isFinite(n)) return base;
			return field.scale ? n / field.scale : n;
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
			/* 开关滑块（bool 字段）：**复刻 DSH 原生 Switch**（dsh-client-ui-primitives Switch.module.css，
			 * 已存 docs/reference 溯源；36×20 轨道 padding2 + 16px 旋钮 translateX16）。
			 * 全部用主题 token ⇒ 深浅主题自动适配（暗色下 ON=白轨道黑旋钮，与原生插件开关一致）。 */
			".dcp-switch{position:relative;display:inline-block;width:36px;height:20px;flex:none;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3,rgba(128,128,128,.4));cursor:pointer;box-sizing:border-box;transition:background 120ms ease}",
			".dcp-switch input{position:absolute;opacity:0;width:0;height:0;margin:0}",
			".dcp-switch:has(input:checked){background:var(--dsw-alias-brand-primary,rgba(76,125,255,.9))}",
			".dcp-switch:has(input:disabled){opacity:.5;cursor:default}",
			".dcp-switch .dcp-slider{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb,rgba(128,128,128,.85));transition:transform 120ms ease;pointer-events:none}",
			".dcp-switch input:checked + .dcp-slider{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}",
			".dcp-switch input:focus-visible + .dcp-slider{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c7dff));outline-offset:2px}",
			".dcp-label{width:170px;color:var(--dsw-alias-label-secondary,currentColor);flex:none}",
			".dcp-input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,currentColor);padding:3px 8px;font-size:12px;min-width:110px}",
			".dcp-hint{color:var(--dsw-alias-label-secondary,currentColor);opacity:.75;font-size:11px}",
			".dcp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
			".dcp-btn{padding:4px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,currentColor);cursor:pointer;font-size:12px}",
			".dcp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}",
			".dcp-btn:disabled{opacity:.5;cursor:not-allowed}",
			".dcp-btn-primary{border-color:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-brand-primary,currentColor);font-weight:600}",
			".dcp-msg-ok{color:var(--dsw-alias-state-success-primary,currentColor);font-weight:600;font-size:12px}",
			".dcp-msg-error{color:var(--dsw-alias-state-error-primary,currentColor);font-weight:600;font-size:12px;word-break:break-all}",
			/* 成本计算器 */
			".dcp-calc{margin-top:2px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:8px}",
			".dcp-calc-title{font-weight:600;font-size:12px}",
			".dcp-presets{display:flex;gap:6px;flex-wrap:wrap}",
			".dcp-preset{padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font-size:11px;line-height:16px}",
			".dcp-preset:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}",
			".dcp-preset[data-active='1']{border-color:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-brand-primary,currentColor);font-weight:600}",
			".dcp-calc-num{width:96px;min-width:96px}",
			".dcp-diag{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,currentColor);font-size:11px}",
			".dcp-rec{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;align-items:center}",
			".dcp-rec b{color:var(--dsw-alias-brand-primary,currentColor)}"
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
		//#region 成本计算器（把 README §7 成本模型做成可交互面板）
		/**
		 * 依据三档单价推算合理阈值。模型与 README §7 完全一致（同一套公式，改一处须同步另一处）：
		 *  - 单请求成本 = 命中价 × (上下文 - 新增) + 未命中价 × 新增 + 输出价 × 输出（此处只比较上下文相关项）
		 *  - 压缩摊销成本 ≈ 新增 × 未命中价（摘要调用读满上下文 ∝ 阈值，但压缩间隔也 ∝ 阈值，两者相消）
		 *  - 命中:未命中 比值越小（命中越便宜）⇒ 大上下文越无所谓 ⇒ 阈值可高（少压、保信息）
		 *  - 比值越大（命中仍贵）⇒ 上下文持续失血 ⇒ 阈值应低（压早、省额度）
		 * 实测常量（本机 2026-10-06）：新增/段 ≈ 6.8K token；压后回落 ≈ 25K。
		 */
		const CALC_CONST = { growth: 6800, floor: 25000 };
		/** 预设（全部为 **人民币 ¥/1M** 口径，2026-10-06 官方页取证；unit/div 决定「估算单请求」的显示与除数。
		 *  推荐值只依赖命中:未命中比值，与币种无关）。
		 *  ⚠️ GLM 两档为 Coding Plan 积分口径（订阅制，官方无 ¥/M 换算，无法诚实折算成人民币）；其余为官方实价。
		 *  ⚠️ Kimi K3 为参考价（官方定价页 JS 渲染无法直读）；千问 Max 的 ¥ 为统一价 $×7.1 折算（官方无 ¥ 价）。 */
		const PRICE_PRESETS = [
			{ id: "ds-flash", label: "DeepSeek flash(空闲)", hit: 0.02, miss: 1, out: 4, unit: "¥", div: 1e6, note: "官方 ¥/1M（空闲时段）；高峰时段 ×2（工作日 9-12/14-18 点）" },
			{ id: "ds-pro", label: "DeepSeek v4-pro(空闲)", hit: 0.15, miss: 4.5, out: 13.5, unit: "¥", div: 1e6, note: "官方 ¥/1M（空闲时段）；高峰时段 ×2" },
			{ id: "glm", label: "GLM-5.3", hit: 1.7, miss: 6.9, out: 24, unit: "积分", div: 1e4, note: "Coding Plan 积分系数/10000（订阅制，无官方 ¥/M 换算）；非高峰 ×50%" },
			{ id: "glm-flash", label: "GLM-5.3-Flash", hit: 0.56, miss: 2.3, out: 8, unit: "积分", div: 1e4, note: "Coding Plan 积分系数/10000（订阅制）；非高峰 ×50%" },
			{ id: "kimi-k3", label: "Kimi K3", hit: 1, miss: 4, out: 16, unit: "¥", div: 1e6, note: "参考价 ¥/1M（沿用 K2 系 1/4/16）；K3 另收缓存写入费（TTL 5min/1h）——以官方定价页为准" },
			{ id: "qwen-max", label: "千问 3.8-Max", hit: 1.78, miss: 14.2, out: 42.6, unit: "¥", div: 1e6, note: "QwenCloud 统一价 $×7.1 折算（官方无 ¥ 价）；北京区原生 $1.98/$5.94（缓存未列）" },
			{ id: "qwen-flash", label: "千问 3.8-Flash", hit: 0.1, miss: 0.8, out: 2.7, unit: "¥", div: 1e6, note: "官方北京区 ¥/1M（原生人民币价，无需换算）" },
			{ id: "step-5", label: "阶跃 step-5", hit: 0.35, miss: 7, out: 20, unit: "¥", div: 1e6, note: "官方 API ¥/1M；命中:未命中 1:20，折扣强度仅次于 DeepSeek" },
		];
		/**
		 * 由单价算推荐阈值。核心判据 = 上下文项占单请求成本的比例 ctxShare：
		 *   ctxShare 低（命中便宜，如 DS）⇒ 阈值高：多压一次的信息损失 > 省下的钱。
		 *   ctxShare 高（命中仍贵，如 GLM）⇒ 阈值低：压早直接换额度。
		 * 锚点（据 README §7.3 结构占比 + §7.4 弹性表校准；取实测 ctxShare 而非理想值，使计算器复现 §7.5 表）：
		 *   DS flash 在参考占用下 ctxShare≈50% → 推荐 markerMinRatio 0.30
		 *   GLM-5.3 在同占用下 ctxShare≈93% → 推荐 markerMinRatio 0.15
		 */
		function recommendFromPrice(hit, miss) {
			if (!(hit > 0) || !(miss > 0)) return null;
			const ratio = miss / hit; // 命中:未命中 的倒数（越小 = 命中越便宜）
			// 参考上下文取「中段占用」= 0.35 窗口，用于判定结构占比
			const REF = 0.35 * 1_000_000;
			const g = CALC_CONST.growth;
			const ctxShare = ((REF - g) * hit) / ((REF - g) * hit + g * miss);
			// 线性映射：ctxShare 0.50 → marker 0.30；ctxShare 0.93 → marker 0.15（两端夹逼到 [0.12, 0.40]）
			const lerp = (x, x0, x1, y0, y1) => y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
			const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
			const marker = clamp(lerp(ctxShare, 0.5, 0.93, 0.3, 0.15), 0.12, 0.4);
			const crit = clamp(lerp(ctxShare, 0.5, 0.93, 0.85, 0.8), 0.75, 0.9);
			// 2026-10-07：决策卡门槛 = 标记最低占用（用户决定）——不再有独立 card 值。
			const r2 = (v) => Math.round(v * 100) / 100;
			return {
				ratio, ctxShare,
				markerMinRatio: r2(marker),
				criticalRatio: r2(crit),
				verdict: ctxShare >= 0.8 ? "命中仍贵 ⇒ 上下文持续失血：建议压早（低阈值）"
					: ctxShare >= 0.6 ? "中间地带：建议中等阈值"
						: "命中很便宜 ⇒ 大上下文无所谓：建议压晚（高阈值），少压保信息",
			};
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
			/** 取字段的 **UI 口径**值：草稿已是 UI 串（秒），存储值经 toUi 转成 UI 口径（毫秒→秒）。 */
			const valueOf = (field) => {
				if (draft !== null && Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key];
				return toUi(field, stored[field.key]);
			};
			/** 字段备注：criticalRatio 动态追加引擎上限（C-own，NS.engineCap 由 HUD 轮询下发）。
			 *  上限值不写死（DSH 未来改 thresholdRatio 时自动跟随）；未探测到时只显示静态规则。 */
			const hintFor = (field) => {
				if (field.key !== "criticalRatio") return field.hint ?? "";
				const cap = typeof NS.engineCap === "number" && Number.isFinite(NS.engineCap) ? NS.engineCap : null;
				return cap === null
					? `${field.hint}；上限=DSH 引擎阈值（待探测，见弹窗阈值行）`
					: `${field.hint}；不可超过 DSH 内置 ${Math.round(cap * 100)}%，超出自动钳到该值`;
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
			/**
			 * 持久化一组字段值（{key: 值}），逐个写 + 回读校验；未变的跳过。
			 * 抽成独立函数的原因：计算器的「一键填入并保存」要写的是**推荐值**而非当前 draft，
			 * 若直接调 save() 只会存下旧 draft（闭包读的是 draft 快照）。
			 * @returns {Promise<{written: number}>}
			 */
			const persist = async (values) => {
				let written = 0;
				/* C-own：强制压缩线的**生效上限 = 引擎阈值**（方案 C，动态探测不写死 0.8）。
				 * 插件线必须先行（用户需求：插件开启时插件线生效，引擎只作关闭后的安全网）。
				 * NS.engineCap 由 HUD 轮询从 host 下发（engineThreshold 实测引擎实例 config）；
				 * 未拿到（旧 host/引擎未解析）时不钳制——host 侧 pre-step/sweep 还有同一道 min() 兜底。 */
				const cap = typeof NS.engineCap === "number" && Number.isFinite(NS.engineCap) && NS.engineCap > 0 && NS.engineCap <= 1 ? NS.engineCap : null;
				for (const field of FIELDS) {
					if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
					let parsed = parseInput(field, values[field.key]);
					if (parsed === null) throw new Error(`${field.label}：输入不是合法的${field.type === "text" ? "字符串" : "数值"}。`);
					if (field.key === "criticalRatio" && cap !== null && parsed > cap) {
						parsed = cap; // 超上限自动收到引擎线（而非报错——用户意图是"至少这么晚"，收到上限仍满足）
					}
					const base = canon(field, stored[field.key] === void 0 ? field.def : stored[field.key]);
					if (JSON.stringify(canon(field, parsed)) === JSON.stringify(base)) continue; // 未变不写
					await writeField(settingsScope, field, parsed);
					written += 1;
				}
				return { written };
			};
			const save = async () => {
				if (saving || draft === null) return;
				setSaving(true);
				setMessage(void 0);
				try {
					const { written } = await persist(draft);
					setDraft(null);
					setMessage({ kind: "ok", text: `已保存并回读校验通过${written === 0 ? "（无变化）" : `（${written} 项）`}。` });
				} catch (error) {
					setMessage({ kind: "error", text: String(error?.message ?? error) });
				} finally {
					setSaving(false);
				}
			};
			/** 计算器「一键填入并保存」：写推荐值 + 同步草稿（让上方表单立即反映新值）。
			 *  @returns {Promise<{ok:boolean, text:string}>} 供计算器内联展示结果 */
			const applyRecommendation = async (rec) => {
				if (saving) return { ok: false, text: "正在保存中，请稍候。" };
				setSaving(true);
				setMessage(void 0);
				try {
					const values = {
						markerMinRatio: rec.markerMinRatio,
						criticalRatio: rec.criticalRatio,
					};
					const { written } = await persist(values);
					setDraft(null); // 以写入值清理草稿，避免残留脏值
					/* C-own：persist 可能已把 criticalRatio 钳到引擎上限——回读真实生效值展示 */
					const appliedCrit = Math.min(rec.criticalRatio, typeof NS.engineCap === "number" ? NS.engineCap : rec.criticalRatio);
					const capNote = appliedCrit < rec.criticalRatio ? `（已按引擎上限 ${Math.round(NS.engineCap * 100)}% 收敛）` : "";
					const text = written === 0
						? "推荐值与当前配置一致，无需写入。"
						: `已应用并回读校验通过（${written} 项：智能压缩线 ${rec.markerMinRatio} / 强制压缩线 ${appliedCrit}${capNote}）`;
					setMessage({ kind: "ok", text: `${text}。` });
					return { ok: true, text };
				} catch (error) {
					const text = String(error?.message ?? error);
					setMessage({ kind: "error", text });
					return { ok: false, text };
				} finally {
					setSaving(false);
				}
			};
			if (view === "summary") {
				const crit = Math.round(valueOf(FIELDS.find((f) => f.key === "criticalRatio")) * 100);
				const marker = valueOf(FIELDS.find((f) => f.key === "marker"));
				return el("span", { className: "dcp-summary" },
					`强制压缩线 ${crit}% ｜ 标记 ${marker ? marker : "关闭"}`);
			}
			return el("div", { className: "dcp-panel" },
				el("div", { className: "dcp-grid" },
					FIELDS.map((field) => el("div", { className: "dcp-row", key: field.key },
						el("label", { className: "dcp-label", title: hintFor(field) }, field.label),
						field.type === "bool"
							? el("label", { className: "dcp-switch", title: hintFor(field) },
								el("input", {
									type: "checkbox", disabled: !writable || saving,
									checked: valueOf(field) === true,
									onChange: (e) => setField(field, e.target.checked),
								}),
								el("span", { className: "dcp-slider" }),
							)
							: el("input", {
								className: "dcp-input", type: field.type === "text" ? "text" : "number",
								step: field.type === "num" ? 0.05 : field.type === "int" ? 100 : void 0,
								disabled: !writable || saving,
								value: String(valueOf(field)),
								onChange: (e) => setField(field, e.target.value),
							}),
						el("span", { className: "dcp-hint" }, hintFor(field)),
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
				el(PriceCalculator, { writable, saving, onApply: applyRecommendation }),
			);
		}
		/**
		 * 成本计算器（面板下方）：输入三档单价 → 推荐阈值 + 结构诊断。
		 * 默认只计算（不写配置）；「一键填入并保存」按钮由用户显式点击才写入，
		 * 走 onApply → applyRecommendation → persist → writeField（命名空间 set + 回读校验），
		 * 与上方表单同一条持久化路径，故失败原因（未就绪/未持久化）提示完全一致。
		 */
		function PriceCalculator({ writable, saving, onApply }) {
			const [hit, setHit] = react.useState("0.02");
			const [miss, setMiss] = react.useState("1");
			const [out, setOut] = react.useState("4");
			const [unit, setUnit] = react.useState("¥");
			const [div, setDiv] = react.useState(1e6);
			const [active, setActive] = react.useState("ds-flash");
			const [applied, setApplied] = react.useState(void 0);
			const pick = (p) => { setHit(String(p.hit)); setMiss(String(p.miss)); setOut(String(p.out)); setUnit(p.unit || "¥"); setDiv(p.div || 1e6); setActive(p.id); setApplied(void 0); };
			const h = Number(hit), m = Number(miss), o = Number(out);
			const rec = Number.isFinite(h) && Number.isFinite(m) ? recommendFromPrice(h, m) : null;
			/** 单请求成本与结构占比（用于展示诊断，口径同 README §7.3） */
			let diag = null;
			if (rec) {
				const REF = 0.35 * 1_000_000;
				const g = CALC_CONST.growth;
				const ctxCost = (REF - g) * h;
				const newCost = g * m;
				const outCost = Number.isFinite(o) ? g * 0.35 * o : 0; // 输出按新增的 35% 粗估
				const total = ctxCost + newCost + outCost;
				diag = {
					ratio: rec.ratio, ctxShare: rec.ctxShare,
					ctxPct: Math.round(ctxCost / total * 100),
					newPct: Math.round(newCost / total * 100),
					perReq: total / (div || 1e6),
					unit,
				};
			}
			const numField = (label, val, set, hint) => el("div", { className: "dcp-row" },
				el("label", { className: "dcp-label", title: hint }, label),
				el("input", {
					className: "dcp-input dcp-calc-num", type: "number", step: "any", value: val,
					onChange: (e) => { set(e.target.value); setActive(""); setApplied(void 0); },
				}),
				el("span", { className: "dcp-hint" }, hint ?? ""),
			);
			return el("div", { className: "dcp-calc" },
				el("div", { className: "dcp-calc-title" }, "成本阈值计算器（参考值；点下方按钮可写入配置）"),
				el("div", { className: "dcp-presets" },
					PRICE_PRESETS.map((p) => el("button", {
						key: p.id, className: "dcp-preset", dataset: { active: active === p.id ? "1" : "0" },
						title: p.note, onClick: () => pick(p),
					}, p.label)),
				),
				numField("缓存命中价格", hit, setHit, "每 1M token（或积分系数/10000）；命中越便宜，阈值可越高"),
				numField("缓存未命中价格", miss, setMiss, "每 1M token：新增内容的单价，决定压缩摊销成本"),
				numField("输出价格", out, setOut, "每 1M token：仅用于估算摘要/输出的占比"),
				rec ? el("div", { className: "dcp-diag" },
					el("span", null, `命中:未命中 = 1:${rec.ratio.toFixed(1)}`),
					el("span", null, `上下文项占单请求 ${diag.ctxPct}%`),
					el("span", null, `估算单请求 ≈ ${diag.perReq < 0.01 ? diag.perReq.toFixed(5) : diag.perReq.toFixed(2)} ${diag.unit}`),
				) : el("div", { className: "dcp-hint" }, "请输入有效的正数价格。"),
				rec ? el("div", { className: "dcp-rec" },
					el("span", null, "推荐："),
					el("span", null, "智能压缩线 ", el("b", null, rec.markerMinRatio)),
					(() => {
						/* C-own：推荐强制线同样不得越过引擎上限——超出则按上限收敛并注明 */
						const cap = typeof NS.engineCap === "number" && Number.isFinite(NS.engineCap) && NS.engineCap > 0 && NS.engineCap <= 1 ? NS.engineCap : null;
						const eff = cap !== null && rec.criticalRatio > cap ? cap : rec.criticalRatio;
						return el("span", null,
							"强制压缩线 ", el("b", null, eff),
							eff < rec.criticalRatio ? el("span", { className: "dcp-hint" }, `（推荐值 ${rec.criticalRatio} 超引擎上限，按 ${eff} 生效）`) : null,
						);
					})(),
				) : null,
				rec ? el("div", { className: "dcp-hint" }, rec.verdict) : null,
				rec ? el("div", { className: "dcp-actions" },
					el("button", {
						className: "dcp-btn dcp-btn-primary",
						disabled: !writable || saving === true,
						title: writable ? "把上面三个推荐值写入配置并回读校验（可撤销：改回原值再保存）" : "设置命名空间未就绪，暂不可写入",
						onClick: async () => {
							setApplied(void 0);
							const r = await onApply(rec);
							setApplied(r);
						},
					}, saving === true ? "写入中…" : "一键填入并保存"),
					writable ? null : el("span", { className: "dcp-hint" }, "设置命名空间未就绪，当前只读。"),
					applied ? el("span", { className: applied.ok ? "dcp-msg-ok" : "dcp-msg-error", role: "status" }, applied.text) : null,
				) : null,
				el("div", { className: "dcp-hint" },
					"模型说明：压缩摊销成本 ≈ 新增内容 × 未命中价，与阈值几乎无关（摘要调用 ∝ 阈值，但压缩间隔也 ∝ 阈值，两者相消）——全部收益来自上下文规模。详见 README §7。"),
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
					/** 滑动开关：与面板 .dcp-switch 同一套官方样式（PANEL_CSS 全局注入，token 双主题自适配）。 */
					const wrap = document.createElement("label");
					wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;flex:none;";
					const box = document.createElement("span");
					box.className = "dcp-switch";
					const input = document.createElement("input");
					input.type = "checkbox";
					input.setAttribute("role", "switch");
					input.setAttribute("aria-label", "上下文领航总开关");
					const knob = document.createElement("span");
					knob.className = "dcp-slider";
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
					/* 行结构：line1 = 最近压缩（**按会话血统链过滤**，C-lineage）+徽章，line2 = 阈值速览（底部）。
					 * 记录易丢的根因（已证）：DSH 压缩会轮转 session id（实测一个会话连换 3 个 id），
					 * 仅按当前 id 过滤会在轮转后误判「无记录」；host getHud 现沿血统链回溯匹配。 */
					row.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:1px;padding:2px 12px 8px;text-align:center;";
					const line1 = document.createElement("div");
					line1.style.cssText = "display:flex;align-items:center;justify-content:center;gap:8px;";
					const label = document.createElement("span");
					label.style.cssText = "opacity:.72;white-space:nowrap;";
					const chips = document.createElement("span");
					chips.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex:none;";
					const thr = document.createElement("div");
					thr.style.cssText = "font-size:10px;letter-spacing:.2px;opacity:.55;white-space:nowrap;";
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
							/* 悬停 = 本会话（血统链）最近压缩列表 + 取证指纹 */
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
							/* 底部阈值速览：智能压缩线 / 强制压缩线（配置镜像实时跟随）+ 生效上限（C-own） */
							const pct = (x, d) => `${Math.round((Number.isFinite(Number(x)) ? Number(x) : d) * 100)}%`;
							const capTxt = typeof NS.engineCap === "number" ? `（上限 ${pct(NS.engineCap)}）` : "";
							thr.textContent = `智能压缩线 ${pct(v.markerMinRatio, 0.2)} ｜ 强制压缩线 ${pct(v.criticalRatio, 0.85)}${capTxt}`;
							/* 「距离触发还差多少」——弹窗已在顶部显示当前占用，这里补最有决策价值的一行：
							 * 距智能压缩线还有多少（达线后模型可自行决定压缩），以及是否已越线。 */
							const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
							const occ = num(v.occupancyRatio, null); // host 侧未提供时跳过（保持向后兼容）
							if (occ != null) {
								const smart = num(v.markerMinRatio, 0.2);
								const crit = num(v.criticalRatio, 0.85);
								const fmtK = (t) => (t >= 1000 ? `${(t / 1000).toFixed(0)}K` : String(Math.round(t)));
								let hint;
								if (occ >= crit) hint = "已达强制压缩线";
								else if (occ >= smart) hint = `已过智能压缩线（距强制线 ${fmtK(v.occupancyWindow * (crit - occ))}）`;
								else hint = `距智能压缩线 ${fmtK(v.occupancyWindow * (smart - occ))}`;
								thr.textContent += ` ｜ ${hint}`;
							}
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
								/* C-own：引擎阈值上限（host 动态探测，方案 C 钳制用）——存 NS 供保存路径读取 */
								if (typeof r.criticalCap === "number" && Number.isFinite(r.criticalCap) && r.criticalCap > 0 && r.criticalCap <= 1) {
									NS.engineCap = r.criticalCap;
								}
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
					line1.appendChild(label);
					line1.appendChild(chips);
					row.appendChild(line1);
					row.appendChild(thr);
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
