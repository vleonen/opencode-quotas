# peakhours — provider peak-hours & live quota for OpenCode

An [OpenCode](https://opencode.ai) plugin that keeps you oriented in model providers'
**peak / off-peak hours** — discounted API price windows (DeepSeek), subscription-quota
multipliers (z.ai GLM Coding Plan), and congestion windows (Kimi Code) — right inside the
TUI, the web UI, and a live browser dashboard.

It can **also pull live subscription-quota / budget / balance numbers from each
provider's own account API** (DeepSeek, z.ai, Kimi Code, Moonshot, MiniMax, OpenCode
Zen) and show them next to the peak-hours data, with low-quota and low-balance alerts.

Single file. Zero runtime dependencies. No build step.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Provider peak-hours                                                    │
│ DeepSeek API        PEAK     next: off-peak 3h 05m (10:00 local)       │
│ z.ai GLM Coding     PEAK     next: off-peak 3h 05m · weekends 1x/0.5x   │
│ Kimi Code           PEAK     next: off-peak 2h 05m (fewer 429s)         │
│ MiniMax Token Plan  —        no fixed windows (5h rolling quota)        │
│                                                                        │
│ Quota & balance (live)                                                 │
│ Kimi Code weekly 90% used · z.ai 5h 40% · DeepSeek $12.50              │
└────────────────────────────────────────────────────────────────────────┘
```

## Requirements

- A current [OpenCode](https://opencode.ai) install. The plugin only uses stable
  plugin APIs: local plugin auto-loading, the `config` hook, `event` hooks, TUI
  toasts, and `client.session.prompt()`.
- Nothing else — the single `opencode-quotas.ts` file has **zero npm dependencies** (its
  imports are type-only imports plus node builtins), so there is no build step and
  no `package.json` needed.
- Optional: `curl` on your `PATH` (used by the `/peakhours` command's template to
  echo the live table), and `osascript` (macOS) or `notify-send` (Linux) if you
  enable desktop notifications.

## Install

### 1. Drop the file into a plugin directory

Copy `opencode-quotas.ts` into either location (both are scanned automatically):

```bash
# global — loaded for every project
mkdir -p ~/.config/opencode/plugins
cp opencode-quotas.ts ~/.config/opencode/plugins/opencode-quotas.ts

# or per-project — loaded only in this repo
mkdir -p .opencode/plugins
cp opencode-quotas.ts .opencode/plugins/opencode-quotas.ts
```

### 2. Restart opencode

Plugins are loaded at startup. Exit any running `opencode` / `opencode serve`
process and start it again. On the next client attach you will see an
**info toast** titled *Provider peak-hours* with a compact status table, and the
companion dashboard becomes available (default `http://127.0.0.1:4117`).

### 3. Verify it works

Any of these confirms a healthy install:

- **Toast** — start `opencode` (TUI): the welcome toast appears ~1 second after attach.
- **Dashboard** — open `http://127.0.0.1:4117` in a browser (the exact URL is also
  shown in the welcome toast and the session card; if 4117 was busy the plugin
  silently took the next free port).
- **Command** — type `/peakhours` in the TUI: an instant toast appears and the live
  status table is echoed into the conversation.
- **API** — `curl http://127.0.0.1:4117/api/status` returns the JSON status (add `-u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD"` when authentication is enabled).

### Install with options (opencode.json)

By default everything works without any configuration. To pass an options object,
list the plugin explicitly in `opencode.json`. **Local file entries must be a
path** (relative to the config file, absolute, or a `file://` URL) — plain names
like `"opencode-quotas"` are resolved as npm packages:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./.opencode/plugins/opencode-quotas.ts",
      {
        "leadMinutes": 10,
        "port": 4117,
        "usage": { "keys": { "zai": "<your-key>", "deepseek": "<your-key>" } }
      }
    ]
  ]
}
```

Notes:

- **1.18.30 caveat (verified):** a `["path", {options}]` pair entry can be *silently
  ignored* by the plugin loader — the plugin just never loads, with no error. If the
  plugin does not appear, install it in a plugins directory instead and pass options
  via `PEAKHOURS_*` environment variables.
- If the file already sits in a plugin directory *and* is listed in `plugin`, it is
  still loaded exactly once — the config entry just supplies the options.
- A file discovered **only** via a plugin directory never receives an options
  object; configure it through the `PEAKHOURS_*` environment variables instead.

### Uninstall

Delete the file (and/or remove the `plugin` entry). On shutdown the plugin's
`dispose` hook stops its timers and the companion server automatically.

## Usage

### `/peakhours` command

Registered automatically by the plugin's `config` hook — no `opencode.json` editing
needed. Running it does two things:

1. **Instant toast** (zero model cost) with the current peak/off-peak state of every
   tracked provider, the countdown to the next window flip, and the dashboard URL.
2. **Live status table** echoed into the conversation: the command's template fetches
   `/peakhours.txt` from the companion server via `curl` and the model renders it
   verbatim, including the quota & balance section when keys are configured.

### Toasts

| Toast | When | Variant |
|---|---|---|
| Welcome status | A TUI/web client attaches (debounced to once per minute) | info |
| Window transition | `leadMinutes` (default **15**) before a provider enters or leaves a peak window; optional desktop notification with `notify: true` | warning (peak starting) / success (off-peak starting) |
| Quota alert | A quota window crosses `usage.alertPct` (default **80 %**) used, or a PAYG balance drops to `usage.minBalance`; alerts are de-duplicated per window reset (balance: hourly) | warning / error |

Toasts are delivered via `POST /tui/show-toast`, which only exists while a TUI
client is attached. In web-only/headless mode those calls fail silently — the
session card and companion page keep working there.

### Session card

Every new **top-level** session gets a markdown status card posted as a *no-reply
synthetic message* (`noReply: true`, `synthetic` + `ignored` parts). It renders in
both the TUI and the web UI and costs **zero model tokens** — it is never sent to
the model. Child/subagent sessions are skipped. Disable with
`cardOnSessionStart: false` / `PEAKHOURS_SESSION_CARD=0`.

### Companion dashboard

A tiny status server (Bun.serve with a `node:http` fallback) serves a dark/light,
auto-refreshing dashboard — each provider card has a **24-hour peak bar** (amber peak
segments, current-time marker, provider-tz clock) plus window and quota progress bars,
reset countdowns, local + UTC clocks, and color-coded usage (green < 60 %, amber < 85 %,
red ≥ 85 %). A scheme toggle (`◐ auto / ☀ light / ☾ dark`) follows your OS/browser
scheme by default and remembers the choice; the text table, toasts, and session cards
show a matching 24-slot sparkline (`▓` peak / `░` off-peak / `▮` now).

| Route | Description |
|---|---|
| `/` | Live dashboard (auto-refresh 30 s) |
| `/api/status` | JSON: provider states, windows, day-bar segments, countdowns, clocks, usage snapshot |
| `/api/usage` | JSON: raw per-source quota/balance snapshots |
| `/peakhours.txt` | Plain-text table — what the `/peakhours` command injects |

### Authentication

By default the dashboard binds `0.0.0.0` (reachable from your LAN) and **mirrors
opencode web's own protection**: if `OPENCODE_SERVER_PASSWORD` is set, every dashboard
route requires HTTP Basic auth with `OPENCODE_SERVER_USERNAME` (default `opencode`) —
the same credentials as opencode web itself, so the browser prompts once and the
`/peakhours` command's `curl` picks the credentials up from the environment
automatically. Without a password the server stays open; the plugin then logs a
one-time warning, disables cross-origin access (`Access-Control-Allow-Origin: *` is
only sent on loopback binds), and shows the LAN URL it is reachable on. Set
`PEAKHOURS_HOSTNAME=127.0.0.1` to restrict the dashboard to localhost.

## Quota / balance / spend polling

**Yes — most providers expose this.** The plugin polls each provider's own account
API (the same endpoints their consoles use) and displays plan names, 5-hour /
weekly / monthly windows (percent, counts, reset countdowns) and PAYG balances
alongside the peak-hours table. It stays **completely inert until it finds at least
one API key** — in plugin options, the environment, or OpenCode's own credential
store (next section).

### Zero-config: use the keys OpenCode already stores

**You usually don't need extra environment variables.** The plugin reuses the API
keys OpenCode itself keeps. If a provider was logged in via `opencode auth login`
(or its standard env var is exported), the quota & balance section turns on by
itself:

```bash
opencode auth login          # pick e.g. "DeepSeek", "Z.AI Coding Plan", "Kimi For Coding"
# no restart needed — the plugin picks it up on its next refresh (≤ usage.refreshMin)
```

| Plugin source | `opencode auth login` provider id | Fallback env var |
|---|---|---|
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| z.ai | `zai-coding-plan`, `zai` | `ZHIPU_API_KEY`, `ZAI_API_KEY` |
| Kimi Code | `kimi-for-coding` | `KIMI_API_KEY` |
| Moonshot | `moonshotai` (cn region prefers `moonshotai-cn`) | `MOONSHOT_API_KEY` |
| MiniMax | `minimax-coding-plan`, `minimax` (cn region prefers the `-cn-` ids) | `MINIMAX_API_KEY` |
| OpenCode Zen | `opencode`, `opencode-go` | `OPENCODE_API_KEY` |

Resolution order per source — first hit wins:

1. `usage.keys.*` in the plugin options
2. `PEAKHOURS_<SOURCE>_API_KEY` environment variables
3. **OpenCode's credential store** — `auth.json` in the opencode data dir
   (`$XDG_DATA_HOME/opencode/auth.json` or `~/.local/share/opencode/auth.json`;
   `OPENCODE_AUTH_CONTENT` is honored too, mirroring opencode's own behavior)
4. Standard provider env vars (`DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, ...)

Notes:

- The store is read **read-only** (opencode writes it with `0600`) and re-checked on
  every refresh cycle — a fresh `opencode auth login` or key rotation is picked up
  without restarting opencode. OAuth-only entries (e.g. GitHub Copilot) are ignored.
- The OpenCode SDK/server API deliberately exposes no key-reading endpoint (only
  `POST /auth/{id}` to set), which is why the plugin reads the store file directly.
- Keys are never logged or rendered. Diagnostics (`GET /api/usage` → `keys[]`, the
  dashboard cards) show only the origin — `opencode auth`, `env NAME`, `options` —
  plus the **last 4 characters** of the key.
- Opt out with `usage.authStore: false` / `PEAKHOURS_USAGE_AUTH_STORE=0` — then only
  options + `PEAKHOURS_*` env vars are used.

### Where to get each key

Prefer zero config? Skip this table and use OpenCode's stored credentials (section
above) — the table below is for explicit or standalone setup.

| Provider | Key source | Env var | What you get |
|---|---|---|---|
| **DeepSeek API** | [platform.deepseek.com](https://platform.deepseek.com) → API keys | `PEAKHOURS_DEEPSEEK_API_KEY` | `GET api.deepseek.com/user/balance`: availability + per-currency `total / granted / topped_up` balance |
| **z.ai GLM Coding Plan** | z.ai open-platform console (global) or [bigmodel.cn](https://open.bigmodel.cn) (CN) | `PEAKHOURS_ZAI_API_KEY` | `GET api.z.ai/api/monitor/usage/quota/limit`: plan name + `limits[]` — 5-hour token/credit window, weekly, MCP window: percent used, remaining, next reset |
| **Kimi Code** (subscription) | [kimi.com/code/console](https://www.kimi.com/code/console) | `PEAKHOURS_KIMI_CODE_API_KEY` | `GET api.kimi.com/coding/v1/usages`: weekly request pool + 5-hour rate-limit windows with reset times |
| **Moonshot Open Platform** (PAYG) | [platform.moonshot.ai](https://platform.moonshot.ai) (global) or [platform.moonshot.cn](https://platform.moonshot.cn) (CN) | `PEAKHOURS_MOONSHOT_API_KEY` | `GET .../v1/users/me/balance`: `available / voucher / cash` balance (USD / CNY) |
| **MiniMax Token Plan** | [platform.minimax.io](https://platform.minimax.io) (global) or [platform.minimaxi.com](https://platform.minimaxi.com) (CN) | `PEAKHOURS_MINIMAX_API_KEY` (alias `PEAKHOURS_MINIMAX_CODING_API_KEY`) | `GET .../v1/token_plan/remains` (fallback `.../v1/api/openplatform/coding_plan/remains`): per-model 5-hour + weekly remaining quota, boost multiplier, reset times |
| **OpenCode Zen** | [opencode.ai/zen](https://opencode.ai/zen) — or reuse the key OpenCode already stores | `PEAKHOURS_ZEN_API_KEY` (falls back to `OPENCODE_API_KEY`) | `GET opencode.ai/zen/go/v1/usage`: rolling 5-hour / weekly / monthly usage percent + reset |

Set a key either as an environment variable or under `usage.keys.*`:

```bash
# e.g. in your shell profile
export PEAKHOURS_ZAI_API_KEY="..."
export PEAKHOURS_DEEPSEEK_API_KEY="..."
```

```jsonc
{
  "plugin": [
    ["./.opencode/plugins/opencode-quotas.ts", {
      "usage": { "minBalance": 5, "alertPct": 80,
                 "keys": { "zai": "<key>", "deepseek": "<key>" } }
    }]
  ]
}
```

### Polling options

| Option | Env var | Default | Meaning |
|---|---|---|---|
| `usage.enabled` | `PEAKHOURS_USAGE` | `true` | Poll provider usage APIs (inert without keys). |
| `usage.refreshMin` | `PEAKHOURS_USAGE_REFRESH_MIN` | `5` | Refresh interval in minutes (min 1; first poll runs ~1.5 s after startup). |
| `usage.timeoutSec` | `PEAKHOURS_USAGE_TIMEOUT` | `8` | Per-request timeout. |
| `usage.alertPct` | `PEAKHOURS_USAGE_ALERT_PCT` | `80` | `warning` toast when a window is ≥ this % used; `0` disables. |
| `usage.minBalance` | `PEAKHOURS_MIN_BALANCE` | off | `error` toast when a PAYG balance falls to/below this value. |
| `usage.keys.*` | per-source env vars above | — | Key ids: `deepseek`, `zai`, `kimi`, `moonshot`, `minimax`, `zen`. |
| `usage.zaiRegion` | `PEAKHOURS_ZAI_REGION` | `global` | `global` (api.z.ai) or `cn` (open.bigmodel.cn). |
| `usage.moonshotRegion` | `PEAKHOURS_MOONSHOT_REGION` | `global` | `global` (api.moonshot.ai) or `cn` (api.moonshot.cn, CNY). |
| `usage.minimaxRegion` | `PEAKHOURS_MINIMAX_REGION` | `global` | `global` (api.minimax.io) or `cn` (api.minimaxi.com). |
| `usage.authStore` | `PEAKHOURS_USAGE_AUTH_STORE` | `true` | Also resolve keys from OpenCode's credential store (`auth.json` / `OPENCODE_AUTH_CONTENT`) and standard provider env names. |

**Security:** keys are used read-only, never logged, and are only ever sent over
HTTPS to the provider they belong to. Keys taken from OpenCode's auth store are
handled the same way — the store file is opened read-only, and diagnostics show
only the origin and the last 4 characters. A failed refresh keeps the last good
data and surfaces the error instead of wiping the display.

### Notes and limitations (verified 2026-09-17)

- **DeepSeek** exposes only balance over its public API; per-day token/cost breakdowns
  live on private `platform.deepseek.com` dashboard endpoints that require a browser
  session token (not your API key), so the plugin deliberately does not call them.
- **Kimi Code ≠ Moonshot Open Platform**: subscription quota (`api.kimi.com/coding/v1/usages`)
  and PAYG balance (`api.moonshot.ai/v1/users/me/balance`) are separate credentials.
- **MiniMax** mislabels its remaining-quota fields as `current_*_usage_count` — the
  plugin already handles the inversion.
- The Kimi Code / z.ai / MiniMax endpoints are stable but not formally versioned;
  if a provider changes its payload shape, only the small per-provider parser in
  `opencode-quotas.ts` needs an update.

## Configuration reference

Options object (config `plugin` entry) wins over environment variables.

| Option | Env var | Default | Meaning |
|---|---|---|---|
| `port` | `PEAKHOURS_PORT` | `4117` | Companion server port; `0` disables it. If busy, the next 9 ports are tried. |
| `hostname` | `PEAKHOURS_HOSTNAME` | `0.0.0.0` | Companion server bind address. Use `127.0.0.1` for loopback-only access (see *Authentication* below). |
| `leadMinutes` | `PEAKHOURS_LEAD_MINUTES` | `15` | Lead-time alert before a window flips; `0` disables alerts. |
| `toastOnConnect` | `PEAKHOURS_TOAST_ON_CONNECT` | `true` | Compact status toast when a client attaches. |
| `cardOnSessionStart` | `PEAKHOURS_SESSION_CARD` | `true` | Post the markdown card into new top-level sessions (child/subagent sessions are skipped). |
| `command` | `PEAKHOURS_COMMAND` | `true` | Register the `/peakhours` command. |
| `notify` | `PEAKHOURS_NOTIFY` | `false` | Also fire desktop notifications on transitions (`osascript` / `notify-send`). |
| `providers` | `PEAKHOURS_PROVIDERS` | all | Comma-separated id filter, e.g. `deepseek,zai`. |
| `custom` | — | — | Array of extra `ProviderDef`s (see below). Always shown regardless of `onlyConfigured`. |
| `onlyConfigured` | `PEAKHOURS_ONLY_CONFIGURED` | `true` | Show only providers whose usage source has a resolved API key (keys are re-checked every refresh, so the list follows `opencode auth login` live). With no keys at all, displays show a hint instead of an empty table. |
| `usage` | `PEAKHOURS_USAGE*` | — | See *Polling options* above. |
| `disabled` | `PEAKHOURS_DISABLE` | `false` | Kill switch — disables everything. |

Boolean env vars accept `1/true/on/yes` vs `0/false/off/no`.

### Custom providers

Append your own provider (any IANA timezone; windows may wrap past midnight):

```jsonc
{
  "plugin": [
    ["./.opencode/plugins/opencode-quotas.ts", {
      "custom": [{
        "id": "example", "name": "Example AI", "scope": "api",
        "tz": "America/New_York",
        "peakWindows": [{ "days": [1,2,3,4,5], "start": "09:00", "end": "17:00" }],
        "benefit": "Half price outside these hours.",
        "source": "https://example.com/pricing", "checked": "2026-09-17"
      }]
    }]
  ]
}
```

## Provider data (verified 2026-09-17)

Peak windows are stored in the provider's own timezone and converted with `Intl`
(DST-safe). "Off-peak" is simply time outside the listed peak windows.

| Provider | Scope | Peak window | Off-peak benefit | Source |
|---|---|---|---|---|
| **DeepSeek API** | API pricing | **Mon–Fri 01:00–04:00 & 06:00–10:00 UTC** | Prices are **half** of peak rates (e.g. `deepseek-flash` input $0.15 vs $0.30 / 1M cache-miss; output $0.60 vs $1.20) | [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| **z.ai GLM Coding Plan** | Plan quota | **Mon–Fri 14:00–18:00 Asia/Singapore (UTC+8)** | Credits burn at **0.5×**; GLM-5.3 quota **1×** off-peak vs **3×** peak; GLM-5.3-Flash **0.4×** vs **1.2×**; **weekends are all-day off-peak**; higher concurrency off-peak | [docs.z.ai/devpack/overview](https://docs.z.ai/devpack/overview) · [usage-revision](https://docs.z.ai/devpack/notice/usage-revision.md) |
| **Kimi Code (Moonshot)** | Congestion | **Mon–Fri 14:00–17:00 Asia/Shanghai** *(tz not stated in docs — assumed)* | 429 "inference engine overloaded" errors are far less likely; no price discount; quota = 5-hour rolling + weekly windows | [kimi.com/code/docs → Error Reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html) |
| **MiniMax Token Plan** | — | None published | Quota runs on **5-hour rolling + weekly** windows; FAQ only mentions dynamic throttling during "peak traffic" | [platform.minimax.io/docs/token-plan/faq](https://platform.minimax.io/docs/token-plan/faq.md) |

> Historical note: DeepSeek's old off-peak discount window (UTC 16:30–00:30, 50–75% off)
> is **obsolete** — the current pricing page defines peak as the two weekday UTC windows
> above. Check `PROVIDERS` in `opencode-quotas.ts` when policies change and update the
> windows there (the `checked` date marks verification).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No toasts at all | Toasts only work while a TUI client is attached (`/tui/show-toast` exists only then). In web-only/headless mode use the session card or dashboard instead. |
| Welcome toast shows a different port | Port 4117 was busy; the plugin tried the next 9 ports. The actual URL is in the toast and session card. |
| `/peakhours` shows `PEAKHOURS_SERVER_UNREACHABLE` | The companion server is disabled (`port: 0`), stopped, or `curl` is missing / slower than the 2 s template timeout. With authentication enabled, the shell that runs the command must also have `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` exported (the template reads them from the environment). |
| Dashboard asks for username/password | `OPENCODE_SERVER_PASSWORD` is set — the dashboard shares opencode web's Basic auth. Use `OPENCODE_SERVER_USERNAME` (default `opencode`) and that password. |
| No providers shown (only a hint line) | `onlyConfigured` is on and no provider has a resolved API key — run `opencode auth login` or set a `PEAKHOURS_<PROVIDER>_API_KEY`, or set `onlyConfigured: false`. |
| Quota & balance section is missing | No API key found in options, env, or OpenCode's auth store — the polling stays inert by design. Run `opencode auth login` or set a `PEAKHOURS_*` var. |
| Key added via `opencode auth login` is not picked up | The store id does not map to a source (see the mapping table above), `usage.authStore` is off, or `OPENCODE_AUTH_CONTENT` is overriding the file (opencode honors that env var too). Check `GET /api/usage` → `keys[]` to see what the plugin resolved. |
| A provider shows an error or stale data | Wrong key or wrong region (`global` vs `cn`). The last good snapshot is kept and the error is surfaced on the dashboard. |
| No card in a session | It was a child/subagent session (skipped by design), or `cardOnSessionStart` is off. |
| Window times look wrong for a provider | Policies changed — update `PROVIDERS` in `opencode-quotas.ts` or override via the `custom` option (the `checked` date marks the last verification). |

## How it works (research summary)

- Plugins are TS/JS files in `~/.config/opencode/plugins/` or `.opencode/plugins/`,
  auto-loaded at startup; the plugin receives `{ project, client, $, directory, worktree }`
  and returns hooks (`event`, `config`, `chat.*`, `tool.*`, `dispose`, ...).
  **opencode 1.18.x loader contract (verified):** the default export must be shaped
  `{ id, setup, server }` (this file's shape) so both bundled loaders accept it — the
  v1 server loader calls `server(input, options)` and aborts with
  *"Plugin export is not a function"* if **any** runtime export is not a function;
  the v2 loader only accepts `default = { id, effect | setup }` and **silently drops**
  the plugin otherwise. Data consts (`PROVIDERS`, ...) are therefore module-local.
- The TUI is a client of the opencode server; plugins run server-side and drive the
  TUI over HTTP: `client.tui.showToast()` → `POST /tui/show-toast`
  (`{ title?, message, variant: info|success|warning|error, duration? }`).
- `client.session.prompt({ path: { id }, body: { parts: [...], noReply: true } })`
  appends a message to a session **without triggering a model reply** — the key to a
  zero-cost in-app card that renders in both TUI and web UI.
- Custom commands normally send their template to the model; `` !`shell` `` injection
  inside the template fetches `/peakhours.txt` from the companion server so the table
  is always live. The instant toast (via the `tui.command.execute` event) gives the
  same data with no model round-trip.
- Quota polling calls each provider's own account endpoints with an `AbortController`
  timeout, 401/403 fast-fail, and a MiniMax two-endpoint fallback; responses are run
  through defensive parsers (s/ms/µs epochs, ISO timestamps, stringified numbers).
  Keys resolve per source from plugin options → `PEAKHOURS_*` env → OpenCode's own
  credential store (`auth.json`, written by `opencode auth login`; cached by mtime
  so logins/rotations are picked up live) → standard provider env names.

## Files

- `opencode-quotas.ts` — the plugin (drop-in single file)
- `README.md` — this file

## Verify locally (optional)

```bash
npm i -D typescript @opencode-ai/plugin @opencode-ai/sdk @types/node
npx tsc --noEmit --strict --skipLibCheck opencode-quotas.ts
```
