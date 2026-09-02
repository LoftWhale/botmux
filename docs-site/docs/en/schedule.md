# Scheduled Tasks

Supports three schedule types plus natural-language input, posting a follow-up message in **the original topic where the task was created** and executing it when due (no separate thread is opened; the working directory matches the one at creation time).

## Two Ways to Create

- **Slash command** (quick): `/schedule 每日17:50 帮我看看AI圈有什么新闻`
- **Conversational trigger** (flexible): just tell the agent "add me a scheduled task to check deployment every day at 18:00", which automatically triggers the `botmux-schedule` skill.

## Supported Formats

```bash
# Chinese natural language
/schedule 每日17:50 帮我看看AI圈有什么新闻
/schedule 工作日每天9:00 检查服务状态
/schedule 每周一10:00 生成周报

# One-time tasks
/schedule 30分钟后 检查部署状态
/schedule 明天9:00 发早会提醒

# English duration / interval / cron
/schedule every 2h 巡检服务
/schedule 30m 提醒我喝水
/schedule 0 9 * * * 早安问候

# ISO timestamp
/schedule 2026-05-01T10:00 ...
```

## A New Topic Per Run

By default every fire continues in **the original topic where the task was created**. To make each run land in a **brand-new topic** in the same chat with its own isolated session (ideal for daily-report style tasks where each run should stand alone), there are three ways:

```bash
# Slash command: prefix the prompt with the 新话题 ("new topic") keyword
/schedule 每日17:30 新话题 generate today's discussion digest

# CLI: --new-topic flag
botmux schedule add "每日17:30" "generate digest" --new-topic

# CLI: equivalent --deliver form
botmux schedule add "每日17:30" "generate digest" --deliver new-topic
```

You can also flip an existing task between "original thread" and "new topic each run" from the **Delivery** column toggle on the dashboard's Schedules page.

## Follow the Active Topic

A topic-pinned task keeps firing into the topic it was created in; once the conversation has moved to another topic, reminders land where nobody is looking. `--follow-active` makes the task pick its target **at every fire**: the topic in this chat where a **human most recently spoke**.

```bash
# Created from inside a topic session: that topic is the starting point
botmux schedule add "every 30m" "check the service, alert only on failure" --follow-active

# Or give the starting point explicitly
botmux schedule add "每日9:00" "standup reminder" --follow-active --root-msg-id om_xxx
```

Three rules:

- **Only human messages count as activity.** Bot replies and scheduled-task output are ignored — otherwise a task firing every 30 minutes would keep its own topic "most active" and follow itself forever.
- **Judged across every bot.** Where the person is, is a property of the person, not of one bot. Each bot in the chat keeps its own session records; all of them are consulted.
- **On no match, keep the last landing point; never open a new topic.** If no topic has any human activity on record (fresh restart, records not built up yet), the task fires into the topic it last landed in — the creation topic until the first fire.

`--follow-active` only makes sense for topic execution and cannot be combined with `--top-level` / `--new-topic`. Tasks of this kind show a `↷跟随活跃话题` marker in `schedule list`.

## Management

```bash
/schedule list
/schedule remove|enable|disable|run <id>
```

> Execution behavior: when due, if the session in the original topic is still alive, the prompt is injected directly into the existing session (no new worker is started); otherwise a new worker is spun up to execute in the original working directory. A `--new-topic` task always opens a fresh topic + new session and never reuses a prior one.
