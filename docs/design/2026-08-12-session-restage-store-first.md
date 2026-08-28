---
title: Session 架构拆解回收与 store-first 重新分步
type: design
date: 2026-08-12
updated: 2026-08-28（Step 3 第一 PR 已合入 master；第二 PR = JSON 净删除 + Step 4(a) 事务化，见「执行结果（2026-08-28）」）
topic: session-restage-store-first
status: proposed
baseline: origin/master@cc5085b6（0828 复核基线，含已合入的 #852；0828 早先基线 0265234d；0827 复核基线 06db2b48；0820 复核基线 3d84aaad；0819 复核基线 47b2c11a；0813 复核基线 16fde8a27；原始基线 723c79ade）
references:
  - feat/virtual_actor_stage2@b6a4982ea（不合入；仅作参考实现、竞态清单与写点地图）
  - docs/design/2026-08-08-virtual-actor-session-runtime.md（原始提案；本目录保留未跟踪副本）
  - PR #846（Step 1+2 产出）
  - PR #852（Step 3 第一 PR：引擎替换 + 导入 + 混合窗口；**已合入 master**）
  - Step 3 第二 PR：JSON 引擎净删除（db-only）+ Step 4(a) 事务化，兑现原则 1
---

# Session 架构拆解回收与 store-first 重新分步

> 本文取代 stage2 分支上的 `2026-08-11-session-actor-core-implementation.md` 成为
> 后续实施的唯一口径。原 0811 文档随其分支一并归档，不再维护。
>
> **2026-08-13 修订**：Step 1 执行后发现 7 项候选中 6 项的「缺陷」是 stage2
> runtime 分层自身引入的回归（master 无此缺陷或机制仍活），只有 1 项在 master
> 真实存在。这暴露了原计划的一个方法论缺陷：**Step 1 的候选清单直接采信了
> stage2 的修复记录，而 stage2 的修复大多是在收拾迁移自己造成的回归**（§0 的
> 「fix(session) 15 个」判断在候选粒度上再次得到证实）。据此本次修订：
> ① 记录 Step 1 实际产出与逐项处置；② **以 master 为唯一证据源重新核实
> Step 2/3/4 的全部前提**——核实结论是三步全部成立，且 Step 3 的收益比原文
> 写的更大，但两处前提表述需要修正（见各节【master 复核】）。
>
> **2026-08-19 修订**：#831 / virtual-actor 仍不合入；现行范式是 store-first，
> 不是把 actor 缝隙再包一层。Step 3 第一 PR（#852）rebase 到
> `origin/master@47b2c11a` 后复核：引擎替换与行级写的收益成立，但原文收益
> 第 1 条（「仲裁不再依赖 findDaemon-TOCTOU」）过满——SQLite 只排序写者，
> daemon 在位探测仍必须保留；净删除未在本 PR 兑现（JSON 机器仍在，留给灰度
> 稳定后的第二 PR）。0813 之后 master 还叠了 Remote lineage 改名、Mojo close
> journal、`SessionStoreUnavailableError` 写门，Step 3 必须带着这些 API 一起
> 换引擎，不能只按 0813 的 JSON store 形状施工。
>
> **2026-08-20 修订**：#852 再 rebase 到 `origin/master@3d84aaad`。#846 的
> 唯一门仍然健壮：src 无会话行直写绕过，CLI 只委托 `loadAllSessionsSnapshot` /
> `mutateSessionRowOffline`，provenance 仍走 `readSessionRowCopiesAcrossStores`。
> 0819 之后 master 新增的 Workbench `previewTarget` 在 close/resume 路径上清除，
> 已语义化并进本 PR 的 `persistRow`。收益判定不变；原则 1 仍待第二 PR 净删除。
> 同日补记：残余 `findDaemon` probe-vs-publish TOCTOU 的消法是 **store 内占位
> 租约**（与行写同一 `BEGIN IMMEDIATE`），不是 virtual actor / SessionRuntime；
> 见 Step 4 候选 (f)。本 PR 不实施。
>
> **2026-08-27 修订**：#852 再 rebase 到 `origin/master@06db2b48`。master 在
> 0820 之后把运行时切到 bun 单二进制，并把所有 SQLite 打开收进
> `sqlite-compat`（Node: `node:sqlite` / Bun: `bun:sqlite`，见 `005ce0ae`）。
> 会话库若仍 `createRequire('node:sqlite')`，会在编译态把 Step 3 硬门打成假
> 失败——这是「干净 rebase 不是正确 rebase」（traex-transcript 已写过的
> 同一类合并坑）。本 PR 改走 compat：引擎缺失抛 `SessionStoreSqliteUnavailableError`；
> 损坏 `.db` 仍是普通打开失败，扫描可 skip。`engines` 跟 master 的 `node: >=22`，
> 真门仍是 daemon `assertSqliteSupported()`。原则 1–5 与 Step 2 唯一门、混合窗口
> `owner: false`、`abortIf`+`findDaemon`、非目标（不回流 actor / 不卷旁路 store）
> 均未被后续 master 提交破坏；#889 `/cli`、#1017 发信人、#1008 schedule、#946
> pending-turn journal 要么走 store 字段、要么是设计允许的旁路文件。

## 0. 背景与决策

对 feat/virtual_actor_stage2（含第一、二阶段全部工作，37 个分支独有提交）以
origin/master 为基线的综合评估结论：

- 会话态 1,408 个 mutation 中仅 453（32%）收进 SessionRuntime 缝隙，910（65%）仍直写；
  最大写面（worker-pool 530、daemon 221、session-manager 135）未动。
- 零个 src 文件被删除，legacy 公共文件体量持平——新层是包上去的，不是换出来的。
  （补充精确化：`session-store.ts` 在 stage2 上从 832 行**增长到 1,387 行**——
  在 JSON 全量文件之上叠了一套 owner-bound typed-transition + readback 的平行
  API，旧 API 原封保留。这正是本计划要反着做的事。）
- 过渡资产（`current-*` 适配层 17k 行 src + 26k 行绑定测试）按设计将来整体报废；
  审计脚手架 23k 行挂在 build gate 上，master 每合入一个碰会话态的 PR 都要人工入册。
- 37 个提交中 fix(session) 15 个（多为迁移自身回归的收束）；identity 子系统经历完整
  的「建成—修复—拆除」往返。
- 结论：按调用方群组横切的 staging 使共存面不随进度收窄、收益全部递延到 Target-B，
  中间态负担大于收益。**决策：#831 不合入，拆解回收，按 store-first 重新分步。**

## 1. 分步原则（硬性判据）

1. **每一步合入后，系统必须比之前更简单，或至少删掉了东西。** 不满足即不立项。
2. **边界必须是结构性的**（interface / 唯一导出点，tsc 可执法）；禁止台账式纪律
   边界与随附的审计 gate。
3. **收益不许递延超过一步。** 任何「为了第 N+2 步铺路」的纯铺垫不单独成步。
4. 每一步是一个可独立发布、可独立回退的 PR；事务/串行化语义只在有实测竞态处
   逐个引入（ROI gate，I1 的教训）。
5. **（0813 新增）证据只认 master。** stage2 的修复记录、竞态清单、写点地图
   一律只当「去哪里看」的线索，不当「那里有问题」的证明——Step 1 的执行证明
   照抄会把 runtime 层自己的回归误判成 master 缺陷。任何一步立项前，其前提
   必须在 master 代码/实测上独立复核。

## 2. 步骤

### Step 1 — 独立修复摘取【已完成，PR #846】

以 stage2 实现为对照，逐条核实 7 项候选「能否脱离 runtime 层在 master 最小重做」。
**执行结论：6 项不成立，1 项重做落地。**

| 候选 | 处置 | 判定依据（均已在 master 代码上核实） |
|---|---|---|
| bot listing 热路径 | 无需重做 | master 所有 `getAvailableBots` 调用点本就只在 opening/initial 路径；每消息放大是 C1 切换自身回归（stage2 注释自证 "master parity"） |
| generation reconcile 单调判定 | 不适用 | 整行深比较 + 隔离台账只存在于 `current-session-executor-runtime.ts`；master `reserveWorkerGeneration` 写失败即回滚重抛（worker-pool.ts:10119），无永久封禁路径 |
| /close 竞态 VC reconcile 时序 | 不适用 | 竞态由 C1 把 exit 回调改 context-only + `findActiveBySessionId` 早退引入；master 回调闭包 `ds` 直调（daemon.ts:20743/20765），reconcile 不过守卫 |
| 幂等台账/executor slot 有界回收 | 不适用 | 被 cap 的 Map 全是 runtime 层新建物；master 对应物本已有界（`eventClaims` TTL+prune、`dispatchInputReceipts` cap 64、delivery/fence settle 即删） |
| 删 async tail-admission | **降级 Step 4 素材** | master 上是活代码：daemon.ts:18766/18825/19370 三个生产投递点仍在调用（见 Step 4 候选 d） |
| classify/gate 三份收敛 | 不适用 | 重复是 staging 自身制造；master gate 唯一定义（worker-pool.ts:6055），「孤儿 import」在 master 均为活引用 |
| ingress 终态失败回可行动提示 | **✅ 已重做** | master 真实缺陷：dispatcher 对两个消息入口只有 log-only catch，transport ACK 后异常 = 静默吞消息。PR #846（src +29/−2，回归测试 +273） |

**教训入库**：Step 1 比预期薄——这本身是对 §0「stage2 的 fix 多为迁移自身回归」
判断的正面验证，不动摇 store-first 决策；动摇的是「拿 stage2 记录当候选清单」
的做法，已固化为分步原则 5。

### Step 2 — 存储缝隙收口【已完成，并入 PR #846】

`services/session-store.ts` 已在 master 存在（832 行、18 个消费模块、全仓 119 处
`updateSession` 调用）。本步把它变成**唯一的门**：收编绕过它直接触碰会话行持久化
的路径，persistence 细节（文件布局、锁、tmp+rename）全部内部化为私有。行为零变化。

【master 复核 ✅ 前提成立；实施中的事实修正见「执行结果」】

绕过写者：

- `cli.ts saveSession()` —— **无锁**的整文件 read-modify-write（连 tmp 文件名
  都是固定 `.tmp`）。**实施期修正**：其唯一调用链
  `closeSessionForDelete → closeSessionOffline → saveSession` 在 master 上已是
  **死代码**（活的 delete 流早已换到 `abandonSessionAuthoritatively →
  abandonSessionOffline`，全程走带锁的 `mutateSessionOffline`）。处置从「修复
  无锁缺口」改为**整链净删除**（连同孤儿 `loadSessionFresh` 与
  `SessionDeleteCloseResult`）。
- `cli.ts mutateSessionOffline()` —— 带锁 + `findDaemon` fail-closed 的离线
  CAS。语义正确，但它是 store 之外第二份「锁 + 读改写 + strip legacy 字段」的
  拷贝；收编为 store 导出的唯一离线突变入口。
- `cli.ts loadSessions()` —— 第二份「读全部会话文件 + repair」实现；由 store
  的读 API 替代。

绕过读者（改为 store 导出的读 API，语义不变）：

- `daemon.ts readSessionFreshFromDisk()` —— daemon 自己的无锁直读（per-bot +
  legacy 双文件）。热回复路径上无锁快照读是正确语义（atomic rename 保证单文件
  自洽；带锁的 `getSessionFresh` 会阻塞且超时抛错），故收编为 store 的无锁点读
  导出，与 worker 用的带锁 `getSessionFresh`（刻意要求写序）并存、各守其义。
- `core/current-turn-provenance.ts readPersistedSession()` —— 跨全部会话文件的
  只读身份证明扫描。安全敏感：扫描机制收编进 store（数据目录不可枚举 →
  fail-closed 抛错；单个损坏文件跳过），「恰好解析一次」的判定策略留在原模块。

**执行结果（2026-08-13）**：store 新增 4 个导出——`loadAllSessionsSnapshot`
（跨文件快照读，含 sandbox fallback）、`mutateSessionRowOffline`（带锁离线行
突变，`abortIf` 在锁内入口与发布前各探测一次 daemon 在位）、
`readSessionRowFromDisk`（无锁点读）、`readSessionRowCopiesAcrossStores`
（fail-closed 逐文件身份扫描）；cli.ts 的平行持久化实现与死链整体删除
（cli.ts +29/−250），daemon/provenance 直读改走 store（−16/−20）。src 全仓
不再有 session 文件路径拼装点（rg 验证为零）。新增回归 14 例（快照合并/sandbox fallback、
点读回退、fail-closed 扫描、离线突变的 fresh-row/abortIf 双探测/收敛清理）。

**范围边界（防蔓延）**：本步只管**会话行**store。以 sessionId 为键的旁路存储
（turn-sends jsonl、frozen-card-store、whiteboard-store、usage-ledger、
idempotency-store、vc-meeting-* 系列）不动——它们各自有独立文件与生命周期，
不属于「会话行持久化」。`utils/file-lock.ts`（1,004 行）是 ~30 个 store 共用的
基础设施，同样不动。

验收：会话行落盘入口收敛为 1 个模块导出面；删除 cli.ts 分散拷贝与死链。
**无台账、无审计脚本。** ✅

### Step 3 — SQLite 引擎替换（1~2 个 PR）

在 Step 2 的门后把 JSON 换成 per-bot SQLite。打开库必须走 `sqlite-compat`
（Node 的 `node:sqlite` / Bun 的 `bun:sqlite`），禁止再直连 `node:sqlite`。
Node 免 flag 线仍是 v22.13.0 / v23.4.0，但仓库 `engines` 跟 master 的
`>=22`（bun 分发）；现行门是 daemon `assertSqliteSupported()` 经 compat 探测。

【master 复核 ⚠️ 前提表述需修正，但修正后收益更大】

原文「每 bot daemon 本来就是自身会话文件的唯一写者——单写者拓扑现成」**不准确**。
实际写者拓扑：

- per-bot daemon 是唯一**在线**写者（一 bot 一 daemon 进程）；
- **CLI 是离线维护写者**（offline close/abandon 等），今天靠
  「`withFileLockSync` + 锁内 `findDaemon` 探测」维持互斥，存在 TOCTOU 窗口，
  且 `saveSession` 这条腿连锁都没有（Step 2 先收口）；
- worker 子进程与其它 bot 的 daemon 是跨文件**读者**（`findInOtherFiles`、
  `findActiveSessionsMatching`、`countActiveSessionsOnDisk` 等）。

这个修正不削弱反而加强 Step 3 的立项理由——SQLite 在 master 上可核实的收益：

1. **写者互斥从文件锁换成引擎锁**：WAL 下多读者成立；离线 CLI 与 daemon 的
   **写排序**由 `BEGIN IMMEDIATE` 承担。**不是**「findDaemon 探测可以删」——
   SQLite 锁只排序写者，防的是写写交错；探测防的是「daemon 内存缓存与磁盘
   分叉」，二者不可互替。残余 probe-vs-publish TOCTOU 与 JSON 时代等宽，仍
   是 Step 4 候选 (f)，不是本步验收项。消法见该候选：占位进 store，不是再包
   actor。
2. **消灭整图覆盖丢失更新这一整类问题**：今天 daemon 进程终身持有一份
   `Map<string, Session>` 缓存（`load()` 仅一次），每次 `save()` 把**整个 map**
   序列化重写文件——任何外部进程在窗口内写入的行都会被陈旧整图覆盖。改成
   行级 upsert 后该类问题在 SQLite 路径上结构性消失。首次 load 必须与离线
   写者走同一排他协议（`BEGIN IMMEDIATE` 快照读），否则仍会把提交前旧行读进
   终身缓存。
3. **热路径成本**：`updateSession` 全仓约 125 个 src 调用点（0813 计 119；
   0819 基线因 Mojo/dashboard 等新增约 +6）、每条入站消息触发多次，
   每次 `JSON.stringify` 全部会话行（live 数据实测：单 bot 文件 228KB/40 行、
   closed 行从不回收、只增不减）再做 byte-identical 跳写。行级写把 O(全部行)
   变 O(1)。
4. **净删除**（本步的删除项，兑现原则 1；**第一 PR 不兑现，灰度稳定后的
   第二 PR 才删**）：store 内 JSON 机器全部私有报废——`withFileLockSync`
   编排、tmp+rename 原子替换、byte-identical 跳写、legacy `sessions.json`
   迁移分支、`repairMissingChatScopes`（转为导入期一次性步骤）；以及
   **Remote lineage CAS + readback 的 JSON 实现**（0813 时名为 Riff；0819
   基线已改名为 Remote，含 Mojo 共用）。第一 PR 只在 SQLite 上等价重写，
   JSON 实现与 db-else-json 分流逻辑必须留到回滚窗口关闭。因此第一 PR
   **暂时违反原则 1 的「合入即更简单」**——这是设计允许的 1~2 PR 切分，
   不是另起 actor 层；验收以第二 PR 的净删除为准。
5. durability 口径修正：今天的语义是 **tmp+rename、无 fsync**；SQLite WAL +
   `synchronous=NORMAL` 首版即不弱于现状，不顺带升级（维持原验收）。

实施要点（0819 按现行基线补齐，不改目标）：

- 首启从既有 JSON **确定性自动导入**（per-bot 文件 + legacy `sessions.json`
  中属于本 bot 的行；`repairMissingChatScope` 在导入时执行一次）：无操作员
  仪式、无 promotion、无 HIL。JSON 不可读则 **fail-closed**（`loadFailure` +
  `SessionStoreUnavailableError`），禁止导入出空库把唯一副本毁掉。
- **保持 `updateSession(session)` 等既有签名不变**（内部变行级 upsert）。
  0819 基线门面已比 0813 宽：`listSessionsStrict` / `loadForWrite` /
  `persistActiveRemoteLineage*`（原 Riff）/ Mojo close journal 必须走同一
  引擎，不能只换 `updateSession`。
- 跨 bot 发现类读者改为只读打开兄弟 bot 的 `.db`；扫描函数按 db-else-json
  解析每个 store。远程 sandbox 无本地 store 的路径（cli.ts `loadSessions`
  走 `loadAllSessionsSnapshot` + sandbox fallback）语义不变。
- per-bot 库放 `session-stores/<appId>/sessions.db`（目录 bind，避免 bwrap
  单文件 inode 钉死 WAL sidecar）；legacy 无 appId 库保持平铺、不进沙盒。
- worker `owner: false`：混合窗口内旧 daemon 从新 dist spawn 的 worker 不得
  首启导入。
- 运行时门：打开库走 `src/services/sqlite-compat.ts`（与 feedback / opencode /
  traex 同一入口）。Node 免 flag 线仍是 v22.13.0 / v23.4.0，但 `package.json`
  `engines` **不收紧**——跟 master `node: >=22`（bun 单二进制用 `bun:sqlite`）。
  真门是 daemon 启动 `assertSqliteSupported()`：模块加载失败才算引擎不可用；
  损坏 `.db` 不得收成 Unavailable（否则身份扫描会把坏库误判成整机无 SQLite）。
  opencode.ts 仍标注 experimental，那是先例不是现行能力边界。
- 经 npm canary 渠道灰度；稳定后删除 JSON 会话持久化路径（第二 PR）。

验收：第一 PR = 引擎互换 + 混合窗口 + 行为等价（含 0819 基线新增 API）；
第二 PR = 上述净删除。durability 首版与今日等价。

**执行结果（2026-08-20，#852 rebase onto origin/master@3d84aaad）**：

- store 公共签名保持；内部 SQLite 单表 + 整行 JSON 列 + VIRTUAL 生成列索引。
- 混合窗口统一 db-else-json；abortIf 双探测保留；首次 load 走 BEGIN IMMEDIATE。
- 0819 基线新增面已接上：Remote lineage CAS、Mojo journal 经 `persistRow`、
  损坏 store 的写门对 .db 同样 fail-closed。`BEGIN IMMEDIATE` 超时
  （SQLITE_BUSY）**不得**收成空投影：daemon restore 走 `listSessions()`，
  锁等待必须抛错而不能当成「没有会话」。
- 0820 基线新增面：Workbench `previewTarget` 在 `closeSession` / `reactivateClosedSession`
  清除并随 `persistRow` 回滚；#846 四导出在 SQLite + 混合窗口下仍是唯一门。
- 体量：0813 master `session-store.ts` 1390 行 → 本 PR ~2161 行。这是「JSON 机器
  + SQLite 机器」共存的中间态，印证原则 1 的兑现点在第二 PR，不在本 PR。
- src 无 SessionRuntime / virtual-actor 缝隙回流。

**执行结果（2026-08-27，#852 rebase onto origin/master@06db2b48）**：

- 会话库不再直连 `node:sqlite`，经 `sqliteEngineAvailable` +
  `openDatabaseSyncOrThrow` 打开；与 master bun 分发同一运行时原则。
- `engines` 恢复 master 的 `>=22`；硬门文案同时覆盖 Node 升级线与 Bun
  `bun:sqlite`。损坏库与引擎缺失分型：扫描 skip vs 穿透抛错。
- 原则自检（对照 3d84aaad..06db2b48）：唯一门仍在（src 无 `sessions*.json`
  直写绕过；CLI 只委托 store）；worker `owner: false`、fs-policy 授
  `session-stores/<appId>` 目录、descriptor 后再 `listSessions()` +
  `BEGIN IMMEDIATE`、`abortIf`+`findDaemon` 均保住。#889 会话级 `/cli` 写的是
  Session 字段经 `updateSession`；#1017 发信人仍走
  `readSessionRowCopiesAcrossStores`；#946 journal / #1008 schedule 仍是旁路
  文件，符合非目标。无 SessionRuntime 回流，Step 4(f) 占位租约仍未实施。

**执行结果（2026-08-28，Step 3 第二 PR，基线 `origin/master@0265234d`）**：

原则 1 在本步兑现。`session-store.ts` 从 2154 行降到约 1800 行，且删掉的全部是机器
而不是注释：

- **daemon 侧 JSON 引擎净删除**：`save()` 整份序列化 + tmp+rename + byte-identical
  跳写、`load()` 的 JSON 写回与 legacy→per-bot 迁移写、`readExistingSessionsFromDisk` /
  `readSessionsProjectionStrict`、Remote lineage CAS + readback 的 JSON 实现（约 80 行）、
  `repairMissingChatScopes` 与它每次 load 里那次「修完再写回」的事务、
  `persistRow` 的 `save()` 兜底。拥有者 daemon 从此只写 SQLite。

- **跨进程那一层的 db-else-json 保留**（读 + 离线写）。原计划第 5 条写的是
  「收敛为 db-only」，**这条被推翻了**：db-only 会在「npm 已升级、daemon 还没重启」
  的窗口里把 CLI 快照读、点读、身份扫描、worker 读、离线写**五条全部打断**——
  实测与 master 的 A/B 见下。而这个窗口不是少数落后用户的边角：自动更新默认关闭、
  `botmux upgrade` 明说让用户自己 `botmux restart`，所以它**没有上界**，且每个老用户
  升级时都会经历一次。窗口内 agent 连 `botmux send` 都发不出去，等于回不了话。
  原计划把「灰度稳定」当成可以假设的前提，这个前提不成立。
- **`withFileLockSync` 只剩导入一处**（编排全部消失）。**没有全删**：导入经固定的
  `<db>.tmp` 暂存，同一 bot 的两个 owner 进程可能短暂并存（重启撞上尚未回收的前任），
  两边都会通过 `existsSync(db)`、写同一个 tmp、发布出损坏库。改 per-process tmp 名会换来
  没人清理的孤儿文件；直接建进最终 `.db` 则会打破本设计赖以成立的不变量——
  「`.db` 存在」必须等价于「导入已完成」，否则半截导入会静默关掉导入门、丢光迁移前的行。
- **脏数据修补收敛为导入期一次性**：`stripLegacyPendingCardFields` 与
  `repairMissingChatScope` 不再挂在每次写、也不再挂在 `load()` 上（`Session` 类型已不含
  那些字段，SQLite 写出的行天生干净），连带删掉 `repairMissingChatScopes()` 这个
  map 级修补函数与它在每次 load 里那次「修完再写回」的额外事务。
  唯一保留的读侧调用在 `loadAllSessionsSnapshot`：它读的是**别人的 store**，
  这个进程既不拥有也修不了那些行，一次纯内存归一化是合理的，且不写盘。
  原先只在「恰好对该 store 做过一次离线写」时才发生的 key-mismatch 收敛
  （旧实现是 `delete data[key]`）**不再发生，也不改成导入期重键**：两条 JSON 记录
  可能带同一个 `sessionId`，按 `sessionId` 重键会让后写的那条 `INSERT OR REPLACE`
  掉前一条——陈旧的 closed 幽灵行覆盖活行，而且导入只跑一次、JSON 随后冻结，
  不可逆。按文件原 key 导入，错键行保持惰性（身份扫描本来就跳过 key 与
  `sessionId` 不符的行）。这一条是复核时用两个 checkout 跑同一份输入实测出来的。
- **升级窗口内行为与 master 逐字一致**（实测 A/B：CLI 快照读 / 点读 / 身份扫描 /
  worker `getSession` / `getSessionFresh` / 离线写六项全部相同）。`owner: false` 的
  `load()` 读那份 JSON 但**只读**——scope 修复与 legacy 迁移都是拥有者 daemon 的活，
  它在导入时做一次。离线写仍落到同一份 JSON（那台 daemon 还在读它），并且**绝不建 .db**：
  空库会关掉它的一次性导入门。
- **两条建库地雷已封**（删 JSON 分支时才暴露出来，master 上靠 db-else-json 的
  `existsSync` 前置侥幸不可达）：SQLite 的读写 open **会创建文件**，而一个空库会让
  daemon 的 `existsSync(db)` 导入门判假、静默丢掉整份迁移前的行。现在
  `openDbForRead` 对不存在的路径直接抛错，`mutateSessionRowOffline` 在 open 前先
  `existsSync`，`withOwnStoreDb` 不再自开连接而是走 `loadForWrite()` 复用 load 附着的那个。
- **死参数删除**：Remote 两个批量 API 的 `options.maxWaitMs` 自 #852 起在 SQLite 路径上
  就已失效（它约束的是文件锁），现在连 JSON 路径也没有了，从签名删除；
  fleet shutdown 的 deadline 预检（`remaining <= 0` 直接拒绝）保留，仍在干活。
  等待上限统一由 `busy_timeout`（3s）决定。
- **沙盒**：两处 readOnly 授权改为「store 目录 + 冻结 JSON」并存（目录 bind 的理由见
  #852：单文件 bind 会钉死 WAL sidecar 的 inode）；兄弟 bot 仍 deny-by-default，
  且回归里把这条安全断言加强到 sibling 目录本身与共享父目录。
- **冻结 JSON 的处置（第二 PR 待决项 6）决定：原地保留，不删不改名。** 它已不被任何
  运行时路径读取，代码成本为零；而它是回退到迁移前版本时唯一还能读的副本，改名反而会让
  回退后的旧 daemon 从空库起步、再写出一份新的 JSON。几百 KB 换一条不可逆边界的兜底，
  值得。

**顺带的正向副作用（身份扫描）**：`readSessionRowCopiesAcrossStores` 的「恰好一次」判定
在 db-only 下更准。legacy → per-bot 的迁移一直是**复制不删除**，所以
`{sessions.json 含 X, session-stores/A/sessions.db 含 X}` 是常态，今天会被判成「重复 →
拒绝推断当前调用者」。冻结 JSON 不再是 store 之后这类假歧义消失；同时也堵掉一个伪造面：
今天任何能往 dataDir 写文件的进程放一个 `sessions-evil.json`，若目标 session 所在 store
尚无 `.db`，它就是唯一命中并被当作身份来源。

**顺带修掉的 master 活 bug（#852 引入，非本步回归）**：一次性导入的暂存库原本开
WAL，而 `renameSync` 只搬走一个文件。`bun:sqlite` 关连接时不把 `-wal` 折回主文件，
于是行全留在 `sessions.db.tmp-wal` 里，发布出去的是 4KB 只有文件头的库，之后每次
打开报 `disk I/O error`；导入门是 `existsSync(db)`，这个壳再也不会被重建——迁移前的
会话在所有活路径上消失。两个 checkout 同一份输入实测复现。暂存改用回滚日志
（`journal_mode = DELETE`）让文件自包含，真正的库仍跑 WAL。本 PR 把 JSON 引擎删掉
之后导入是唯一迁移路径，所以必须在这里修。

**唯一门的一处漏网（本步补上）**：Step 2 的验收写着「src 全仓不再有 session 文件路径
拼装点（rg 验证为零）」，但 `services/whiteboard-store.ts` 的
`clearSessionWhiteboardRefs` 是 `readdir` 数据目录 + `startsWith('sessions') &&
endsWith('.json')` 动态筛名，整份读改写——按名字 grep 命不中，所以历次核查都漏了。
它在 #852 之后已经静默失效（行搬进 SQLite 后一个文件都匹配不到，`deleteWhiteboard`
返回 `clearedSessions: 0`，而每一行的 `whiteboardId` 还指着删掉的板）；测试一直绿是
因为夹具写的正是 JSON。本步改为经 `loadAllSessionsSnapshot` + `mutateSessionRowOffline`。
**方法论教训**：验证「唯一门」不能只 grep 字面文件名，还要查动态筛名
（`startsWith`/`endsWith`/正则）与 `readdir` 数据目录的地方。

**已知边界（本步接受并明写）**：

- **本步不再依赖任何灰度假设**：跨进程 db-else-json 保留后，升级窗口内的行为与
  master 一致，什么时候合都安全。代价是 `StoreFileRef.kind` 与三个读函数、
  `getSessionFresh`、`mutateSessionRowOffline` 的 JSON 分支继续留在库里，
  约 60 行——它们的清除条件仍是「窗口真的关闭」，但那已经不是本步的前提。
- 离线写在 SQLite 路径上不再顺手收敛整个 store（行级写只碰一行）：错键的脏行
  不再被删除，保持惰性存在（读侧本来就按 `sessionId` 过滤）。JSON 路径保持原样。
- 沙盒**仍然**授权 `sessions-<appId>.json`（一度想撤掉，作为「减面」的一部分）。
  撤掉会让升级窗口内沙盒里的 `botmux send` 连 stat 都做不到那份 JSON，直接报
  「找不到 session」——而沙盒是 agent 的主路径，那等于把上面刚修好的窗口兼容
  在最常用的那条路上又废掉。它的清除条件与 db-else-json 同一条：窗口真的关闭。

### Step 4 — 按痛点上事务（N 个独立小 PR，ROI gate）

仅对**在 master 上有实测复现**的竞态，用 SQLite 事务原语逐个重做。
**（0813 收紧）复现要求 test-first：每个候选先在 master 写出能红的竞态测试或
给出线上事故指针，才允许立项——stage2 竞态清单只指路，不作数。**
每个 PR 必须删掉它所替代的 ad-hoc 防御——不删旧的，就不上新的。

【master 复核 ✅ 事务形状的 ad-hoc 防御真实存在，候选素材如下（未验复现，
仅为「去哪里看」清单）】

- (a) `closeSession`/`reactivateClosedSession` 的手工回滚 —— **已随 Step 3 第二 PR
  落地，不再单独立项**（原判断「Step 3 落地后事务化即天然替代」成立）。原实现在活的
  `Session` 对象上就地改，写失败再逐字段还原：`closeSession` 抄 14 个字段、
  `reactivateClosedSession` 抄 20 个、`mutateMojoCloseJournal` 抄 2 个——一份靠人肉维护的
  undo 日志，漏抄一个字段就是一次静默不一致。现在改成**先持久化副本、提交成功后再合并回
  内存对象**（`persistRow(next)` → `Object.assign(session, next)`），失败路径变成「什么都
  没发生」，没有可漏抄的东西。用 `Object.assign` 而不是替换 map 里的引用，是因为
  `DaemonSession` 等模块持有同一个对象的别名——§3「不动内存共享可变语义」在此仍然成立。
  既有的三条回滚回归用例（Riff lineage / previewTarget / mojo park 在写失败后保持原状）
  一字未改地继续绿，就是等价性的证明。
- (b) `reserveWorkerGeneration` 回滚重抛（0819：worker-pool.ts `reserveWorkerGeneration`）
  与 worker exit fence 的**无保护** `updateSession`——后者是 Step 1 分析中发现
  的疑似真实脆弱点。立项前必须在现行 master 重新定位行号并写出能红的测试。
- (c) `admitQueuedActivationTail` 的 priorTail 回滚舞蹈（worker-pool.ts
  `admitQueuedActivationTail`）。**0828 复核：形状与 (a) 相同，但不能照搬 (a) 的消法。**
  (a) 在 store 内部，可以「持久化副本 → `Object.assign` 回活对象」；(c) 在 store 外部，
  只能调 `updateSession(session)`，而它会 `sessions.set(id, session)`——传副本进去会把
  map 里的条目换成副本，切断 `ds.session` 的别名。要按 (a) 的方式做，得先给 store 加一个
  「按 patch 更新、不重绑引用」的新 API；为省掉 4 行还原代码而新增一个公共写入口，不划算。
  暂不立项，除非将来另有独立理由引入该 API。
- (d) **async tail-admission 整套**（0819：daemon.ts
  `queuedActivationTailAdmissionsOutstanding` / ReleasePending / RetryTimer
  三件套 + DaemonSession 三字段 + gate 分支）——Step 1 候选 5 的降级素材归位处：
  若队首激活的 FIFO 语义由事务表达，这套进程内计数器机器就是它替代并删除的
  ad-hoc 防御。
- (e) `initial-user-turn` 的 best-effort persist（落盘失败退化为进程内生效）。
- (f) **离线写 `findDaemon` probe-vs-publish TOCTOU**（0820 口径备忘，未立项）。
  Step 3 收益第 1 条已写明：SQLite 只排序写者，`abortIf` + `findDaemon` 必须留；
  残余窗口与 JSON 时代等宽。下面「占位租约」是这条候选若立项时的**消法**，
  不是本步或 Step 3 的验收项。

stage2 的 receipts / per-session lane 语义仍作设计参考，代码不搬。

#### 候选 (f) 消法：占位进 store，不必叫 actor

这段窗口**不是**「daemon 进程内少了一个 mailbox」。产品规定了两种权威——
daemon 活着时内存 `Map` 是权威；daemon 不在时 CLI 必须能改盘（离线 close /
abandon）。第二种权威不会消失。TOCTOU 来自实现选择：`findDaemon` 读的是旁路
descriptor（`dashboard-daemons/*.json` 心跳），写的是会话库——检查 A、动手 B。

因此：

- **必然存在的**：daemon 挂了仍要有人能写盘。
- **不是必然的**：探 descriptor 和写会话行之间的缝。那是占位放在旁路文件上。
- **与 virtual actor 无关的**：stage2 的 `SessionRuntime` 管进程内怎么改字段；
  窗口发生在 CLI 进程 vs daemon 进程之间。进程内单线程化消不掉它。stage2 也
  没消：CLI 仍是第二写者，descriptor 仍在库外。用缝隙层消这条是用错工具。
- **相关的只是 occupancy 协议**（Orleans grain directory / Durable Object 的
  瘦身版）：同一时刻一个 activation；没有 activation 才允许 failover 写存储；
  **占位和数据在同一个原子里**。落到本仓库就是 store 元数据，不是 actor 框架，
  也不是 §3 禁止的 BotId 注册表。

若立项（仍要 test-first 复现 + 合入即删旧探测），形态是：

1. 会话库持有占位：`owner_pid` / `boot_id` / `lease_until`（或 SQLite 锁会话）。
2. daemon 启动：与首次 load **同一事务**占位（现协议是先写 descriptor 再 load，
   占位与行不在同一原子）。
3. CLI 离线写：`BEGIN IMMEDIATE` → 读占位 → 租约有效则 abort 去 IPC，否则改行
   并 COMMIT。检查和动手一次事务。
4. 租约靠心跳续期；过期才允许 CLI 当 failover 写者（90s 心跳过期已有，只是
   和行不在同一原子）。

验收必须**删掉或降级**旁路 `findDaemon` 探路（发现仍可读 descriptor，所有权
不得再靠它 abort），不能两套探测并存——否则违反「上新必须删旧」。
`BEGIN IMMEDIATE` 单独代替 `findDaemon` 不构成验收：锁看不见「对面有一份会
写回的缓存」。禁止 CLI 写盘也不构成验收：离线收尸没了。

### Step 5 — 资产归档（无代码）

- feat/virtual_actor_stage2 打 tag 归档，#831 关闭并留结论指针；
- 两份审计台账转为一次性《会话写点地图》静态文档（1,408 写点分布本身有诊断
  价值），声明停止维护，审计脚本不迁移。

## 3. 非目标

- 不迁移调用方群组，不建 actor 抽象层，不引入 SessionRuntime/SessionProjection 缝隙；
  virtual-actor（#831 / feat/virtual_actor_stage2）维持不合入，不在 Step 3/4
  「顺便固化」。store-first 就是对它的替代，不是前置。
- 不引入分配式身份或任何注册表（BotId 保持地址纯推导）。会话库内的**占位租约**
  （Step 4 候选 f：哪个 daemon 此刻拥有本 bot 的行）是 store 元数据，不是身份
  注册表，立项时不得借此引入 BotId 分配。
- 不动内存 DaemonSession 的共享可变语义——它在单 daemon 进程内工作正常，
  重构它需要独立的实测理由；也**消不掉**跨进程离线写 TOCTOU（见候选 f）。
- （0813 明确）不把 sessionId 旁路存储（turn-sends、frozen-card、whiteboard、
  usage-ledger、idempotency、vc-meeting-*）卷进 Step 2/3 的范围。

## 4. 与 stage2 资产的关系

代码不搬，知识全收：1,408 写点地图（台账坐标）、竞态与幂等语义清单
（receipts/lane 设计）、以及「纪律性边界必然演化出监视系统」这条反面教训。
**（0813 追加）使用方式收紧：全部按「线索」使用，逐条在 master 复核后才可
立项——Step 1 的执行记录（7 项候选 6 项不成立）就是这条规则的成因。**
