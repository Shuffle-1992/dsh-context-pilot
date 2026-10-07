/**
 * @local/dsh-context-pilot —— 宿主 face 描述符（exports["./typert"]）。
 *
 * 背景（2026-10-06 实证）：host→configEditor.edit 在插件上下文里恒被
 * 「HMR transactions cannot be nested」拒绝（面板能成是因为 client→remote 不经插件 apply scope）
 * ⇒ HUD 的 host→client 推送通道结构性不可用，改为 client 每 5s 轮询本面。
 *
 * face 契约 1 方法（与 client.js REMOTE_CONTRIBUTION.descriptors 逐字对账——
 * P29 教训：两端清单漂移 = 调用静默失败）：
 *  - getHud()：读 HUD 状态（最近压缩 / 武装灯 / 待执行 chip），内存为准，空位由启动回填自报告补。
 *
 * 形态照抄 @local/dsh-browser-kit 的 wire.host.mjs（本机已验证两条并存路径）：
 * A) dsh-typert-loader 自动发现：读包 exports["./typert"] → ctx.typert.register(TYPERT)；
 * B) typertGateway SRC 兜底：ctx.provide(FACE_NAME, face)（原型方法标记 + typertRemote 绑定）。
 */

/** 远端面服务名（客户端 ctx.remote.<名> 的命名空间，须与 TYPERT.namespace 一致）。 */
export const FACE_NAME = 'dshContextPilot';

/** 协议原型方法标记键（typertGateway collectSrcClaims 认领依据）。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** 透传校验器：face 的边界契约就是「JSON 可序列化」。 */
const JSON_ANY = Object.freeze({ parse: (value) => value });

/** face 方法面：[方法名, 参数名数组, 签名, 可选参数名数组]。 */
const FACE_METHOD_TABLE = [
  ['getHud', ['sid'], 'getHud(sid?): Promise<{ok:true, hudLastAct:string, hudArmed:string, hudPending:string, gen:string, acts:string[], hudLastActGlobal:string, actsGlobal:string[], sessionMatched:number, occupancyRatio:number|null, occupancyWindow:number|null, criticalCap:number, effort:{ok:boolean, provider?:string, model?:string, current:string|null, efforts:string[]|null, defaultEffort?:string|null, adapterDefault?:boolean}|null, at:string}|{ok:false, error}>（HUD 状态轮询；sid 可选=按会话过滤最近压缩，空=全局；effort 仅在智能思考开启时非 null）', ['sid']],
];

/**
 * 创建宿主 face。
 * @param {{ onGetHud: (sid?: string) => {ok: boolean, hudLastAct?: string, hudArmed?: string, hudPending?: string, gen?: string, acts?: string[], occupancyRatio?: number|null, occupancyWindow?: number|null, at?: string, error?: string} }} hooks
 */
export function createRemoteFace({ onGetHud }) {
  class RemoteFace {
    constructor() {
      this.typertRemote = Object.freeze({ service: this, serviceKey: FACE_NAME, namespace: FACE_NAME });
    }
    async #guard(fn) {
      try {
        return await fn();
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    }
    /** getHud(sid?) → HUD 状态快照（sid 可选=按会话过滤）。 */
    getHud(sid) { return this.#guard(() => onGetHud(sid)); }
  }

  Object.defineProperty(RemoteFace.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(FACE_METHOD_TABLE.map(([method]) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  });

  return new RemoteFace();
}

/** 宿主 face 模型描述符（dsh-typert-loader 自动发现并 ctx.typert.register）。 */
export const TYPERT = {
  package: '@local/dsh-context-pilot',
  face: 'host',
  generator: 'hand-written：无 zod/schemastery 依赖；strict codec 用透传校验器',
  service: FACE_NAME,
  schemas: [],
  invocations: FACE_METHOD_TABLE.map(([method, parameters, , optionals]) => ({
    id: `@local/dsh-context-pilot#${FACE_NAME}/${method}`,
    service: FACE_NAME,
    namespace: FACE_NAME,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({
      name,
      wire: name,
      source: 'json',
      ...(optionals.includes(name) ? { acceptsUndefined: true } : {}),
      codec: {
        mode: 'strict',
        typeSymbol: `@local/dsh-context-pilot#${FACE_NAME}/${method}:${name}`,
        create: () => JSON_ANY,
      },
    })),
    result: {
      mode: 'strict',
      typeSymbol: `@local/dsh-context-pilot#${FACE_NAME}/${method}:result`,
      create: () => JSON_ANY,
    },
  })),
  model: {
    services: [
      {
        description: 'dsh-context-pilot 远端面：HUD 状态轮询（getHud）。',
        summary: 'dsh-context-pilot HUD 的 client→host 轮询通道。',
        tags: [],
        key: FACE_NAME,
        exportName: 'createRemoteFace',
        members: FACE_METHOD_TABLE.map(([method, , signature]) => ({
          kind: 'method',
          name: method,
          signature,
        })),
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
};
