# 回复风格配置化（PR #1057 终态规格）

`--layout` 薄壳 + 按 bot 配置的实现规格。写作配方、`width_mode: fill`、`heading-2`、表格 live 回读已在同 PR 落地。

**本轮定稿（实现必须对齐，不要自行改语义）：**

- 五档：`result` / `progress` / `risk` / `blocked` / `handoff`
- 卡头：绿 / 蓝 / 橙 / 红 / **indigo**（交接不用 grey，避免像已失效）
- 标签：只有 `risk`、`blocked` 带「需要你」；其它档不带标签
- **不设** `compare` 档：对比用自由 Markdown；要人做选择走 `risk` + `botmux ask`
- **Diff 分栏不进本轮**（仍记在 `docs/plans/2026-08-27-reply-card-layer2-backlog.md`，另开）

配置落在 **bot 维度**。飞书一条卡片只有一份渲染，群里不能按读者换皮肤。私聊按人配不进本轮。

## 底线（任何配置组合都不放开）

- 不做假按钮；要选择走 `botmux ask`
- 不接受调用方注入任意卡片 JSON 当「主题」（`--card-json` 仍是逃生阀，和风格配置无关）
- quoted / history 回读对等：换主题不能让跨 bot 读回丢字段
- 不从正文猜成功/失败再上色；颜色只来自 Agent 显式 `--layout <档>` + 该 bot 的主题映射

## 配置项清单

| 键 | 类型 | 缺省 | 作用 |
|---|---|---|---|
| `replyStyle.recipes` | bool | `true` | 是否把五类写作配方注入 `botmux-send` 指南。`false` → 指南回到纯自由 Markdown |
| `replyStyle.layout` | bool | `true`（layout 能力落地后） | 是否允许 `--layout`。`false` → flag 被忽略，回退普通回复卡 |
| `replyStyle.theme` | `'default' \| 'minimal' \| 'vivid'` | `'default'` | 预设主题，只改变壳的「重」，不改变五档语义 |
| `replyStyle.recipePrompt` | string | 缺省 | **本轮不做**：覆写/追加该 bot 的配方引导文案 |
| `replyStyle.layoutColors` | 对象 | 缺省映射 | **本轮不做**：在飞书 `header.template` 官方枚举内改档位颜色 |
| `replyStyle.layoutTags` | 对象 | 见下 | **本轮不做**：改标签文案。空字符串 = 该档不显示标签 |

`layoutColors` 只允许飞书卡头 template 枚举：`blue` / `wathet` / `turquoise` / `green` / `yellow` / `orange` / `red` / `carmine` / `violet` / `purple` / `indigo` / `grey`。非法值忽略并打日志，回退主题缺省，不发送失败。

## 预设主题（第一批就要能跑）

五档语义固定，主题只调视觉重量。

| 主题 | 卡头 | 标签 |
|---|---|---|
| `default` | `green` / `blue` / `orange` / `red` / `indigo` | 仅 `risk`、`blocked` →「需要你」 |
| `minimal` | 五档都无彩色 template，只留标题 | 仅 `risk`、`blocked` →「需要你」 |
| `vivid` | 同 default 的五色 | 五档都带：完成 / 进行中 / 需要你 / 需要你 / 交接 |

`vivid` 的额外标签是主题增量；**default 才是定稿观感**。实现时 default 不得给 result/progress/handoff 加标签。

短确认、未传 `--layout`：三种主题都 **不套壳**。没有 `compare`、`diff` 这两个名字。

## 落点

**bots.json**（每个 bot 一条，紧挨 `brandLabel` / `usageDisplay` 这类展示配置）：

```json
{
  "replyStyle": {
    "recipes": true,
    "layout": true,
    "theme": "default"
  }
}
```

缺省整块省略 = 上表缺省。不要做成全局 daemon 配置，避免一改全员 Bot 变脸。

**Dashboard**：Bot 设置里、品牌文案附近加一小节「回复风格」。第一批 UI 只需：

- 配方引导：开 / 关
- layout 壳：开 / 关
- 主题：默认 / 极简 / 鲜明（下拉，枚举写死）

第二批再放开「配方文本」多行输入、每档颜色下拉（同样锁官方枚举）。

**skill 注入**：`replyStyle.recipes === false` 时，`botmux-send` 内置指南去掉配方表和选型信号，其它发送契约不变。`layout === false` 时指南不提 `--layout`。

**CLI**：`--layout` 只在 `layout !== false` 时生效；关掉则 stderr 一行提示已忽略，消息仍按普通回复卡发出，不 fail。

## 切分

### 本轮终态（本 PR）

1. 五档 layout 薄壳：卡头按上表 + 规定标签 + 正文仍走现有 Markdown（不加原生分栏、不加进度条、不加按钮）
2. `replyStyle.recipes` / `replyStyle.layout` / `replyStyle.theme`；枚举锁死，非法值忽略并回退缺省，发送不失败
3. bots.json 解析 + Dashboard 三个控件
4. `recipes === false` 时指南去掉配方表和选型信号；`layout === false` 时指南不提 `--layout`，CLI 忽略 flag
5. 回读：换主题后 `quoted` / `history` 仍能还原正文和表格；测例必须用 **live 归一化形态**，不认 builder 原始 JSON

### 本轮之后

1. `recipePrompt` 覆写/追加写作引导
2. `layoutColors` / `layoutTags` 枚举内微调
3. Diff 分栏（见 layer2 backlog）
4. 私聊按人覆盖（若要做）；群聊永远不按读者分皮肤

## 明确不做（本轮）

- `compare` 档、`diff` 档、进度条、假按钮、插件模板
- 读者侧主题切换、一条消息两套渲染
- 从标题或正文关键词自动选档、自动上色
- 任意卡片 JSON 当主题
- 用 grey 做 handoff 卡头
