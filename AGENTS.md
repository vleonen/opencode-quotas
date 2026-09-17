# AGENTS.md

## What this is

Single-file OpenCode plugin: `opencode-quotas.ts` (~1.8k lines) shows provider peak/off-peak
hours and polls live quota/balance APIs. No build step, no package.json, zero runtime
dependencies — by design. `README.md` is comprehensive and mirrors internals.

## Hard constraints

- All changes go into `opencode-quotas.ts`. Imports stay type-only + `node:` builtins only.
  Never add an npm runtime dependency or a build step.
- `README.md` mirrors internals (option tables, env vars, provider windows, key
  resolution order, troubleshooting). When changing options/behavior/provider data,
  update both the code and the matching README tables.
- Provider peak-window data lives in the `PROVIDERS` const; each entry carries a
  `checked` verification date. Policy changes = edit `PROVIDERS` + README provider
  table + bump the date.
- No tests, lint, or CI exist. Don't scaffold them unless asked.

## Typecheck (only verification step)

The README's short `npx tsc --noEmit --strict --skipLibCheck opencode-quotas.ts` command is
insufficient. Verified working:

```bash
npm i -D typescript@5 @opencode-ai/plugin @opencode-ai/sdk @types/node
npx tsc --noEmit --strict --skipLibCheck \
  --module esnext --moduleResolution bundler --target es2022 --types node opencode-quotas.ts
```

- Pin `typescript@5` — v7 (native) doesn't auto-load `@types/node` in file mode.
- `--moduleResolution bundler` is required to resolve `@opencode-ai/plugin` types;
  `--target es2022+` is required for Set/Map iteration under `--strict`.
- This creates `package.json`/`node_modules` — dev-only, don't commit them (run in a
  scratch copy of the repo to keep it clean).

## Testing changes live

Plugins load at startup; there is no hot reload. To try a change: copy `opencode-quotas.ts`
to `~/.config/opencode/plugins/` (global) or `<project>/.opencode/plugins/` and restart
opencode. Verify via the welcome toast, the `/quotas` command,
`curl http://127.0.0.1:4117/api/status`, or the dashboard (default port 4117; plugin
takes the next free port if busy). This repo's own `.opencode/` does not load the
plugin — it only holds gitignored dev deps.

## Code map (sections of opencode-quotas.ts, in order)

1. Types (`OpencodeQuotasOptions`, `ProviderDef`, ...) and `PROVIDERS` data.
2. Time math: tz-aware window evaluation via `Intl` (`zonedParts`, `inPeakAt`,
   `boundaries`) — pure, exported.
3. Rendering: `toastStatus`, `textTable`, `markdownCard`.
4. Usage/quota: defensive per-provider parsers, `USAGE_SOURCES` registry,
   `fetchUsageSnapshot`, key resolution = options → `OPENCODE_QUOTAS_*` env → OpenCode
   `auth.json` credential store (read-only, cached by mtime) → standard provider env.
5. Companion server (`startCompanionServer`): Bun.serve with `node:http` fallback;
   routes `/`, `/api/status`, `/api/usage`, `/opencode-quotas.txt`.
6. `OpencodeQuotasPlugin` (default export) — entrypoint wiring hooks/timers; the
   `/quotas` command is registered via the `config` hook.

## Gotchas

- Toasts (`client.tui.showToast`) only work while a TUI client is attached; the calls
  fail silently in web-only/headless mode.
- Session cards use `client.session.prompt` with `noReply: true` — must never trigger
  a model reply (zero-token requirement).
- API keys are never logged or rendered; diagnostics show only origin + last 4 chars.

## opencode 1.18.x plugin loader contract (verified 2026-09-17)

- The default export must stay shaped `{ id, setup, server }` (wrapping
  `OpencodeQuotasPlugin`): the v1 server loader calls `server(input, options)`, the v2
  loader decodes `{ id, effect | setup }` and **silently drops** anything else
  (`Effect.ignoreCause`) — a wrong shape = plugin never loads, no error.
- The v1 loader treats **every runtime export** as a plugin factory and aborts with
  `"Plugin export is not a function"` if any export is not a function. Keep `PROVIDERS`,
  `USAGE_SOURCES`, etc. module-local (no `export`) — only the factory + default export
  are exported. Functions being exported is fine but unnecessary.
- A `["path", {options}]` pair in config `plugin` was silently ignored (plugin never
  loaded) on 1.18.30 — install via a plugins directory instead; options then come
  from `OPENCODE_QUOTAS_*` env vars only.
- npm plugin specs (`"some-package"` in config) make opencode run an arborist install
  (network) on startup unless `~/.cache/opencode/packages/<pkg>/node_modules/<name>`
  exists; a spec whose install keeps failing slows every startup (the oh-my-openagent
  case: 38 MB re-attempted per boot). Check `~/.config/opencode/tui.json`,
  `~/.opencode/opencode.json`, project `.opencode/opencode.json`, and the global
  `opencode.jsonc` for stray `plugin` entries.
- Live-test plugin loading headlessly: `timeout 30 opencode web --port 47142` in a
  scratch dir, then `curl 127.0.0.1:4117/api/status`. TUI-spawned instances use the
  v2 loader, `opencode web` the v1 one — test the path you actually run.
- opencode creates plugin instances **lazily per directory** — a freshly booted web
  instance runs no plugin until a client touches a directory, and each directory gets
  its own companion server (ports fall through 4117, 4118, ...). When a long-running
  instance squats the whole 411x range, test the server directly instead: the module
  is dependency-free, so `bun -e 'await import(".../opencode-quotas.ts")'` + calling
  the default export's `server(input, options)` reproduces the v1 loader exactly.
- The dashboard binds `0.0.0.0` by default and mirrors opencode web auth:
  `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME`, default `opencode`)
  enables HTTP Basic auth on all routes; the `/quotas` curl template injects
  `-u` from the environment (never the secret itself).
