/**
 * MCSTS 插件 API（作者侧唯一需要的类型文件）
 *
 * 复制到你的插件目录里用：`import type { PluginContext } from './plugin-api.js'`
 * （或 .d.ts 直接放在旁边）。**不要**去 import MCSTS 的内部模块 —— 那是核心私有实现，
 * 版本之间会动，而这份契约只加不改不删。
 *
 * 责任边界：MCSTS 只提供接口；把某个插件装进站点是你的决定，你需要对自己的选择负责。
 * 插件在 MCSTS 进程内运行，本站**不提供**沙盒 —— 能 require('fs') 的代码关不住，
 * 假装能关住比说清楚更糟。
 *
 * 兼容性只看 PLUGIN_API_VERSION：不匹配时 MCSTS 直接拒载并说明原因。
 */

export declare const PLUGIN_API_VERSION: number;

export interface PluginRequirement {
  id: string;
  label: string;
  note?: string;
}

export interface PluginSettingSpec {
  key: string;
  type: 'string' | 'int' | 'bool' | 'secret';
  label: string;
  hint?: string;
  default?: string | number | boolean;
}

export interface PluginEndpointSpec {
  kind: 'router' | 'hooks';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: 'public' | 'user' | 'admin' | 'super' | 'hmac';
  note?: string;
  rateLimit?: { max: number; windowMs: number };
}

/** ============ 通用绑定页（账号设置区）============ */

/**
 * 绑定主体与（可选的）玩家输入声明：
 * - `subject='profile'`：每个角色一条绑定，页面给角色选择器，核心验属后把 profileId/profileName 交给插件；
 * - `subject='account'`：整个账号一条，插件收到的 profileId 恒为 null；
 * - `input`：声明了才允许插件登记 `claim()` —— 绑定页会出现一个输入框（如填 XUID），
 *   `pattern` 由**核心预校验**后才把值交给插件，插件收到的 value 一定合格式。
 */
export interface PluginBindingInput {
  label: string;
  hint?: string;
  /** 输入格式正则（如 "^[0-9]{6,21}$"）；核心在 claim 到达插件前用它挡掉不合格式的值 */
  pattern?: string;
  placeholder?: string;
}

export interface PluginBindingSpec {
  subject: 'account' | 'profile';
  input?: PluginBindingInput;
}

/** 核心完成会话鉴权与角色归属校验之后交给处理器的操作者 */
export interface PluginBindingActor {
  userId: string;
  profileId: string | null;
  /** profileId 对应角色的当前名字；subject='account' 时为 null */
  profileName: string | null;
  role: 'user' | 'admin' | 'super_admin';
  ip: string;
}

export interface PluginBindingField {
  label: string;
  value: string;
}

/** 绑定列表里的一行。id 是解绑句柄，必须在本插件内唯一（例如 XUID） */
export interface PluginBindingRow {
  id: string;
  /** 页面按声明顺序渲染的键值对 */
  fields: PluginBindingField[];
  /** ISO 时间，页面显示「何时绑定」 */
  boundAt?: string;
  /** 签发态标签：pending=等待远端确认（如玩家申请后还没进过服）；不填按 active 渲染 */
  status?: 'pending' | 'active';
}

export interface PluginBindingListResult {
  bindings: PluginBindingRow[];
  /** 给玩家的游戏内操作说明；页面会把其中的 {{code}} 替换成刚生成的码 */
  instructions?: string;
}

export interface PluginBindingIssueResult {
  /** 展示给玩家的短码。绑定类流程建议直接用 ctx.tokens.issue() 返回的 token */
  code: string;
  /** ISO 过期时间，页面据此做倒计时 */
  expiresAt: string;
}

export interface PluginBindingClaimResult {
  /** 原样显示给玩家的回执文案（作者语言，框架不翻译）；不填用页面的通用成功提示 */
  message?: string;
}

/**
 * 通用绑定页的处理函数集合，经 `ctx.binding()` 登记。
 *
 * 页面路由（/api/plugins/<id>/binding 一族）与发现目录都由核心提供，插件只登记行为；
 * 返回值形态由核心在运行时校验 —— 契约违背会明确报错，而不是渲染出半坏页面。
 */
export interface PluginBindingHandlers {
  list(actor: PluginBindingActor): PluginBindingListResult | Promise<PluginBindingListResult>;
  issue(actor: PluginBindingActor): PluginBindingIssueResult | Promise<PluginBindingIssueResult>;
  /** 不登记则页面不提供解绑按钮（有些绑定只许管理员清） */
  revoke?(actor: PluginBindingActor & { bindingId: string }): void | Promise<void>;
  /**
   * 玩家提交一个值发起申请（如网页侧填 XUID）。只有 manifest 声明了 `binding.input` 才允许登记；
   * value 已由核心按声明的 pattern 预校验。典型配对：远端服务器在**实测到该身份进服**时
   * 经 hooks 把它确认生效（status pending → active）—— 申请是意愿，进服是持有证明。
   */
  claim?(actor: PluginBindingActor & { value: string }): void | PluginBindingClaimResult | Promise<void | PluginBindingClaimResult>;
}

export interface PluginManifest {
  /** 小写字母开头，允许数字与下划线，长度 2-32；它同时是你的表前缀 */
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** 展示用（如 ">=2-26.3.8"）；MCSTS 不做版本比较，真正的闸门是 apiVersion */
  mcsts?: string;
  /** 相对插件目录的入口文件，如 'index.ts' */
  main: string;
  description?: string;
  author?: string;
  requires?: PluginRequirement[];
  settings?: PluginSettingSpec[];
  /** 你要暴露的 HTTP 入口。注册未声明的路径会被拒载 —— 声明与行为必须一致 */
  endpoints?: PluginEndpointSpec[];
  /**
   * 声明「这个插件要在账号设置区的通用绑定页出现」。
   * 没声明却调用 `ctx.binding()` → 拒载（与 endpoints 同一套「声明可核」逻辑）。
   */
  binding?: PluginBindingSpec;
}

export interface PluginRequest {
  method: string;
  /** manifest 里声明的那段路径（不含挂载前缀） */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  header(name: string): string | undefined;
  ip: string;
  user: {
    userId: string;
    profileId: string | null;
    role: 'user' | 'admin' | 'super_admin';
  } | null;
}

export interface PluginResponse {
  status(code: number): PluginResponse;
  setHeader(name: string, value: string | number): PluginResponse;
  json(body: unknown): void;
  send(body: string | Uint8Array): void;
}

export type PluginHandler = (req: PluginRequest, res: PluginResponse) => void | Promise<void>;

export interface PluginRouteOptions {
  method: PluginEndpointSpec['method'];
  path: string;
  auth: PluginEndpointSpec['auth'];
  rateLimit?: { max: number; windowMs: number };
}

export interface PluginDb {
  readonly dialect: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface PluginSettings {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** 读 secret 型设置的明文（已解密）；未设置返回 null。明文不会经面板下发 */
  getSecret(key: string): Promise<string | null>;
}

export interface PluginTokenRow {
  id: string;
  subject: string;
  data: Record<string, unknown>;
  expiresAt: string;
}

/**
 * 一次性令牌（绑定流程的核心原语）。
 *
 * 由框架提供而不是各写一份，是因为**消费必须原子**：「先查有没有用过再标记」是两个语句，
 * 用户双击或客户端预取就会并发命中同一枚。consume() 把判定全写进 UPDATE/DELETE 的 WHERE，
 * 靠数据库原子性定胜负。
 */
export interface PluginTokens {
  issue(input: {
    /** 归属键（例如角色 UUID）；TTL 上限 1 小时 */
    subject: string;
    ttlMs: number;
    data?: Record<string, unknown>;
  }): Promise<{ token: string; expiresAt: string }>;
  /** 无效 / 过期 / 已被消费一律返回 null，不区分原因（否则这里会变成探测器） */
  consume(token: string): Promise<PluginTokenRow | null>;
  purgeExpired(): Promise<number>;
}

export type PluginEventName =
  | 'user.registered'
  | 'profile.renamed'
  | 'profile.deleted'
  | 'account.purged';

export interface PluginEventPayloads {
  'user.registered': { userId: string; profileId: string; profileName: string };
  'profile.renamed': { userId: string; profileId: string; from: string; to: string };
  'profile.deleted': { userId: string; profileId: string; name: string };
  'account.purged': { userId: string; profileIds: string[] };
}

export interface PluginEvents {
  on<K extends PluginEventName>(
    name: K,
    handler: (payload: PluginEventPayloads[K]) => void | Promise<void>,
  ): void;
}

export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface PluginSite {
  siteTitle(): Promise<string>;
  publicOrigin(): Promise<string>;
  /**
   * 站点 Yggdrasil RSA **公钥**（PEM）。用途：伴生插件把玩家带来的 textures property
   * 发回来验签 —— 只有本站私钥签得出的签名才过，等于「验签证是否真实存在」。
   * 只给公钥；私钥永远不经插件 API 出手。站点尚未生成密钥时返回 null。
   */
  publicKeyPem(): Promise<string | null>;
}

export interface PluginContext {
  readonly pluginId: string;
  /** ctx.table('bindings') → 'plugin_<你的id>_bindings'（表名片段只允许小写下划线） */
  table(name: string): string;
  db: PluginDb;
  settings: PluginSettings;
  tokens: PluginTokens;
  events: PluginEvents;
  site: PluginSite;
  logger: PluginLogger;
  /** 网页侧入口：挂在 /api/plugins/<id><path>，鉴权复用站点会话 */
  route(options: PluginRouteOptions, handler: PluginHandler): void;
  /**
   * 机器回调入口：挂在 /api/plugins/<id>/hooks<path>。
   *
   * auth:'hmac' 时 MCSTS 会校验三个头（X-MCSTS-Timestamp / -Nonce / -Signature），
   * 密钥是管理面板为**你的插件**生成的那把（存在 `HOOK_SECRET`，用 getSecret 读）。
   * 签名串：HMAC-SHA256(secret, ts + "\n" + nonce + "\n" + METHOD + "\n" + 完整路径 + "\n" + sha256hex(body))
   */
  hook(options: PluginRouteOptions, handler: PluginHandler): void;
  /**
   * 接入账号设置区的通用绑定页；manifest 必须先声明 `binding`，否则拒载。
   * 一个插件只能登记一次；`revoke` 不登记就没有解绑按钮。
   */
  binding(handlers: PluginBindingHandlers): void;
}

/** setup 返回的清理函数：插件被停用时调用 */
export type PluginDispose = () => void | Promise<void>;

/**
 * 你的入口文件的默认导出（或具名导出 setup）。
 * 同步返回 dispose、或 await 完初始化再返回都合法；返回的函数在插件被停用时调用。
 */
export type PluginSetup = (
  ctx: PluginContext,
) => PluginDispose | void | Promise<PluginDispose | void>;
