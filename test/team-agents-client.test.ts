/**
 * 团队维度 Agent 互查 / 拉群的 machine-auth 客户端。
 * Run: pnpm vitest run test/team-agents-client.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  fetchTeamAgents,
  fetchTeams,
  createTeamGroup,
  isRetriable,
  describeTeamAgentsFailure,
  type TeamAgentsClientOptions,
} from '../src/platform/team-agents-client.js';

const BINDING = {
  platformUrl: 'https://platform.example',
  machineToken: 'mt-secret',
  machineId: 'm-1',
};

function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
  let i = 0;
  const next = () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
  return {
    calls,
    http: {
      get: ((url: string, opts: any) => { calls.push({ method: 'GET', url, headers: opts?.headers }); return next(); }) as any,
      post: ((url: string, body: unknown, opts: any) => { calls.push({ method: 'POST', url, body, headers: opts?.headers }); return next(); }) as any,
    },
  };
}

function opts(responses: Array<{ status: number; json: unknown } | Error>): {
  o: TeamAgentsClientOptions;
  calls: ReturnType<typeof fakeHttp>['calls'];
} {
  const f = fakeHttp(responses);
  return { o: { binding: BINDING, http: f.http }, calls: f.calls };
}

describe('fetchTeams（端点1）', () => {
  it('带 Bearer，正常解析 teams', async () => {
    const { o, calls } = opts([{ status: 200, json: { teams: [{ teamId: 't1', teamName: 'One' }, { teamId: 't2', teamName: 'Two' }] } }]);
    const r = await fetchTeams(o);
    expect(r).toEqual({ ok: true, value: [{ teamId: 't1', teamName: 'One' }, { teamId: 't2', teamName: 'Two' }] });
    expect(calls[0].url).toBe('https://platform.example/v1/machine/teams');
    expect(calls[0].headers?.authorization).toBe('Bearer mt-secret');
  });

  it('丢弃无 teamId 的脏项，teamName 缺省回落到 teamId', async () => {
    const { o } = opts([{ status: 200, json: { teams: [{ teamName: '没id' }, { teamId: 't3' }] } }]);
    const r = await fetchTeams(o);
    expect(r).toEqual({ ok: true, value: [{ teamId: 't3', teamName: 't3' }] });
  });

  it('unbound 时不发请求', async () => {
    const f = fakeHttp([{ status: 200, json: {} }]);
    const r = await fetchTeams({ binding: null, http: f.http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('describeTeamAgentsFailure', () => {
  it('每种 reason 都给一句人话', () => {
    expect(describeTeamAgentsFailure({ ok: false, reason: 'unbound' })).toContain('未绑定');
    expect(describeTeamAgentsFailure({ ok: false, reason: 'rate_limited', status: 429, error: 'rate_limited' })).toContain('限流');
    expect(describeTeamAgentsFailure({ ok: false, reason: 'forbidden', status: 401, error: 'x' })).toContain('bind');
    expect(describeTeamAgentsFailure({ ok: false, reason: 'client', status: 403, error: 'not_in_team_bots' })).toContain('not_in_team_bots');
  });
});

describe('未绑定平台', () => {
  it('所有调用直接 unbound，不发任何请求', async () => {
    const f = fakeHttp([{ status: 200, json: {} }]);
    const r = await fetchTeamAgents('t1', { binding: null, http: f.http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('fetchTeamAgents（端点2）', () => {
  it('带 Bearer + teamId query，normalize agent 字段', async () => {
    const { o, calls } = opts([{
      status: 200,
      json: {
        teamId: 't1', teamName: 'Team One',
        agents: [{
          appId: 'cli_a', openId: 'ou_a', unionId: 'on_a', name: 'A',
          specialties: ['backend', 'pr-review'], mentionable: true, online: true,
          owner: { unionId: 'on_owner', name: 'Owner' }, machineId: 'm-2', machineName: 'box2',
        }],
      },
    }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0].url).toBe('https://platform.example/v1/machine/agents?teamId=t1');
    expect(calls[0].headers?.authorization).toBe('Bearer mt-secret');
    expect(r.value.teamName).toBe('Team One');
    expect(r.value.agents[0]).toMatchObject({
      appId: 'cli_a', name: 'A', specialties: ['backend', 'pr-review'],
      mentionable: true, online: true, owner: { unionId: 'on_owner', name: 'Owner' },
    });
  });

  it('空 agents 是正常态，不报错', async () => {
    const { o } = opts([{ status: 200, json: { teamId: 't1', teamName: 'T', agents: [] } }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r).toEqual({ ok: true, value: { teamId: 't1', teamName: 'T', agents: [] } });
  });

  it('丢弃无 appId 的脏 agent，坏 specialties → 空数组', async () => {
    const { o } = opts([{
      status: 200,
      json: {
        teamId: 't1', teamName: 'T',
        agents: [
          { name: '没有 appId' },                                    // 丢弃
          { appId: 'cli_b', name: 'B', specialties: 'not-array' },   // specialties → []
          { appId: 'cli_c', name: 'C', specialties: ['x', 'x', 42, ''] }, // 去重去脏
        ],
      },
    }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.agents.map(a => a.appId)).toEqual(['cli_b', 'cli_c']);
    expect(r.value.agents[0].specialties).toEqual([]);
    expect(r.value.agents[1].specialties).toEqual(['x']);
  });

  it('mentionable/online 缺省保守为 false', async () => {
    const { o } = opts([{ status: 200, json: { teamId: 't1', teamName: 'T', agents: [{ appId: 'cli_a', name: 'A' }] } }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.agents[0].mentionable).toBe(false);
    expect(r.value.agents[0].online).toBe(false);
    expect(r.value.agents[0].specialties).toEqual([]);
  });

  it('404 非成员/团队不存在（业务态，带 JSON error）→ client（不重试）', async () => {
    const { o } = opts([{ status: 404, json: { error: 'not_found' } }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 404, error: 'not_found' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('404 纯文本兜底（无 error，路由未部署）→ not_deployed，与"非成员"区分', async () => {
    // getJson/postJson 对纯文本响应返回 {} → 无 .error → 端点未部署。
    const { o } = opts([{ status: 404, json: {} }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r).toMatchObject({ ok: false, reason: 'not_deployed', status: 404 });
    expect(isRetriable(r as any)).toBe(false);
  });
});

describe('createTeamGroup（端点3）', () => {
  it('POST body 带 teamId+appIds(+name)，回 chatId/shareLink/invalid*', async () => {
    const { o, calls } = opts([{
      status: 200,
      json: { ok: true, chatId: 'oc_1', shareLink: 'https://l/x', invalidBotIds: ['cli_z'], invalidOwnerUnionIds: [] },
    }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a', 'cli_b'], name: '小群' }, o);
    expect(r).toEqual({
      ok: true,
      value: { ok: true, chatId: 'oc_1', shareLink: 'https://l/x', invalidBotIds: ['cli_z'], invalidOwnerUnionIds: [] },
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://platform.example/v1/machine/groups');
    expect(calls[0].body).toEqual({ teamId: 't1', appIds: ['cli_a', 'cli_b'], name: '小群' });
  });

  it('不传 name 时 body 不含 name 键', async () => {
    const { o, calls } = opts([{ status: 200, json: { ok: true, chatId: 'oc_1' } }]);
    await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(calls[0].body).toEqual({ teamId: 't1', appIds: ['cli_a'] });
  });

  it('403 not_in_team_bots（带 error 体）→ client，不重试', async () => {
    const { o } = opts([{ status: 403, json: { error: 'not_in_team_bots' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'not_in_team_bots' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('429 rate_limited（同机 30s 一次）→ 单独分型且可重试', async () => {
    const { o } = opts([{ status: 429, json: { error: 'rate_limited' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited', status: 429 });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('分型只看当次 status：一个非 opt-in 请求也可能拿 429（不是恒定 403）', async () => {
    // 平台端点3 检查顺序 404→429→403，限流器只在真正建群那步 arm。合法请求 arm 了 30s 窗后，
    // 紧接着的非 opt-in 请求会先撞 429、而非 403。所以「非法请求恒 403」不成立——分型按当次
    // status 判即可。这条守住不把「同参数重发结果恒定」写进逻辑。
    const first = opts([{ status: 200, json: { ok: true, chatId: 'oc_1' } }]);
    expect((await createTeamGroup({ teamId: 't1', appIds: ['cli_ok'] }, first.o)).ok).toBe(true);
    // 同一个非 opt-in 参数，平台这次因限流回 429（而非 403）——客户端如实分型成 rate_limited。
    const second = opts([{ status: 429, json: { error: 'rate_limited' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_not_optin'] }, second.o);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited', status: 429 });
  });

  it('503 → server，可重试', async () => {
    const { o } = opts([{ status: 503, json: {} }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'server', status: 503 });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('纯 401 → forbidden，停手不重试', async () => {
    const { o } = opts([{ status: 401, json: {} }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'forbidden', status: 401 });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('网络异常 → network，可重试', async () => {
    const { o } = opts([new Error('ECONNREFUSED')]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(isRetriable(r as any)).toBe(true);
  });
});
