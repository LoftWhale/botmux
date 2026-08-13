# RCA Shadow Mirror

Botmux can mirror the exact prepared Agent input to Search RCA after the
current worker dispatch succeeds. The current Coco turn remains authoritative:
the mirror is bounded, fire-and-forget, and disabled by default.

Configure the Botmux daemon process environment:

```bash
BOTMUX_RCA_MIRROR_URL=http://10.37.125.55:7310
BOTMUX_RCA_MIRROR_TOKEN_FILE=/home/zhubowen.cc/.botmux/rca-mirror-token
BOTMUX_RCA_MIRROR_BOT_APP_IDS=<online RCA bot app id>,<Candidate bot app id>
BOTMUX_RCA_MIRROR_CANDIDATE_BOT_APP_IDS=<Candidate bot app id>
BOTMUX_RCA_MIRROR_TIMEOUT_MS=500
BOTMUX_RCA_MIRROR_MAX_IN_FLIGHT=2
BOTMUX_RCA_MIRROR_MAX_QUEUED=16
BOTMUX_RCA_SHADOW_CHAT_ID=oc_9aed281df324fa3d3fc5400110ba2b68
BOTMUX_RCA_SHADOW_POLL_INTERVAL_MS=1000
BOTMUX_RCA_SHADOW_POLL_TIMEOUT_MS=900000
```

`BOTMUX_RCA_MIRROR_BOT_APP_IDS` is mandatory and comma-separated. This keeps
ordinary Botmux agents out of the experiment. Botmux session, Lark turn, and
topic identifiers are HMACed before they become correlation fields in the
Search RCA API. No response from Search RCA is used by the current Coco path.
Candidate app IDs are always excluded from turn and Champion mirroring, while
`BOTMUX_RCA_SHADOW_CHAT_ID` (plus optional comma-separated
`BOTMUX_RCA_MIRROR_SHADOW_CHAT_IDS`) excludes every Shadow/replay topic by chat
identity. Candidate durable-receipt callbacks remain enabled for the Candidate
app because they are control-plane acknowledgements, not new RCA inputs.
When a Shadow mirror URL, bot allowlist, and Shadow chat are configured, daemon
configuration fails closed unless every Candidate app ID is present in both the
allowlist and `BOTMUX_RCA_MIRROR_CANDIDATE_BOT_APP_IDS`.
`BOTMUX_RCA_MIRROR_TOKEN` remains available for ephemeral environments, but a
mode-600 token file avoids persisting the secret in daemon configuration.

After the online Agent successfully delivers a primary `botmux send`, Botmux
posts that user-visible body to `/api/mirrors/champions` with the same
HMAC-derived session and turn keys. An accepted `final_output` is retained as a
fallback for paths that do not explicitly send. Both callbacks are
fire-and-forget; the first result for one turn is immutable. Search RCA
persists an early callback until the matching mirrored turn arrives and uses
that result as the pre-cutover Champion. It must not substitute one of its own
earlier runs.

After Search RCA accepts the first turn, it calls Botmux's durable Candidate
launch boundary. Botmux creates exactly one topic in the fixed Shadow group,
binds the runtime to the release's observed Botmux commit, and reports durable
turn receipts back to Search RCA. Feishu credentials never leave Botmux.
