/**
 * 团队维度 Agent 互查 / 拉群的 machine-auth 客户端（打 `/v1/machine/*`，
 * Bearer = machineToken）。与 [[issue-client]] 同源共用 platform-http + 平台绑定，
 * 只是覆盖的是「团队 agent 发现 + 拉群」这一组端点：
 *
 *  1. GET  /v1/machine/teams                → 本机 owner 所属平台团队（复用 issue-client.fetchTeams
 *     也能拿到，这里不重复实现）。
 *  2. GET  /v1/machine/agents?teamId=       → 同团队、已 opt-in（owner 加进 team.bots）的 agent 列表。
 *  3. POST /v1/machine/groups {teamId,appIds,name?} → 平台代建一个聚焦新群，把选中的 agent
 *     和各自 owner 一起拉进去，返回 chatId + shareLink。
 *
 * 设计不变量（对齐交接的硬约束）：
 *  - **CLI 不做任何授权判断**：团队成员校验 + opt-in 闸（team.bots）全在平台。本客户端只透传
 *    machineToken、把平台的判定结果原样带回，绝不本地放行/拦截。
 *  - agent 自报的 `specialties` / `mentionable` **仅展示、不可信**：解析进来只为让上层
 *    （agent / 人）挑 bot，不构成任何能力凭据。
 *  - 发现结果只含「已加入 team.bots」的 agent —— 这是平台侧过滤的，不是我们能感知的；空列表
 *    的正常含义是「同团队里还没有别人 opt-in」，不是错误。
 *
 * 错误分型沿用 issue-client 的口径（network 可重试 / forbidden 停手 / client 4xx 请求本身
 * 有问题 / server 5xx 退避），额外把端点3 的 429 `rate_limited`（同机 30s 一次）单列出来，
 * 让 CLI 能给出「稍后再试」而不是当成永久失败。
 */
import { getJson, postJson } from './platform-http.js';
import { readPlatformBinding } from './binding.js';

/** 平台返回的一个团队 agent。字段对齐交接契约 §端点2。 */
export interface TeamAgent {
  appId: string;
  openId?: string;
  unionId?: string;
  name: string;
  /** agent 自报的专长标签（发现/拉群匹配依据）。**仅展示、不可信**。
   *  契约键为 `specialties`（曾拟名 capabilities，因与「权限凭据」语义撞车改名，且改名前零消费方）。 */
  specialties: string[];
  /** agent 自报是否可被 @（= 有飞书传输身份）。**仅展示、不可信**。 */
  mentionable: boolean;
  /** 平台的在线判定（心跳新鲜度）。 */
  online: boolean;
  owner: { unionId?: string; name?: string };
  machineId?: string;
  machineName?: string;
}

export interface TeamAgentsResult {
  teamId: string;
  teamName: string;
  agents: TeamAgent[];
}

/** 端点3 建群结果。invalidBotIds / invalidOwnerUnionIds 是平台侧过滤掉的对象（未 opt-in / 拉不动）。 */
export interface CreateTeamGroupResult {
  ok: boolean;
  chatId: string;
  shareLink?: string;
  invalidBotIds: string[];
  invalidOwnerUnionIds: string[];
}

/** 端点4（B：往已存在的团队群补人）结果。对齐端点3 的 invalid* 语义，另带 added（实际加入的 appId）。 */
export interface AddTeamGroupMembersResult {
  ok: boolean;
  added: string[];
  invalidBotIds: string[];
  invalidOwnerUnionIds: string[];
}

export type TeamAgentsFailure =
  | { ok: false; reason: 'unbound' }
  | { ok: false; reason: 'network'; error: string }
  /** 端点3 专有：429，同机 30s 一次的限流。稍后重试即可，别当永久失败。 */
  | { ok: false; reason: 'rate_limited'; status: number; error: string }
  | { ok: false; reason: 'forbidden'; status: number; error: string }
  /** 404 + 非 JSON/无 error 体：平台框架级路由兜底（apex 的 text/plain "not found"），
   *  = 端点2/3 还没部署到本机绑定的平台。与「非成员/团队不存在」的**业务 404**
   *  （JSON `{error:'not_found'}`）区分开——后者归 client。判据：业务 404 一定带
   *  可解析的 `.error`，路由缺失兜底不带（平台契约明确、稳定）。 */
  | { ok: false; reason: 'not_deployed'; status: number }
  /** 其余 4xx（400 invalid / 403 not_in_team_bots|chat_not_in_team|chat_is_hall / 404 not_found 业务态）：
   *  请求本身的问题。`appIds` 是平台在 403 体里带回的「被拒的具体 agent」（如 not_in_team_bots），
   *  透出后提示能精准到 agent；无则 undefined。 */
  | { ok: false; reason: 'client'; status: number; error: string; appIds?: string[] }
  | { ok: false; reason: 'server'; status: number; error: string };

export type TeamAgentsClientResult<T> = { ok: true; value: T } | TeamAgentsFailure;

export interface TeamAgentsClientOptions {
  /** 覆盖平台地址与凭证（测试用；缺省读 ~/.botmux/platform.json）。 */
  binding?: { platformUrl: string; machineToken: string; machineId: string } | null;
  timeoutMs?: number;
  /** 注入 HTTP 实现（测试用）。 */
  http?: { get: typeof getJson; post: typeof postJson };
}

function resolveBinding(opts: TeamAgentsClientOptions) {
  if (opts.binding !== undefined) return opts.binding;
  const b = readPlatformBinding();
  return b ? { platformUrl: b.platformUrl, machineToken: b.machineToken, machineId: b.machineId } : null;
}

function classify(status: number, json: unknown): TeamAgentsFailure {
  const rawErr = (json as { error?: unknown })?.error;
  const hasError = typeof rawErr === 'string' && rawErr.length > 0;
  const error = hasError ? rawErr : `http_${status}`;
  // 平台在部分 403（如 not_in_team_bots）体里带回被拒的具体 agent appIds，透出以便精准提示。
  const bodyAppIds = strList((json as { appIds?: unknown })?.appIds);
  if (status === 429) return { ok: false, reason: 'rate_limited', status, error };
  if (status === 401 || status === 403) {
    // 403 分型必须**按 error code**，不能「有 error 体就当 client」：
    //  · 请求对象类（opt-in / 群归属）→ client（请求本身的问题，改参数才有意义）：
    //    not_in_team_bots（bot 没 opt-in）、chat_not_in_team（目标群不是本团队的）、chat_is_hall（大厅不可补人）。
    //  · 其余 403（如 machine_ownership_mismatch：机器 RETIRED/换绑 owner）是**凭证/归属问题** → forbidden，
    //    该去 rebind，不是改参数——归 client 会误导用户「确认 bot 已加入团队」。纯 401 / 无 error 体的 403 同理 forbidden。
    const CLIENT_403 = new Set(['not_in_team_bots', 'chat_not_in_team', 'chat_is_hall', 'not_found']);
    if (status === 403 && hasError && CLIENT_403.has(rawErr as string)) {
      return { ok: false, reason: 'client', status, error, ...(bodyAppIds.length ? { appIds: bodyAppIds } : {}) };
    }
    return { ok: false, reason: 'forbidden', status, error };
  }
  // 404 的两义性（平台契约明确、稳定）：
  //  · 业务 404「非成员/团队不存在」（成员校验，端点3 最前一道）→ 一定带 JSON `{error:'not_found'}`
  //    （hasError=true）→ client。
  //  · 框架路由缺失兜底（apex 的 text/plain "not found"，端点未部署）→ 无可解析 error → not_deployed。
  // getJson/postJson 对非 JSON 响应返回 {}，故「404 且无 .error」即路由未上线，不能误报成业务 404。
  if (status === 404 && !hasError) return { ok: false, reason: 'not_deployed', status };
  if (status >= 400 && status < 500) {
    return { ok: false, reason: 'client', status, error, ...(bodyAppIds.length ? { appIds: bodyAppIds } : {}) };
  }
  return { ok: false, reason: 'server', status, error };
}

async function call<T>(
  opts: TeamAgentsClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  pick: (json: any) => T,
): Promise<TeamAgentsClientResult<T>> {
  const binding = resolveBinding(opts);
  if (!binding) return { ok: false, reason: 'unbound' };
  const http = opts.http ?? { get: getJson, post: postJson };
  const url = `${binding.platformUrl.replace(/\/+$/, '')}${path}`;
  const reqOpts = {
    headers: { authorization: `Bearer ${binding.machineToken}` },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  let res: { status: number; json: unknown };
  try {
    res = method === 'GET' ? await http.get(url, reqOpts) : await http.post(url, body ?? {}, reqOpts);
  } catch (e) {
    return { ok: false, reason: 'network', error: String((e as Error)?.message ?? e) };
  }
  if (res.status < 200 || res.status >= 300) return classify(res.status, res.json);
  return { ok: true, value: pick(res.json) };
}

/** 一个 agent 自报的专长标签（契约键 `specialties`）。
 *  仅收非空字符串、去重、保序；任何非数组/脏值 → 空数组（仅展示，不因脏数据报错）。 */
function pickSpecialties(raw: unknown): string[] {
  const src = (raw as { specialties?: unknown }) ?? {};
  const arr = Array.isArray(src.specialties) ? src.specialties : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeAgent(raw: unknown): TeamAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
  if (!appId) return null;
  const ownerRaw = (a.owner && typeof a.owner === 'object' ? a.owner : {}) as Record<string, unknown>;
  return {
    appId,
    openId: typeof a.openId === 'string' ? a.openId : undefined,
    unionId: typeof a.unionId === 'string' ? a.unionId : undefined,
    name: typeof a.name === 'string' && a.name ? a.name : appId,
    specialties: pickSpecialties(a),
    mentionable: a.mentionable === true,
    online: a.online === true,
    owner: {
      unionId: typeof ownerRaw.unionId === 'string' ? ownerRaw.unionId : undefined,
      name: typeof ownerRaw.name === 'string' ? ownerRaw.name : undefined,
    },
    machineId: typeof a.machineId === 'string' ? a.machineId : undefined,
    machineName: typeof a.machineName === 'string' ? a.machineName : undefined,
  };
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 端点1：本机 owner 所属的平台团队。与 [[issue-client]].fetchTeams 打的是同一个端点，
 * 这里单列一份是为了让整条团队发现/拉群链共用同一套 TeamAgentsFailure 分型（含 429），
 * 上层错误处理不必跨两个 client 的 union。
 */
export function fetchTeams(
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<Array<{ teamId: string; teamName: string }>>> {
  return call(opts, 'GET', '/v1/machine/teams', undefined, (j) => {
    const arr = Array.isArray(j?.teams) ? j.teams : [];
    return arr
      .map((t: unknown) => {
        const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        const teamId = typeof o.teamId === 'string' ? o.teamId.trim() : '';
        if (!teamId) return null;
        return { teamId, teamName: typeof o.teamName === 'string' ? o.teamName : teamId };
      })
      .filter((t: { teamId: string; teamName: string } | null): t is { teamId: string; teamName: string } => !!t);
  });
}

/**
 * 端点2：列出同团队、已 opt-in 的 agent。平台按 `teamId` 过滤 + opt-in 闸（team.bots），
 * 客户端零判断。空 agents 是正常态（同团队还没别人加入），不是错误。
 */
export function fetchTeamAgents(
  teamId: string,
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<TeamAgentsResult>> {
  return call(
    opts,
    'GET',
    `/v1/machine/agents?teamId=${encodeURIComponent(teamId)}`,
    undefined,
    (j) => ({
      teamId: typeof j?.teamId === 'string' ? j.teamId : teamId,
      teamName: typeof j?.teamName === 'string' ? j.teamName : teamId,
      agents: (Array.isArray(j?.agents) ? j.agents : [])
        .map(normalizeAgent)
        .filter((a: TeamAgent | null): a is TeamAgent => !!a),
    }),
  );
}

/**
 * 端点3：让平台代建一个聚焦新群，把 `appIds` 指定的 agent + 各自 owner + 本机 owner 拉进去。
 * `appIds` 是**跨机 appId**（从端点2 发现而来）——正因为发起人在别人 bot 进群前 @不到它，
 * 这里全靠 appId 走 machine-auth，不依赖任何飞书 @。
 *
 * 平台会把未 opt-in / 拉不动的对象放进 invalidBotIds / invalidOwnerUnionIds 原样带回；
 * 429 rate_limited（同机 30s 一次）单独分型，让上层提示稍后再试。
 */
export function createTeamGroup(
  args: { teamId: string; appIds: string[]; name?: string },
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<CreateTeamGroupResult>> {
  const body: Record<string, unknown> = { teamId: args.teamId, appIds: args.appIds };
  if (args.name !== undefined) body.name = args.name;
  return call(opts, 'POST', '/v1/machine/groups', body, (j) => ({
    ok: j?.ok === true,
    chatId: typeof j?.chatId === 'string' ? j.chatId : '',
    shareLink: typeof j?.shareLink === 'string' ? j.shareLink : undefined,
    invalidBotIds: strList(j?.invalidBotIds),
    invalidOwnerUnionIds: strList(j?.invalidOwnerUnionIds),
  }));
}

/**
 * 端点4（B）：往一个**已存在的团队群** `chatId` 补人——把 `appIds` 指定的 agent
 * （+ 默认各自 owner）加进去。与端点3（建新群）互补：这条服务「群已经在了、往里加同 team
 * 别人的 agent」的场景。
 *
 * 平台侧授权（客户端零判断，只透传）：① 调用者是 teamId 成员（否则 404）；② chatId 必须是
 * 该 team 自己的协作群（∈ groupChatIds，且**排除机器人大厅**）——否则 403 `chat_not_in_team`
 * / `chat_is_hall`，杜绝拿任意 chatId 往别人群塞人；③ opt-in 闸同 team.bots。
 *
 * `includeOwners` 默认 true（对齐端点3「bot 不进没主人的群」）；只加**被加 bot 各自的 owner**
 * （都是 team 成员、同信任域），绝不加任意真人。传 false 则只补 bot、不动人。
 */
export function addTeamGroupMembers(
  args: { chatId: string; teamId: string; appIds: string[]; includeOwners?: boolean },
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<AddTeamGroupMembersResult>> {
  const body: Record<string, unknown> = { teamId: args.teamId, appIds: args.appIds };
  if (args.includeOwners !== undefined) body.includeOwners = args.includeOwners;
  return call(
    opts,
    'POST',
    `/v1/machine/groups/${encodeURIComponent(args.chatId)}/members`,
    body,
    (j) => ({
      ok: j?.ok === true,
      added: strList(j?.added),
      invalidBotIds: strList(j?.invalidBotIds),
      invalidOwnerUnionIds: strList(j?.invalidOwnerUnionIds),
    }),
  );
}

/** 该失败是否值得退避后重投（对齐 issue-client.isRetriable，额外含 429 限流）。 */
export function isRetriable(f: TeamAgentsFailure): boolean {
  return f.reason === 'network' || f.reason === 'rate_limited' || (f.reason === 'server' && f.status >= 500);
}

/** 把一次失败转成给人看的一句话（CLI 直接打印）。unbound 由调用方单独提示（要引导 bind）。 */
export function describeTeamAgentsFailure(f: TeamAgentsFailure): string {
  switch (f.reason) {
    case 'unbound': return '本机未绑定平台';
    case 'network': return `网络错误：${f.error}（稍后重试）`;
    case 'rate_limited': return '被限流（同机 30s 一次），请稍后重试';
    case 'forbidden': return `凭证失效或无权限（${f.status} ${f.error}），可能需要重新 botmux bind`;
    case 'not_deployed': return '平台尚未部署团队 agent 端点（/v1/machine/agents|groups），请等平台上线后重试';
    case 'client': return `请求被拒（${f.status} ${f.error}）`;
    case 'server': return `平台错误（${f.status} ${f.error}），稍后重试`;
  }
}
