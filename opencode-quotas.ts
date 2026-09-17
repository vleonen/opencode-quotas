/**
 * opencode-quotas.ts — OpenCode plugin that surfaces model-provider peak / off-peak hours.
 *
 * Drop-in single file. Copy to ~/.config/opencode/plugins/opencode-quotas.ts (global)
 * or .opencode/plugins/opencode-quotas.ts (project) and restart opencode. No build step,
 * no npm dependencies (type-only imports are erased at runtime; runtime imports
 * are node builtins only).
 *
 * What it does:
 *  - Toast in the TUI when a client connects (compact status of every provider).
 *  - Lead-time toast before a provider enters / leaves its peak window (default 15 min).
 *  - Registers a /quotas command (via the config hook, no opencode.json edits needed)
 *    that fires an instant toast AND echoes a live status table through the model.
 *  - Posts a markdown status card into every new session (visible in TUI and web UI),
 *    using a no-reply synthetic message so it costs zero model tokens.
 *  - Serves a live companion page + JSON API on http://127.0.0.1:4117 (Bun.serve,
 *    node:http fallback) for browsers / the opencode web UI.
 *  - Optionally polls each provider's own account API for subscription quota /
 *    budget / balance (DeepSeek, z.ai, Kimi Code, Moonshot, MiniMax, OpenCode Zen)
 *    and renders it next to the peak-hours data — including low-quota alerts.
 *  - Resolves those API keys with zero config: plugin options -> OPENCODE_QUOTAS_* env ->
 *    OpenCode's own credential store (auth.json written by `opencode auth login`,
 *    or OPENCODE_AUTH_CONTENT) -> standard provider env (DEEPSEEK_API_KEY, ...).
 *
 * Configure via plugin options in opencode.json  —  e.g.
 *   { "plugin": [ [ "./.opencode/plugins/opencode-quotas.ts", { "port": 4117, "leadMinutes": 15 } ] ] }
 * or via environment variables (see README): OPENCODE_QUOTAS_PORT, OPENCODE_QUOTAS_LEAD_MINUTES,
 * OPENCODE_QUOTAS_DEEPSEEK_API_KEY, OPENCODE_QUOTAS_ZAI_API_KEY, OPENCODE_QUOTAS_KIMI_CODE_API_KEY, ...
 *
 * Provider data was verified against official docs on 2026-09-17 (see PROVIDERS + README).
 */

import fsSync from "node:fs"
import osMod from "node:os"
import pathMod from "node:path"

import type { Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WindowDef = {
  /** Weekdays covered by the window, 0 = Sunday ... 6 = Saturday, in the provider timezone. */
  days: number[]
  /** Window start, "HH:MM", in the provider timezone. */
  start: string
  /** Window end, "HH:MM", provider timezone. May wrap past midnight (end <= start). */
  end: string
}

export type ProviderDef = {
  id: string
  name: string
  /** Kind of "peak" this provider publishes. */
  scope: "api" | "plan" | "congestion" | "none"
  /** IANA timezone the windows are defined in. */
  tz: string
  /** PEAK windows. Empty list = the provider publishes no fixed peak hours. */
  peakWindows: WindowDef[]
  /** What you gain outside peak hours. */
  benefit: string
  /** Multipliers, caveats, assumptions. */
  note?: string
  models?: string[]
  /** Official source page for the data. */
  source: string
  /** Date the data was last verified against the source. */
  checked: string
}

export type OpencodeQuotasOptions = {
  /** Companion server port. 0 disables the server. Default 4117 (env OPENCODE_QUOTAS_PORT). */
  port?: number
  /** Companion server bind address. Default "0.0.0.0" (env OPENCODE_QUOTAS_HOSTNAME); use 127.0.0.1 for loopback only. */
  hostname?: string
  /** Warn N minutes before a window flips; 0 disables alerts. Default 15 (env OPENCODE_QUOTAS_LEAD_MINUTES). */
  leadMinutes?: number
  /** Show a compact status toast when a TUI/web client connects. Default true (env OPENCODE_QUOTAS_TOAST_ON_CONNECT). */
  toastOnConnect?: boolean
  /** Post a markdown status card into every new top-level session. Default true (env OPENCODE_QUOTAS_SESSION_CARD). */
  cardOnSessionStart?: boolean
  /** Register the /quotas command. Default true (env OPENCODE_QUOTAS_COMMAND). */
  command?: boolean
  /** Also fire desktop notifications on transitions. Default false (env OPENCODE_QUOTAS_NOTIFY). */
  notify?: boolean
  /** Only track these provider ids. Default: all built-ins (env OPENCODE_QUOTAS_PROVIDERS=deepseek,zai). */
  providers?: string[]
  /** Extra user-defined providers appended to the registry. Always shown regardless of onlyConfigured. */
  custom?: ProviderDef[]
  /** Show only providers whose usage source has a resolved API key. Default true (env OPENCODE_QUOTAS_ONLY_CONFIGURED). */
  onlyConfigured?: boolean
  /** Live quota / balance / spend polling (see UsageOptions). */
  usage?: UsageOptions
  /** Disable everything. Default false (env OPENCODE_QUOTAS_DISABLE). */
  disabled?: boolean
}

// ---------------------------------------------------------------------------
// Provider registry — verified against official documentation on 2026-09-17.
// Update windows here (or via `custom` options) when providers change policy.
// ---------------------------------------------------------------------------

const MON_FRI = [1, 2, 3, 4, 5]

const PROVIDERS: ProviderDef[] = [
  {
    id: "deepseek",
    name: "DeepSeek API",
    scope: "api",
    tz: "UTC",
    peakWindows: [
      { days: MON_FRI, start: "01:00", end: "04:00" },
      { days: MON_FRI, start: "06:00", end: "10:00" },
    ],
    benefit: "Off-peak prices are HALF peak rates (e.g. deepseek-flash input $0.15 vs $0.30 per 1M cache-miss tokens).",
    note: "Off-peak = all hours outside Mon-Fri 01:00-04:00 & 06:00-10:00 UTC. The old 16:30-00:30 UTC discount window is obsolete.",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    checked: "2026-09-17",
  },
  {
    id: "zai",
    name: "z.ai GLM Coding Plan",
    scope: "plan",
    tz: "Asia/Singapore",
    peakWindows: [{ days: MON_FRI, start: "14:00", end: "18:00" }],
    benefit: "Off-peak: credits burn at 0.5x; GLM-5.3 quota 1x (vs 3x peak), GLM-5.3-Flash 0.4x (vs 1.2x); weekends are all-day off-peak.",
    note: "Plan users also get dynamically raised concurrency limits off-peak. Pay-as-you-go GLM API has no peak pricing.",
    models: ["glm-5.3", "glm-5.2", "glm-5.3-flash"],
    source: "https://docs.z.ai/devpack/overview + https://docs.z.ai/devpack/notice/usage-revision.md",
    checked: "2026-09-17",
  },
  {
    id: "kimi",
    name: "Kimi Code (Moonshot)",
    scope: "congestion",
    tz: "Asia/Shanghai",
    peakWindows: [{ days: MON_FRI, start: "14:00", end: "17:00" }],
    benefit: "Outside the congestion window, 429 'inference engine overloaded' errors are far less likely.",
    note: "Congestion window only - no price discount. Docs do not state the timezone; Asia/Shanghai assumed. Quota: 5-hour rolling + weekly windows.",
    models: ["kimi-k3", "kimi-k2.7-code"],
    source: "https://www.kimi.com/code/docs/en/kimi-code/error-reference.html",
    checked: "2026-09-17",
  },
  {
    id: "minimax",
    name: "MiniMax Token Plan",
    scope: "none",
    tz: "Asia/Shanghai",
    peakWindows: [],
    benefit: "No fixed peak hours published; quota runs on 5-hour rolling + weekly windows that reset continuously.",
    note: "Official FAQ only notes throttling 'may tighten during peak traffic' (dynamic, no published clock hours).",
    models: ["minimax-m3", "minimax-m2.7"],
    source: "https://platform.minimax.io/docs/token-plan/faq.md",
    checked: "2026-09-17",
  },
]

// ---------------------------------------------------------------------------
// Timezone-aware window engine (no dependencies; DST-safe via Intl)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function zoneFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    fmtCache.set(tz, f)
  }
  return f
}

export type ZonedParts = { y: number; mo: number; d: number; hh: number; mm: number; weekday: number; minutes: number }

/** Wall-clock parts of an instant in a timezone. weekday: 0 = Sunday ... 6 = Saturday. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = zoneFmt(tz).formatToParts(date)
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const y = g("year")
  const mo = g("month")
  const d = g("day")
  const hh = g("hour") % 24 // guard "24" in some ICU edge cases
  const mm = g("minute")
  return { y, mo, d, hh, mm, weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), minutes: hh * 60 + mm }
}

/** Offset of `tz` from UTC in minutes at the given instant (positive = east of UTC). */
export function tzOffsetMin(date: Date, tz: string): number {
  const p = zonedParts(date, tz)
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm)
  // Compare against the instant truncated to the MINUTE (zonedParts drops seconds,
  // so truncating to seconds would make the offset drift by 1 min for the second
  // half of every minute).
  const minuteFloor = Math.floor(date.getTime() / 60000) * 60000
  return Math.round((asUTC - minuteFloor) / 60000)
}

/** Convert a wall-clock time in `tz` to a UTC epoch (handles DST via fixed-point iteration). */
export function wallToEpoch(tz: string, y: number, mo: number, d: number, hh: number, mm: number): number {
  let guess = Date.UTC(y, mo - 1, d, hh, mm)
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMin(new Date(guess), tz)
    guess = Date.UTC(y, mo - 1, d, hh, mm) - off * 60000
  }
  return guess
}

function toMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return 0
  const h = Math.min(23, Number(m[1]))
  return h * 60 + Math.min(59, Number(m[2]))
}

/** Is the instant inside one of the provider's PEAK windows? Handles windows that wrap past midnight. */
export function inPeakAt(pv: ProviderDef, date: Date): boolean {
  if (!pv.peakWindows.length) return false
  const p = zonedParts(date, pv.tz)
  for (const w of pv.peakWindows) {
    const s = toMin(w.start)
    const e = toMin(w.end)
    if (e > s) {
      if (w.days.includes(p.weekday) && p.minutes >= s && p.minutes < e) return true
    } else {
      // wraps: peak runs from `start` on w.days to `end` on the following day
      const prevDay = (p.weekday + 6) % 7
      if (w.days.includes(p.weekday) && p.minutes >= s) return true
      if (w.days.includes(prevDay) && p.minutes < e) return true
    }
  }
  return false
}

export type Boundary = { at: number; toPeak: boolean }

/** Peak segments (minutes-of-day, provider tz) covering "today", plus the current minute. */
export type DaySegments = { segments: Array<[number, number]>; nowMin: number; nowLabel: string }

/** Today's peak segments in the provider tz — windows clipped to [0,1440), midnight wraps split. */
export function daySegments(pv: ProviderDef, now: number = Date.now()): DaySegments {
  const p = zonedParts(new Date(now), pv.tz)
  const segments: Array<[number, number]> = []
  for (const w of pv.peakWindows) {
    const s = toMin(w.start)
    const e = toMin(w.end)
    if (e > s) {
      if (w.days.includes(p.weekday)) segments.push([s, e])
    } else {
      if (w.days.includes(p.weekday)) segments.push([s, 1440])
      const prevDay = (p.weekday + 6) % 7
      if (w.days.includes(prevDay) && e > 0) segments.push([0, e])
    }
  }
  segments.sort((a, b) => a[0] - b[0])
  return { segments, nowMin: p.minutes, nowLabel: fmtClock(now, pv.tz) }
}

/** 24-char midnight-aligned sparkline for the provider tz: ▓ peak hour, ░ off-peak, ▮/▯ = now. */
export function sparkline24(pv: ProviderDef, now: number = Date.now()): string {
  const { segments, nowMin } = daySegments(pv, now)
  const cells: string[] = []
  for (let h = 0; h < 24; h++) {
    const mid = h * 60 + 30
    cells.push(segments.some(([s, e]) => mid >= s && mid < e) ? "▓" : "░")
  }
  const nowIdx = Math.min(23, Math.floor(nowMin / 60))
  const inPeak = segments.some(([s, e]) => nowMin >= s && nowMin < e)
  cells[nowIdx] = inPeak ? "▮" : "▯"
  return cells.join("")
}

/** All peak start/end boundaries around `now` (-2 .. +8 days), sorted by epoch. */
export function boundaries(pv: ProviderDef, now: number): Boundary[] {
  if (!pv.peakWindows.length) return []
  const out: Boundary[] = []
  const base = zonedParts(new Date(now), pv.tz)
  const baseMidnightUTC = Date.UTC(base.y, base.mo - 1, base.d)
  for (let off = -2; off <= 8; off++) {
    const dayUTC = baseMidnightUTC + off * DAY_MS
    const dj = new Date(dayUTC)
    const y = dj.getUTCFullYear()
    const mo = dj.getUTCMonth() + 1
    const d = dj.getUTCDate()
    const weekday = dj.getUTCDay()
    for (const w of pv.peakWindows) {
      if (!w.days.includes(weekday)) continue
      const s = toMin(w.start)
      const e = toMin(w.end)
      out.push({ at: wallToEpoch(pv.tz, y, mo, d, Math.floor(s / 60), s % 60), toPeak: true })
      const endDay = e > s ? dayUTC : dayUTC + DAY_MS
      const ej = new Date(endDay)
      out.push({
        at: wallToEpoch(pv.tz, ej.getUTCFullYear(), ej.getUTCMonth() + 1, ej.getUTCDate(), Math.floor(e / 60), e % 60),
        toPeak: false,
      })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

export type ProviderStatus = {
  /** Currently inside a peak window? */
  peak: boolean
  /** Epoch when the current state began (null if unknown / no windows). */
  since: number | null
  /** Epoch of the next transition (null = no windows). */
  until: number | null
  /** What the next transition switches to. */
  toPeak: boolean | null
}

export function evaluate(pv: ProviderDef, now: number = Date.now()): ProviderStatus {
  if (!pv.peakWindows.length) return { peak: false, since: null, until: null, toPeak: null }
  const bnds = boundaries(pv, now)
  const peak = inPeakAt(pv, new Date(now))
  const next = bnds.find((b) => b.at > now) ?? null
  const prev = [...bnds].reverse().find((b) => b.at <= now) ?? null
  return { peak, since: prev?.at ?? null, until: next?.at ?? null, toPeak: next?.toPeak ?? null }
}

// ---------------------------------------------------------------------------
// Formatting / rendering
// ---------------------------------------------------------------------------

/** "HH:MM" of an instant, optionally in a given tz; without tz = viewer-local time. */
export function fmtClock(ms: number, tz?: string): string {
  const d = new Date(ms)
  return tz
    ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(d)
    : new Intl.DateTimeFormat("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(d)
}

/** "2h 05m", "42m", "3d 4h", "<1m" */
export function fmtDur(ms: number): string {
  const m = Math.floor(Math.abs(ms) / 60000)
  if (m < 1) return "<1m"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 48) return rm ? `${h}h ${String(rm).padStart(2, "0")}m` : `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** [1,2,3,4,5] -> "Mon-Fri"; [0,6] -> "Sun, Sat"; [0..6] -> "daily" */
export function fmtDays(days: number[]): string {
  if (days.length === 7) return "daily"
  const s = [...days].sort((a, b) => a - b)
  const contiguous = s.length > 1 && s.every((v, i) => i === 0 || v === s[i - 1] + 1)
  if (contiguous) return `${DAY_NAMES[s[0]]}-${DAY_NAMES[s[s.length - 1]]}`
  return s.map((d) => DAY_NAMES[d]).join(", ")
}

/** "UTC+8" / "UTC-5:30" / "UTC" — offset of the tz at the given instant. */
export function tzLabel(tz: string, at: number): string {
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC"
  const off = tzOffsetMin(new Date(at), tz)
  if (off === 0) return "UTC"
  const sign = off >= 0 ? "+" : "-"
  const a = Math.abs(off)
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`
}

export function windowLabel(w: WindowDef, tz: string, at: number): string {
  const wrap = toMin(w.end) <= toMin(w.start)
  const end = wrap ? `${w.end} +1d` : w.end
  return `${fmtDays(w.days)} ${w.start}-${end} ${tzLabel(tz, at)}`
}

export function scopeLabel(pv: ProviderDef): string {
  switch (pv.scope) {
    case "api":
      return "API pricing window"
    case "plan":
      return "subscription quota window"
    case "congestion":
      return "congestion window"
    default:
      return "no published clock hours"
  }
}

export type Enriched = {
  pv: ProviderDef
  status: ProviderStatus
  /** "peak" | "offpeak" | "none" */
  state: "peak" | "offpeak" | "none"
  windows: string[]
  untilLocal: string | null
  untilUtc: string | null
  countdown: string | null
  untilLabel: string | null
  /** 0..100 elapsed share of the current window (null when no fixed windows) */
  pct: number | null
}

export function enrich(providers: ProviderDef[], now: number = Date.now()): Enriched[] {
  return providers.map((pv) => {
    const status = evaluate(pv, now)
    const state: Enriched["state"] = pv.peakWindows.length === 0 ? "none" : status.peak ? "peak" : "offpeak"
    const windows = pv.peakWindows.map((w) => windowLabel(w, pv.tz, now))
    const untilLocal = status.until != null ? fmtClock(status.until) : null
    const untilUtc = status.until != null ? fmtClock(status.until, "UTC") : null
    const countdown = status.until != null ? fmtDur(status.until - now) : null
    const untilLabel =
      status.until != null && status.toPeak != null
        ? `${status.toPeak ? "peak" : "off-peak"} starts ${untilLocal} local (${untilUtc} UTC) — in ${countdown}`
        : null
    let pct: number | null = null
    if (status.since != null && status.until != null && status.until > status.since) {
      pct = Math.round(((now - status.since) / (status.until - status.since)) * 100)
    }
    return { pv, status, state, windows, untilLocal, untilUtc, countdown, untilLabel, pct }
  })
}

const STATE_TAG: Record<Enriched["state"], string> = {
  peak: "PEAK",
  offpeak: "OFF-PEAK",
  none: "no fixed windows",
}

/** Short tag for the "now" column: dash when the provider has no clock-hour windows. */
function nowTag(e: Enriched): string {
  return e.state === "none" ? "—" : STATE_TAG[e.state]
}

/** Shown when strict key filtering (onlyConfigured) leaves nothing to display. */
const EMPTY_PROVIDERS_HINT =
  "no providers shown — onlyConfigured is on and no provider has a configured API key. " +
  "Run 'opencode auth login <provider>' or set OPENCODE_QUOTAS_<PROVIDER>_API_KEY, " +
  "or set option onlyConfigured: false to always show every provider."

/** One line per provider, e.g. "DeepSeek API  PEAK · off-peak in 1h 55m". */
function providerLine(e: Enriched): string {
  const name = e.pv.name.padEnd(22)
  const next = e.untilLabel
    ? `next: ${e.status.toPeak ? "PEAK" : "off-peak"} ${e.countdown} (${fmtClock(e.status.until!)} local)`
    : "no transitions"
  return `${name} ${nowTag(e).padEnd(16)} ${next}\n  24h ${sparkline24(e.pv)}`
}

/** Compact multi-line status used for toasts. */
export function toastStatus(providers: ProviderDef[], now: number = Date.now()): string {
  if (!providers.length) return EMPTY_PROVIDERS_HINT
  return enrich(providers, now)
    .map(providerLine)
    .join("\n")
}

/** Plain-text table for the companion server (/opencode-quotas.txt) and the /quotas command. */
export function textTable(providers: ProviderDef[], now: number = Date.now(), usage: UsageSnapshot[] = []): string {
  const head = `Model provider peak-hours — ${fmtClock(now)} local · ${fmtClock(now, "UTC")} UTC`
  if (!providers.length) return `${head}\n${"".padEnd(head.length, "-")}\n${EMPTY_PROVIDERS_HINT}\n`
  const es = enrich(providers, now)
  const rows = es.map((e) => {
    const win = e.windows.length ? e.windows.join(" & ") : "no fixed peak hours published"
    const next = e.untilLabel ?? "-"
    return `${e.pv.name}  [${nowTag(e)}]\n  window : ${win}\n  24h    : ${sparkline24(e.pv)} (midnight-aligned, ${e.pv.tz})\n  next   : ${next}\n  benefit: ${e.pv.benefit}\n  source : ${e.pv.source} (verified ${e.pv.checked})`
  })
  const parts = [head, "".padEnd(head.length, "-"), ...rows]
  if (usage.length) {
    const lines = formatUsageLines(usage, now)
    if (lines.length) {
      parts.push("", "Quota & balance (live from provider account APIs)", "".padEnd(44, "-"), ...lines.map((l) => `  ${l}`))
    }
  } else {
    parts.push("", "quota & balance: no API keys found (not configured) — run 'opencode auth login <provider>' or set OPENCODE_QUOTAS_<PROVIDER>_API_KEY (see README)")
  }
  parts.push("")
  return parts.join("\n")
}

/** Markdown status card posted into new sessions; renders in TUI and web UI. */
export function markdownCard(providers: ProviderDef[], now: number = Date.now(), usage: UsageSnapshot[] = []): string {
  const head = `**Provider peak-hours** — ${fmtClock(now)} local · ${fmtClock(now, "UTC")} UTC`
  const usageMd = usageMarkdown(usage, now)
  if (!providers.length) return [head, "", `_${EMPTY_PROVIDERS_HINT}_`, "", ...(usageMd ? [usageMd, ""] : [])].join("\n")
  const es = enrich(providers, now)
  const rows = es.map((e) => {
    const name = `**${e.pv.name}**`
    const win = e.windows.length ? e.windows.join(" & ") : "no fixed windows"
    const next = e.untilLabel ?? "-"
    const ben = e.pv.benefit + (e.pv.note ? ` _(${e.pv.note})_` : "")
    return `| ${name} | ${nowTag(e)} | ${win} <br>\`${sparkline24(e.pv)}\` | ${next} | ${ben} |`
  })
  const sources = [...new Set(es.map((e) => e.pv.source))].join(", ")
  return [
    head,
    "",
    "| Provider | Now | Peak window (provider tz) | Next change | Off-peak benefit |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...(usageMd ? [usageMd, ""] : []),
    `Sources: ${sources}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Usage / quota / balance — live numbers pulled from each provider's own
// account endpoints (authenticated with the user's API key; keys are never
// logged and every request is an outbound HTTPS GET with a timeout).
//
//   DeepSeek    GET https://api.deepseek.com/user/balance
//               -> is_available + balance_infos[] (public, documented)
//   z.ai        GET https://api.z.ai/api/monitor/usage/quota/limit
//               (BigModel CN: https://open.bigmodel.cn/api/monitor/usage/quota/limit)
//               -> data.limits[] (5h tokens/credits, weekly, MCP) + plan name
//   Kimi Code   GET https://api.kimi.com/coding/v1/usages
//               -> weekly usage pool + limits[] rate windows (5-hour)
//   Moonshot    GET https://api.moonshot.ai | api.moonshot.cn /v1/users/me/balance
//               -> available / voucher / cash balance (PAYG open-platform keys)
//   MiniMax     GET https://api.minimax.io | api.minimaxi.com /v1/token_plan/remains
//               (fallback: /v1/api/openplatform/coding_plan/remains)
//               -> per-model interval + weekly remaining quota
//   OpenCode    GET https://opencode.ai/zen/go/v1/usage
//     Zen       -> rolling 5h / weekly / monthly percent + resetInSec
//
// Verified 2026-09-17 against official docs + reference implementations
// (DeepSeek API docs, Kimi Code docs, CodexBar zai/minimax/moonshot/deepseek docs).
// ---------------------------------------------------------------------------

export type UsageUnit = "requests" | "tokens" | "credits" | "currency"

export type UsageWindow = {
  label: string
  kind: "short" | "weekly" | "monthly" | "mcp" | "balance"
  /** 0..100, null when the API does not report it. */
  usedPercent: number | null
  used: number | null
  remaining: number | null
  total: number | null
  unit: UsageUnit | null
  /** Epoch ms when the window resets (null = no reset / not a window). */
  resetsAt: number | null
  currency?: string
  detail?: string
}

export type UsageStatus = "ok" | "error"

export type UsageSnapshot = {
  id: string
  name: string
  status: UsageStatus
  plan: string | null
  error: string | null
  fetchedAt: number | null
  windows: UsageWindow[]
}

export type UsageKeys = {
  deepseek?: string
  zai?: string
  kimi?: string
  moonshot?: string
  minimax?: string
  zen?: string
}

export type UsageRegion = "global" | "cn"

/** Fully-resolved usage config (after options + env merge). */
export type ResolvedUsageOptions = Required<
  Pick<UsageOptions, "enabled" | "refreshMin" | "timeoutSec" | "alertPct" | "minBalance" | "keys" | "authStore" | "zaiRegion" | "moonshotRegion" | "minimaxRegion">
>

export type UsageOptions = {
  /** Poll provider usage APIs. Default true (env OPENCODE_QUOTAS_USAGE); inert until a key is set. */
  enabled?: boolean
  /** Refresh interval in minutes (min 1). Default 5 (env OPENCODE_QUOTAS_USAGE_REFRESH_MIN). */
  refreshMin?: number
  /** Per-request timeout in seconds. Default 8 (env OPENCODE_QUOTAS_USAGE_TIMEOUT). */
  timeoutSec?: number
  /** Warn when a window is >= this percent used; 0 disables. Default 80 (env OPENCODE_QUOTAS_USAGE_ALERT_PCT). */
  alertPct?: number
  /** Toast when a PAYG balance falls to/below this value; null disables. (env OPENCODE_QUOTAS_MIN_BALANCE). */
  minBalance?: number | null
  /** API keys per source (highest precedence). Each also has a OPENCODE_QUOTAS_<SOURCE>_API_KEY
   *  env var; when neither is set, keys are auto-resolved from OpenCode's credential store
   *  and standard provider env names (see resolveUsageKey). */
  keys?: UsageKeys
  /** Also resolve keys from OpenCode's own credential store (auth.json written by
   *  `opencode auth login`, or OPENCODE_AUTH_CONTENT) and standard provider env names
   *  (DEEPSEEK_API_KEY, ZHIPU_API_KEY, ...). When false, only options + OPENCODE_QUOTAS_* env
   *  are used. Default true (env OPENCODE_QUOTAS_USAGE_AUTH_STORE). */
  authStore?: boolean
  /** z.ai endpoint region: global (api.z.ai) or cn (open.bigmodel.cn). Default global. */
  zaiRegion?: UsageRegion
  /** Moonshot region: global (api.moonshot.ai) or cn (api.moonshot.cn). Default global. */
  moonshotRegion?: UsageRegion
  /** MiniMax region: global (api.minimax.io) or cn (api.minimaxi.com). Default global. */
  minimaxRegion?: UsageRegion
}

// --- defensive JSON helpers (APIs change; never trust the payload) ----------

function jObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function jArr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null
}
function jStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null
}
function jNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}
/** Epoch in s / ms / us -> ms. */
function jEpoch(v: unknown): number | null {
  const n = jNum(v)
  if (n == null) return null
  if (n > 1e15) return Math.round(n / 1000)
  if (n > 1e12) return Math.round(n)
  if (n > 1e9) return Math.round(n * 1000)
  return null
}
/** ISO timestamp (tolerates >3-digit fractional seconds) -> epoch ms. */
function jIso(v: unknown): number | null {
  const s = jStr(v)
  if (!s) return null
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"))
  return Number.isFinite(t) ? t : null
}
const clampPct = (v: number): number => Math.max(0, Math.min(100, v))

function usageBase(id: string, name: string, now: number): UsageSnapshot {
  return { id, name, status: "ok", plan: null, error: null, fetchedAt: now, windows: [] }
}

// --- parsers (pure, exported for tests) -------------------------------------

export function parseDeepSeekBalance(data: unknown, now: number): UsageSnapshot {
  const base = usageBase("deepseek", "DeepSeek API", now)
  const root = jObj(data)
  if (!root) return { ...base, status: "error", error: "unexpected response" }
  const infos = jArr(root.balance_infos) ?? []
  const isAvailable = root.is_available !== false
  const windows: UsageWindow[] = []
  for (const raw of infos) {
    const info = jObj(raw)
    if (!info) continue
    const total = jNum(info.total_balance)
    if (total == null) continue
    const granted = jNum(info.granted_balance)
    const topped = jNum(info.topped_up_balance)
    windows.push({
      label: isAvailable ? "PAYG balance" : "PAYG balance (unusable)",
      kind: "balance",
      usedPercent: null,
      used: null,
      remaining: total,
      total: null,
      unit: "currency",
      resetsAt: null,
      currency: jStr(info.currency) ?? "USD",
      detail: granted != null || topped != null ? `granted ${granted ?? 0} / topped-up ${topped ?? 0}` : undefined,
    })
  }
  if (!windows.length) return { ...base, status: "error", error: "no balance entries in response" }
  return { ...base, plan: "Pay-as-you-go", windows }
}

export function parseMoonshotBalance(data: unknown, now: number, currency = "USD"): UsageSnapshot {
  const base = usageBase("moonshot", "Moonshot Open Platform", now)
  const root = jObj(data)
  const d = root ? jObj(root.data) : null
  if (!root || !d) return { ...base, status: "error", error: "unexpected response" }
  const available = jNum(d.available_balance)
  if (available == null) return { ...base, status: "error", error: "missing available_balance" }
  const voucher = jNum(d.voucher_balance)
  const cash = jNum(d.cash_balance)
  return {
    ...base,
    plan: "Pay-as-you-go",
    windows: [
      {
        label: "PAYG balance",
        kind: "balance",
        usedPercent: null,
        used: null,
        remaining: available,
        total: null,
        unit: "currency",
        resetsAt: null,
        currency,
        detail: voucher != null || cash != null ? `voucher ${voucher ?? 0} / cash ${cash ?? 0}` : undefined,
      },
    ],
  }
}

/** z.ai unit code -> minutes (day/hour/minute/week). */
const ZAI_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 }

function zaiWindowMeta(type: string, minutes: number | null): { label: string; kind: UsageWindow["kind"]; unit: UsageUnit | null } {
  const win = minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : minutes === 43200 ? "Monthly" : minutes ? `${minutes}m` : ""
  if (type === "TIME_LIMIT") return { label: win ? `MCP (${win})` : "MCP", kind: "mcp", unit: null }
  const kind: UsageWindow["kind"] = minutes === 10080 ? "weekly" : minutes === 43200 ? "monthly" : "short"
  if (type === "CREDIT_LIMIT") return { label: win ? `Credit ${win}` : "Credit quota", kind, unit: "credits" }
  return { label: win ? `Token ${win}` : "Token quota", kind, unit: "tokens" }
}

export function parseZaiQuota(data: unknown, now: number): UsageSnapshot {
  const base = usageBase("zai", "z.ai GLM Coding Plan", now)
  const root = jObj(data)
  const d = root ? jObj(root.data) : null
  const limits = d ? jArr(d.limits) : null
  if (!limits) return { ...base, status: "error", error: "response missing data.limits[]" }
  const plan = [d?.planName, d?.plan, d?.plan_type, d?.packageName, d?.level].map(jStr).find((s) => s != null) ?? null
  const windows: UsageWindow[] = []
  for (const raw of limits) {
    const l = jObj(raw)
    if (!l) continue
    const type = jStr(l.type)
    if (!type || !(type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT" || type === "TIME_LIMIT")) continue
    const unit = jNum(l.unit)
    const number = jNum(l.number)
    // TIME_LIMIT with unit=5 (minutes) & number=1 is the monthly MCP marker, not a 1-minute window.
    const isMonthlyMcp = type === "TIME_LIMIT" && unit === 5 && number === 1
    const minutes = isMonthlyMcp ? 43200 : unit != null && number != null && number > 0 ? number * (ZAI_UNIT_MINUTES[unit] ?? 0) || null : null
    const meta = zaiWindowMeta(type, minutes)
    const usage = jNum(l.usage)
    const current = jNum(l.currentValue)
    const remaining = jNum(l.remaining)
    let pct = jNum(l.percentage)
    if (usage != null && usage > 0) {
      const used = remaining != null ? Math.max(usage - remaining, current ?? usage - remaining) : current
      if (used != null) pct = clampPct((used / usage) * 100)
    }
    windows.push({
      label: meta.label,
      kind: meta.kind,
      usedPercent: pct != null ? clampPct(pct) : null,
      used: usage != null && remaining != null ? Math.max(0, usage - remaining) : current,
      remaining,
      total: usage,
      unit: meta.unit,
      resetsAt: jEpoch(l.nextResetTime),
    })
  }
  if (!windows.length) return { ...base, status: "error", error: "no recognized limit entries" }
  return { ...base, plan, windows }
}

function kimiWindowMinutes(duration: number | null, timeUnit: string | null): number | null {
  if (duration == null) return null
  if (timeUnit === "TIME_UNIT_MINUTE") return duration
  if (timeUnit === "TIME_UNIT_HOUR") return duration * 60
  if (timeUnit === "TIME_UNIT_DAY") return duration * 1440
  return null
}

export function parseKimiUsages(data: unknown, now: number): UsageSnapshot {
  const base = usageBase("kimi", "Kimi Code", now)
  const root = jObj(data)
  if (!root) return { ...base, status: "error", error: "unexpected response" }
  const windows: UsageWindow[] = []
  const u = jObj(root.usage)
  if (u) {
    const total = jNum(u.limit)
    const used = jNum(u.used)
    const remaining = jNum(u.remaining)
    if (total != null || used != null || remaining != null) {
      windows.push({
        label: "Weekly",
        kind: "weekly",
        usedPercent: total != null && total > 0 && used != null ? clampPct((used / total) * 100) : null,
        used,
        remaining,
        total,
        unit: "requests",
        resetsAt: jIso(u.resetTime),
      })
    }
  }
  for (const raw of jArr(root.limits) ?? []) {
    const l = jObj(raw)
    const w = l ? jObj(l.window) : null
    const det = l ? jObj(l.detail) : null
    if (!l || !w || !det) continue
    const minutes = kimiWindowMinutes(jNum(w.duration), jStr(w.timeUnit))
    const label = minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : minutes != null ? `${minutes}m window` : "Window"
    const total = jNum(det.limit)
    const used = jNum(det.used)
    windows.push({
      label,
      kind: minutes === 300 ? "short" : minutes === 10080 ? "weekly" : "short",
      usedPercent: total != null && total > 0 && used != null ? clampPct((used / total) * 100) : null,
      used,
      remaining: jNum(det.remaining),
      total,
      unit: "requests",
      resetsAt: jIso(det.resetTime),
    })
  }
  if (!windows.length) return { ...base, status: "error", error: "no usage entries in response" }
  return { ...base, windows }
}

export function parseMiniMaxRemains(data: unknown, now: number): UsageSnapshot {
  const base = usageBase("minimax", "MiniMax Token Plan", now)
  const root = jObj(data)
  const d = root ? jObj(root.data) : null
  const baseResp = (d ? jObj(d.base_resp) : null) ?? (root ? jObj(root.base_resp) : null)
  const statusCode = baseResp ? jNum(baseResp.status_code) : null
  if (statusCode != null && statusCode !== 0) {
    const msg = (baseResp ? jStr(baseResp.status_msg) ?? jStr(baseResp.status_message) : null) ?? `status ${statusCode}`
    return { ...base, status: "error", error: msg }
  }
  const models = d ? jArr(d.model_remains) ?? [] : []
  const windows: UsageWindow[] = []
  for (const raw of models) {
    const m = jObj(raw)
    if (!m) continue
    const model = jStr(m.model_name) ?? "model"
    const mk = (pctRemaining: number | null, total: number | null, remaining: number | null): number | null => {
      if (pctRemaining != null) return clampPct(100 - pctRemaining)
      if (total != null && total > 0 && remaining != null) return clampPct(((total - remaining) / total) * 100)
      return null
    }
    const boost = (v: unknown): string | undefined => {
      const n = jNum(v)
      return n != null && n > 0 ? `boost ${((1000 + n) / 1000).toFixed(1)}x` : undefined
    }
    // NOTE: MiniMax labels these fields "usage_count" but they carry REMAINING quota.
    const iTotal = jNum(m.current_interval_total_count)
    const iRemain = jNum(m.current_interval_usage_count)
    const iPctRemain = jNum(m.current_interval_remaining_percent)
    const iBoost = boost(m.interval_boost_permille) ?? boost(m.weekly_boost_permille)
    if (iTotal != null || iRemain != null || iPctRemain != null) {
      windows.push({
        label: `${model} 5-hour`,
        kind: "short",
        usedPercent: mk(iPctRemain, iTotal, iRemain),
        used: iTotal != null && iRemain != null ? Math.max(0, iTotal - iRemain) : null,
        remaining: iRemain,
        total: iTotal,
        unit: "requests",
        resetsAt: jEpoch(m.end_time) ?? jEpoch(m.remains_time),
        detail: iBoost,
      })
    }
    const wTotal = jNum(m.current_weekly_total_count)
    const wRemain = jNum(m.current_weekly_usage_count)
    const wPctRemain = jNum(m.current_weekly_remaining_percent)
    if (wTotal != null || wRemain != null || wPctRemain != null) {
      windows.push({
        label: `${model} Weekly`,
        kind: "weekly",
        usedPercent: mk(wPctRemain, wTotal, wRemain),
        used: wTotal != null && wRemain != null ? Math.max(0, wTotal - wRemain) : null,
        remaining: wRemain,
        total: wTotal,
        unit: "requests",
        resetsAt: jEpoch(m.weekly_end_time),
      })
    }
  }
  if (!windows.length) return { ...base, status: "error", error: "no quota entries in response" }
  return { ...base, windows }
}

function zenWindow(o: unknown, label: string, kind: UsageWindow["kind"], now: number): UsageWindow | null {
  const w = jObj(o)
  if (!w) return null
  const pct = jNum(w.percent) ?? jNum(w.usagePercent)
  const resetIn = jNum(w.resetInSec) ?? jNum(w.resetInSeconds)
  if (pct == null && resetIn == null) return null
  return {
    label,
    kind,
    usedPercent: pct != null ? clampPct(pct) : null,
    used: null,
    remaining: null,
    total: null,
    unit: null,
    resetsAt: resetIn != null ? now + resetIn * 1000 : null,
  }
}

export function parseZenUsage(data: unknown, now: number): UsageSnapshot {
  const base = usageBase("zen", "OpenCode Zen", now)
  const root = jObj(data)
  if (!root) return { ...base, status: "error", error: "unexpected response" }
  const usage = jObj(root.usage)
  const windows: UsageWindow[] = []
  const rolling = (usage ? jObj(usage.rolling) : null) ?? jObj(root.rollingUsage)
  const weekly = (usage ? jObj(usage.weekly) : null) ?? jObj(root.weeklyUsage)
  const monthly = (usage ? jObj(usage.monthly) : null) ?? jObj(root.monthlyUsage)
  const r = zenWindow(rolling, "Rolling 5-hour", "short", now)
  const w = zenWindow(weekly, "Weekly", "weekly", now)
  const m = zenWindow(monthly, "Monthly", "monthly", now)
  if (r) windows.push(r)
  if (w) windows.push(w)
  if (m) windows.push(m)
  if (!windows.length) return { ...base, status: "error", error: "no usage fields in response" }
  return { ...base, windows }
}

// --- source registry + fetcher ----------------------------------------------

const bearer = (k: string): Record<string, string> => ({ Authorization: `Bearer ${k}` })

export type UsageSourceDef = {
  id: string
  name: string
  /** Which option holds this source's region (undefined = region-independent). */
  regionKey?: "zaiRegion" | "moonshotRegion" | "minimaxRegion"
  endpoints: (region: UsageRegion) => string[]
  headers: (key: string) => Record<string, string>
  parse: (data: unknown, now: number, region: UsageRegion) => UsageSnapshot
}

const USAGE_SOURCES: UsageSourceDef[] = [
  {
    id: "deepseek",
    name: "DeepSeek API",
    endpoints: () => ["https://api.deepseek.com/user/balance"],
    headers: bearer,
    parse: (d, n) => parseDeepSeekBalance(d, n),
  },
  {
    id: "zai",
    name: "z.ai GLM Coding Plan",
    regionKey: "zaiRegion",
    endpoints: (r) => [r === "cn" ? "https://open.bigmodel.cn/api/monitor/usage/quota/limit" : "https://api.z.ai/api/monitor/usage/quota/limit"],
    headers: bearer,
    parse: (d, n) => parseZaiQuota(d, n),
  },
  {
    id: "kimi",
    name: "Kimi Code",
    endpoints: () => ["https://api.kimi.com/coding/v1/usages"],
    headers: bearer,
    parse: (d, n) => parseKimiUsages(d, n),
  },
  {
    id: "moonshot",
    name: "Moonshot Open Platform",
    regionKey: "moonshotRegion",
    endpoints: (r) => [`https://api.moonshot.${r === "cn" ? "cn" : "ai"}/v1/users/me/balance`],
    headers: bearer,
    parse: (d, n, r) => parseMoonshotBalance(d, n, r === "cn" ? "CNY" : "USD"),
  },
  {
    id: "minimax",
    name: "MiniMax Token Plan",
    regionKey: "minimaxRegion",
    endpoints: (r) => {
      const host = r === "cn" ? "https://api.minimaxi.com" : "https://api.minimax.io"
      return [`${host}/v1/token_plan/remains`, `${host}/v1/api/openplatform/coding_plan/remains`]
    },
    headers: (k) => ({ ...bearer(k), "Content-Type": "application/json", "MM-API-Source": "opencode-quotas" }),
    parse: (d, n) => parseMiniMaxRemains(d, n),
  },
  {
    id: "zen",
    name: "OpenCode Zen",
    endpoints: () => ["https://opencode.ai/zen/go/v1/usage"],
    headers: bearer,
    parse: (d, n) => parseZenUsage(d, n),
  },
]

// --- opencode credential store ----------------------------------------------
// OpenCode keeps its own per-provider credentials (`opencode auth login`) in
// <data>/auth.json (written 0600): { "<providerId>": { "type": "api", "key": ... }
// | { "type": "oauth", refresh, access, expires, ... } | { "type": "wellknown", key, token } }.
// The server API exposes no key-reading endpoint (only POST /auth/{id} to set), so the
// plugin reads the store read-only from disk — or OPENCODE_AUTH_CONTENT when set,
// mirroring opencode's own resolution order. Keys are never logged or shown in full.

/** OpenCode auth-store provider ids per usage source (models.dev ids; first match wins). */
const USAGE_SOURCE_AUTH_IDS: Record<string, string[]> = {
  deepseek: ["deepseek"],
  zai: ["zai-coding-plan", "zai"],
  kimi: ["kimi-for-coding", "kimi"],
  moonshot: ["moonshotai", "moonshotai-cn"],
  minimax: ["minimax-coding-plan", "minimax", "minimax-cn-coding-plan", "minimax-cn"],
  zen: ["opencode", "opencode-go"],
}

/** Region-aware candidate order: prefer the store id matching the configured region. */
export function authIdsFor(srcId: string, region: UsageRegion): string[] {
  const ids = USAGE_SOURCE_AUTH_IDS[srcId] ?? []
  if (region !== "cn") return ids
  const cnFirst = ids.filter((id) => id.endsWith("-cn") || id.includes("-cn-"))
  return [...cnFirst, ...ids.filter((id) => !cnFirst.includes(id))]
}

/** Plugin-specific env var names per source (checked before the auth store). */
const USAGE_SOURCE_ENV_NAMES: Record<string, string[]> = {
  deepseek: ["OPENCODE_QUOTAS_DEEPSEEK_API_KEY"],
  zai: ["OPENCODE_QUOTAS_ZAI_API_KEY"],
  kimi: ["OPENCODE_QUOTAS_KIMI_CODE_API_KEY", "OPENCODE_QUOTAS_KIMI_API_KEY"],
  moonshot: ["OPENCODE_QUOTAS_MOONSHOT_API_KEY"],
  minimax: ["OPENCODE_QUOTAS_MINIMAX_CODING_API_KEY", "OPENCODE_QUOTAS_MINIMAX_API_KEY"],
  zen: ["OPENCODE_QUOTAS_ZEN_API_KEY", "OPENCODE_API_KEY"],
}

/** Standard provider env names (as used by opencode / models.dev), checked last. */
const USAGE_PROVIDER_ENV_NAMES: Record<string, string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  zai: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
  kimi: ["KIMI_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  zen: ["OPENCODE_API_KEY"],
}

export type UsageKeyOrigin = "options" | "plugin-env" | "opencode-auth" | "provider-env"

export type UsageKeyDiagnostic = {
  source: string
  origin: UsageKeyOrigin
  /** Where an opencode-auth / env key came from (store path or env name); never the key itself. */
  detail: string | null
  /** Masked hint, e.g. "••••ab12" — safe to display. */
  hint: string | null
}

/** Extract { providerId -> key } from a parsed auth store, ignoring oauth entries. */
export function parseOpencodeAuth(data: unknown): Record<string, string> {
  const root = jObj(data)
  if (!root) return {}
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(root)) {
    const e = jObj(entry)
    if (!e || e.type === "oauth") continue
    const key = jStr(e.key)
    if (key) out[id] = key
  }
  return out
}

function authStoreCandidates(): string[] {
  const home = osMod.homedir()
  const cands: string[] = []
  const xdg = process.env.XDG_DATA_HOME?.trim()
  if (xdg) cands.push(pathMod.join(xdg, "opencode", "auth.json"))
  cands.push(pathMod.join(home, ".local", "share", "opencode", "auth.json"))
  if (process.platform === "darwin") cands.push(pathMod.join(home, "Library", "Application Support", "opencode", "auth.json"))
  return [...new Set(cands)]
}

let authFileCache: { path: string; mtimeMs: number; size: number; keys: Record<string, string> } | null = null
let authContentCache: { raw: string; keys: Record<string, string> } | null = null

/**
 * Read OpenCode's credential store (read-only). Precedence matches opencode itself:
 * OPENCODE_AUTH_CONTENT env JSON first, then <data>/auth.json. The file is re-read only
 * when its mtime/size change, so a fresh `opencode auth login` is picked up without a
 * restart on the next polling cycle.
 */
export function readOpencodeAuthStore(): { keys: Record<string, string>; where: string | null } {
  const contentEnv = process.env.OPENCODE_AUTH_CONTENT
  if (contentEnv && contentEnv.trim() !== "") {
    if (!authContentCache || authContentCache.raw !== contentEnv) {
      let keys: Record<string, string> = {}
      try {
        keys = parseOpencodeAuth(JSON.parse(contentEnv))
      } catch {
        /* malformed OPENCODE_AUTH_CONTENT -> no keys */
      }
      authContentCache = { raw: contentEnv, keys }
    }
    return { keys: authContentCache.keys, where: "OPENCODE_AUTH_CONTENT" }
  }
  for (const p of authStoreCandidates()) {
    let st: { mtimeMs: number; size: number; isFile: () => boolean }
    try {
      st = fsSync.statSync(p)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (!authFileCache || authFileCache.path !== p || authFileCache.mtimeMs !== st.mtimeMs || authFileCache.size !== st.size) {
      let keys: Record<string, string> = {}
      try {
        keys = parseOpencodeAuth(JSON.parse(fsSync.readFileSync(p, "utf8")))
      } catch {
        /* malformed auth.json -> no keys (opencode's schema filtering behaves the same) */
      }
      authFileCache = { path: p, mtimeMs: st.mtimeMs, size: st.size, keys }
    }
    return { keys: authFileCache.keys, where: authFileCache.path }
  }
  return { keys: {}, where: null }
}

/** "sk-...ab12" -> "••••ab12" — diagnostics only ever see the last 4 characters. */
export function maskKey(key: string): string {
  return "••••" + key.slice(-4)
}

/**
 * Resolve one source's key. Precedence: plugin options -> OPENCODE_QUOTAS_* env ->
 * OpenCode auth store (auth.json / OPENCODE_AUTH_CONTENT) -> standard provider env.
 * Pass authStore = null to disable the auto-discovery layer entirely.
 */
export function resolveUsageKey(
  srcId: string,
  optionsKey: string | undefined,
  envGetter: (name: string) => string | undefined,
  authStore: { keys: Record<string, string>; where: string | null } | null,
  region: UsageRegion = "global",
): { key: string; origin: UsageKeyOrigin; detail: string | null } | null {
  if (optionsKey) return { key: optionsKey, origin: "options", detail: null }
  for (const name of USAGE_SOURCE_ENV_NAMES[srcId] ?? []) {
    const v = envGetter(name)
    if (v) return { key: v, origin: "plugin-env", detail: name }
  }
  if (authStore) {
    for (const id of authIdsFor(srcId, region)) {
      const k = authStore.keys[id]
      if (k) return { key: k, origin: "opencode-auth", detail: authStore.where }
    }
    for (const name of USAGE_PROVIDER_ENV_NAMES[srcId] ?? []) {
      const v = envGetter(name)
      if (v) return { key: v, origin: "provider-env", detail: name }
    }
  }
  return null
}

export type FetchImpl = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

/** Fetch + parse one source, trying its endpoints in order. Never throws. */
export async function fetchUsageSnapshot(
  src: UsageSourceDef,
  key: string,
  region: UsageRegion,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<UsageSnapshot> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, timeoutMs))
  try {
    let lastErr = "request failed"
    for (const url of src.endpoints(region)) {
      let res: Awaited<ReturnType<FetchImpl>>
      try {
        res = await fetchImpl(url, { headers: { Accept: "application/json", ...src.headers(key) }, signal: ctrl.signal })
      } catch (e) {
        lastErr = e instanceof Error ? (e.name === "AbortError" ? "request timed out" : e.message) : String(e)
        continue
      }
      if (res.status === 401 || res.status === 403) {
        return { id: src.id, name: src.name, status: "error", plan: null, error: `API key rejected (HTTP ${res.status})`, fetchedAt: Date.now(), windows: [] }
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`
        continue
      }
      let data: unknown
      try {
        data = await res.json()
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "invalid JSON"
        continue
      }
      const snap = src.parse(data, Date.now(), region)
      if (snap.status === "error") {
        lastErr = snap.error ?? "parse error"
        continue
      }
      return snap
    }
    return { id: src.id, name: src.name, status: "error", plan: null, error: lastErr, fetchedAt: Date.now(), windows: [] }
  } finally {
    clearTimeout(timer)
  }
}

// --- formatting --------------------------------------------------------------

/** 1234567 -> "1,234,567" (locale-independent). */
export function fmtCount(n: number): string {
  const neg = n < 0 ? "-" : ""
  const digits = Math.abs(Math.round(n)).toString()
  return neg + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function fmtMoney(n: number, currency?: string): string {
  const c = (currency ?? "").toUpperCase()
  return `${c ? c + " " : ""}${n.toFixed(2)}`
}

/** Human-readable usage of one window, e.g. "40% used · 1,200 / 3,000 tokens · resets in 2h 10m". */
export function usageWindowText(w: UsageWindow, now: number, withReset = true): string {
  if (w.kind === "balance") {
    const amount = w.remaining != null ? fmtMoney(w.remaining, w.currency) : "unknown"
    return w.detail ? `${amount} (${w.detail})` : amount
  }
  const bits: string[] = []
  if (w.usedPercent != null) bits.push(`${Math.round(w.usedPercent)}% used`)
  if (w.total != null && w.total > 0) {
    const used = w.used ?? Math.max(0, w.total - (w.remaining ?? 0))
    bits.push(`${fmtCount(used)} / ${fmtCount(w.total)}${w.unit ? " " + w.unit : ""}`)
  } else if (w.remaining != null) {
    bits.push(`${fmtCount(w.remaining)} left`)
  }
  if (w.detail) bits.push(w.detail)
  if (withReset && w.resetsAt != null) bits.push(w.resetsAt > now ? `resets in ${fmtDur(w.resetsAt - now)}` : "resets soon")
  return bits.length ? bits.join(" · ") : "no data"
}

/** Lines for the text table; [] when nothing is configured/usable. */
export function formatUsageLines(snapshots: UsageSnapshot[], now: number = Date.now()): string[] {
  const lines: string[] = []
  for (const s of snapshots) {
    if (s.status !== "ok" && !s.windows.length) {
      lines.push(`${s.name}: unavailable (${s.error ?? "error"})`)
      continue
    }
    lines.push(`${s.name}${s.plan ? ` — ${s.plan}` : ""}`)
    for (const w of s.windows) lines.push(`  ${w.label}: ${usageWindowText(w, now)}`)
    if (s.error) lines.push(`  (${s.error})`)
  }
  return lines
}

/** One compact line for toasts, e.g. "Kimi weekly 34% · z.ai 5-hour 40%". */
export function usageToastSummary(snapshots: UsageSnapshot[]): string | null {
  const bits: string[] = []
  for (const s of snapshots) {
    if (s.status !== "ok" || !s.windows.length) continue
    const short = s.name.replace(" Open Platform", "").replace(" GLM Coding Plan", "").replace(" Token Plan", "").replace(" API", "")
    const top = s.windows.filter((w) => w.usedPercent != null).sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]
    const bal = s.windows.find((w) => w.kind === "balance")
    if (top && top.usedPercent != null) bits.push(`${short} ${top.label.toLowerCase()} ${Math.round(top.usedPercent)}%`)
    else if (bal && bal.remaining != null) bits.push(`${short} ${fmtMoney(bal.remaining, bal.currency)}`)
  }
  return bits.length ? bits.join(" · ") : null
}

/** Markdown section for session cards; null when nothing to show. */
export function usageMarkdown(snapshots: UsageSnapshot[], now: number = Date.now()): string | null {
  const rows: string[] = []
  for (const s of snapshots) {
    if (!s.windows.length) continue
    for (const w of s.windows) {
      rows.push(`| ${s.name}${s.plan ? ` (${s.plan})` : ""} | ${w.label} | ${usageWindowText(w, now)} |`)
    }
  }
  if (!rows.length) return null
  return ["**Quota & balance** (live from provider account APIs)", "", "| Source | Window | Usage |", "|---|---|---|", ...rows].join("\n")
}

/** JSON payload for the companion page (/api/status). */
export function statusPayload(
  providers: ProviderDef[],
  opts: OpencodeQuotasOptions,
  now: number = Date.now(),
  usage: UsageSnapshot[] = [],
  keys: UsageKeyDiagnostic[] = [],
  hidden: string[] = [],
) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
  return {
    generatedAt: new Date(now).toISOString(),
    leadMinutes: opts.leadMinutes ?? 15,
    local: { tz: localTz, time: fmtClock(now) },
    utc: fmtClock(now, "UTC"),
    onlyConfigured: opts.onlyConfigured !== false,
    hidden,
    usage: {
      enabled: opts.usage?.enabled ?? true,
      refreshMin: opts.usage?.refreshMin ?? 5,
      alertPct: opts.usage?.alertPct ?? 80,
      sources: usage.map((s) => {
        const k = keys.find((x) => x.source === s.id) ?? null
        const originLabel = !k
          ? null
          : k.origin === "opencode-auth"
            ? "opencode auth"
            : k.origin === "options"
              ? "options"
              : `env ${k.detail ?? ""}`.trim()
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          plan: s.plan,
          error: s.error,
          fetchedAt: s.fetchedAt,
          fetchedAgo: s.fetchedAt != null ? `${fmtDur(now - s.fetchedAt)} ago` : null,
          keyOrigin: originLabel,
          keyHint: k?.hint ?? null,
          windows: s.windows.map((w) => ({
            label: w.label,
            kind: w.kind,
            usedPercent: w.usedPercent,
            meta: usageWindowText(w, now, false),
            reset: w.resetsAt != null ? (w.resetsAt > now ? `resets in ${fmtDur(w.resetsAt - now)}` : "resets soon") : null,
          })),
        }
      }),
    },
    providers: enrich(providers, now).map((e) => {
      const day = daySegments(e.pv, now)
      return {
      id: e.pv.id,
      name: e.pv.name,
      scope: e.pv.scope,
      scopeLabel: scopeLabel(e.pv),
      tz: e.pv.tz,
      state: e.state,
      stateLabel: STATE_TAG[e.state],
      windows: e.windows,
      models: e.pv.models ?? [],
      benefit: e.pv.benefit,
      note: e.pv.note ?? null,
      pct: e.pct,
      sinceLocal: e.status.since != null ? fmtClock(e.status.since) : null,
      untilLabel: e.untilLabel,
      day: { segments: day.segments, nowMin: day.nowMin, nowLabel: day.nowLabel },
      source: e.pv.source,
      checked: e.pv.checked,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Companion server: live status page + JSON API + plain-text table
// ---------------------------------------------------------------------------

const HTML_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>opencode peak-hours</title>
<script>try{var t=localStorage.getItem("opencode-quotas-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else if(!matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.dataset.theme="light"}catch(e){}</script>
<style>
:root{--bg:#0e1013;--card:#161a20;--border:#232935;--ink:#d7dce3;--mut:#8b93a1;--faint:#77808f;--peakbg:#3a2b12;--peakink:#e8b04b;--peakbd:#6b4e1d;--offbg:#10281a;--offink:#57c98a;--offbd:#1e5233;--nonebg:#1c2027;--noneink:#8b93a1;--nonebd:#2a313d;--accent:#6aa7ff;--err:#e05e5e;--stale:#e8b04b;--barbg:#20262f;--peakseg:#e8b04b;--now:#ffffff;color-scheme:dark}
html[data-theme="light"]{--bg:#f4f6f9;--card:#ffffff;--border:#d9dfe7;--ink:#1d2229;--mut:#5c6674;--faint:#79828f;--peakbg:#fcf1d8;--peakink:#8a5c07;--peakbd:#e5cb8d;--offbg:#e3f4ea;--offink:#147648;--offbd:#b5dfc9;--nonebg:#eceff3;--noneink:#5c6674;--nonebd:#cfd6df;--accent:#1e63cf;--err:#bd3a3a;--stale:#8a5c07;--barbg:#e2e7ee;--peakseg:#d7991c;--now:#1d2229;color-scheme:light}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;padding:28px}
h1{font-size:17px;margin:0 0 2px;display:flex;align-items:center}.sub{color:var(--mut);font-size:12px;margin-bottom:22px}
#theme{margin-left:auto;background:var(--card);color:var(--mut);border:1px solid var(--border);border-radius:999px;font:inherit;font-size:11px;padding:3px 11px;cursor:pointer}
#theme:hover{color:var(--ink)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(330px,1fr))}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.top{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.name{font-weight:600;font-size:15px}
.badge{margin-left:auto;font-size:11px;font-weight:700;letter-spacing:.4px;padding:3px 9px;border-radius:999px;white-space:nowrap}
.peak{background:var(--peakbg);color:var(--peakink);border:1px solid var(--peakbd)}
.off{background:var(--offbg);color:var(--offink);border:1px solid var(--offbd)}
.none{background:var(--nonebg);color:var(--noneink);border:1px solid var(--nonebd)}
.win{font-size:12.5px;color:var(--mut);margin:2px 0}
.b{margin-top:8px;font-size:12.5px;color:var(--ink)}
.note{font-size:11.5px;color:var(--faint);margin-top:4px}
.bar{height:6px;background:var(--barbg);border-radius:4px;margin-top:10px;overflow:hidden}
.bar>i{display:block;height:100%;border-radius:4px}
.meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--faint);margin-top:5px}
#usage .meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.src{font-size:11px;margin-top:8px}
.err{color:var(--err);font-size:12.5px;margin-top:6px}
.stale{color:var(--stale);font-size:11px;margin-top:4px}
.daybar{position:relative;height:12px;background:var(--barbg);border-radius:6px;margin-top:10px;overflow:hidden}
.daybar>i{position:absolute;top:0;bottom:0;background:var(--peakseg)}
.daybar>u{position:absolute;top:0;bottom:0;width:2px;background:var(--now);box-shadow:0 0 0 1px var(--card)}
.daymeta{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:var(--faint);margin-top:4px}
</style></head><body>
<h1>Model provider peak-hours<button id="theme" title="color scheme: auto / light / dark">◐ auto</button></h1><div class="sub" id="clocks"></div><div class="grid" id="grid"></div>
<div id="usage"></div>
<script>
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
var THEME_ORDER=["auto","light","dark"];
function themePref(){try{var t=localStorage.getItem("opencode-quotas-theme");return t==="light"||t==="dark"?t:"auto"}catch(e){return"auto"}}
function applyTheme(){var t=themePref();var dark=t==="dark"||(t==="auto"&&(!window.matchMedia||matchMedia("(prefers-color-scheme: dark)").matches));document.documentElement.dataset.theme=dark?"dark":"light";var b=document.getElementById("theme");if(b)b.textContent=(t==="auto"?"◐":t==="light"?"☀":"☾")+" "+t}
function cycleTheme(){var t=themePref();t=THEME_ORDER[(THEME_ORDER.indexOf(t)+1)%3];try{localStorage.setItem("opencode-quotas-theme",t)}catch(e){}applyTheme()}
applyTheme();document.getElementById("theme").onclick=cycleTheme;
if(window.matchMedia)try{matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){if(themePref()==="auto")applyTheme()})}catch(e){}
async function refresh(){
 try{
  const d=await(await fetch("/api/status")).json();
  document.getElementById("clocks").textContent="local "+d.local.time+" ("+d.local.tz+") · UTC "+d.utc+" · lead-time alerts "+d.leadMinutes+" min · auto-refresh 30 s"+(d.hidden&&d.hidden.length?" · hidden (no API key): "+d.hidden.join(", "):"");
  document.getElementById("grid").innerHTML=d.providers.length?d.providers.map(p=>{
   const badge=p.state==="peak"?'<span class="badge peak">PEAK</span>':p.state==="offpeak"?'<span class="badge off">OFF-PEAK</span>':'<span class="badge none">NO FIXED WINDOW</span>';
   const bar=p.pct==null?"":'<div class="bar"><i style="width:'+p.pct+'%;background:'+(p.state==="peak"?"var(--peakseg)":"var(--offink)")+'"></i></div><div class="meta"><span>window started '+esc(p.sinceLocal||"")+'</span><span>'+esc(p.untilLabel||"")+"</span></div>";
   const day=p.windows.length&&p.day?'<div class="daybar">'+p.day.segments.map(function(s){return '<i style="left:'+(s[0]/14.4)+'%;width:'+((s[1]-s[0])/14.4)+'%"></i>'}).join("")+'<u style="left:'+(p.day.nowMin/14.4)+'%" title="now '+esc(p.day.nowLabel)+" "+esc(p.tz)+'"></u></div><div class="daymeta"><span>00:00</span><span>now '+esc(p.day.nowLabel)+" · "+esc(p.tz)+'</span><span>24:00</span></div>':"";
   return '<div class="card"><div class="top"><span class="name">'+esc(p.name)+"</span>"+badge+'</div><div class="win">'+esc(p.scopeLabel)+" · tz "+esc(p.tz)+"</div>"+(p.windows.length?'<div class="win">peak: '+p.windows.map(esc).join(" & ")+"</div>":"")+'<div class="b">'+esc(p.benefit)+"</div>"+(p.note?'<div class="note">'+esc(p.note)+"</div>":"")+day+bar+'<div class="src">source: <a href="'+esc(p.source)+'" target="_blank" rel="noreferrer">'+esc(p.source.split("/")[2])+"</a> · verified "+esc(p.checked)+"</div></div>";
  }).join(""):'<div class="card">'+esc(d.hidden&&d.hidden.length?"All tracked providers are hidden — no API key configured for: "+d.hidden.join(", "):"no providers to show")+"</div>";
  document.getElementById("usage").innerHTML=usageHtml(d.usage);
 }catch(e){document.getElementById("grid").innerHTML='<div class="card">status unavailable: '+esc(e.message)+"</div>"}
}
refresh();setInterval(refresh,30000);
function usageHtml(u){
 var srcs=(u&&u.sources)||[];
 if(!u||!u.enabled||!srcs.length)return "";
 var cards=srcs.map(function(s){
  var head='<div class="top"><span class="name">'+esc(s.name)+'</span>'+(s.plan?'<span class="badge none">'+esc(s.plan)+'</span>':"")+'</div>';
  var keyline=s.keyOrigin?'<div class="note">key: '+esc(s.keyOrigin)+(s.keyHint?" "+esc(s.keyHint):"")+"</div>":"";
  if(s.status!=="ok"&&(!s.windows||!s.windows.length))return '<div class="card">'+head+keyline+'<div class="err">'+esc(s.error||"unavailable")+'</div><div class="note">'+esc(s.fetchedAgo||"")+"</div></div>";
  var wins=(s.windows||[]).map(function(w){
   var pct=w.usedPercent==null?null:Math.max(0,Math.min(100,w.usedPercent));
   var col=pct==null?"var(--accent)":pct<60?"var(--offink)":pct<85?"var(--peakseg)":"var(--err)";
   var bar=pct==null?"":'<div class="bar"><i style="width:'+pct+'%;background:'+col+'"></i></div>';
   return '<div class="win">'+esc(w.label)+'</div>'+bar+'<div class="meta"><span>'+esc(w.meta||"")+'</span><span>'+esc(w.reset||"")+"</span></div>";
  }).join("");
  var stale=s.error?'<div class="stale">'+esc(s.error)+"</div>":"";
  var upd=s.fetchedAgo?'<div class="note">updated '+esc(s.fetchedAgo)+"</div>":"";
  return '<div class="card">'+head+keyline+wins+stale+upd+"</div>";
 }).join("");
 return '<h1 style="font-size:15px;margin:26px 0 12px">Quota &amp; balance</h1><div class="grid">'+cards+"</div>";
}
</script></body></html>`

type Route = { status: number; type: string; body: string; cors: Record<string, string> }

/** Shared with opencode web: OPENCODE_SERVER_PASSWORD enables HTTP Basic auth (user defaults to "opencode"). */
type ServerAuth = { user: string; password: string } | null

function serverAuthFromEnv(): ServerAuth {
  const password = envStr("OPENCODE_SERVER_PASSWORD")
  if (!password) return null
  return { user: envStr("OPENCODE_SERVER_USERNAME") ?? "opencode", password }
}

function basicAuthOk(header: string | null | undefined, auth: ServerAuth): boolean {
  if (!auth) return true
  if (!header || !header.startsWith("Basic ")) return false
  try {
    const decoded = atob(header.slice(6).trim())
    const sep = decoded.indexOf(":")
    return (sep < 0 ? decoded : decoded.slice(0, sep)) === auth.user && (sep < 0 ? "" : decoded.slice(sep + 1)) === auth.password
  } catch {
    return false
  }
}

function unauthorized(): Route {
  return {
    status: 401,
    type: "text/plain; charset=utf-8",
    body: "authentication required — credentials mirror opencode web (OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD)",
    cors: { "WWW-Authenticate": 'Basic realm="opencode-quotas"' },
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

/** Best host to display in URLs: loopback for loopback binds, else the primary LAN IPv4. */
function displayHost(hostname: string): string {
  if (LOOPBACK_HOSTS.has(hostname)) return "127.0.0.1"
  try {
    for (const list of Object.values(osMod.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return ni.address
      }
    }
  } catch {
    /* fall through */
  }
  return "127.0.0.1"
}

function route(
  path: string,
  providers: ProviderDef[],
  opts: OpencodeQuotasOptions,
  usage: UsageSnapshot[] = [],
  keys: UsageKeyDiagnostic[] = [],
  hidden: string[] = [],
  allowCors = false,
): Route {
  let pathname = path
  try {
    pathname = new URL(path, "http://localhost").pathname
  } catch {
    /* keep raw */
  }
  const cors: Record<string, string> = allowCors ? { "Access-Control-Allow-Origin": "*" } : {}
  if (pathname === "/" || pathname === "/index.html")
    return { status: 200, type: "text/html; charset=utf-8", body: HTML_PAGE, cors }
  if (pathname === "/api/status")
    return {
      status: 200,
      type: "application/json; charset=utf-8",
      body: JSON.stringify(statusPayload(providers, opts, Date.now(), usage, keys, hidden)),
      cors,
    }
  if (pathname === "/api/usage")
    return {
      status: 200,
      type: "application/json; charset=utf-8",
      body: JSON.stringify({ generatedAt: new Date().toISOString(), sources: usage, keys }),
      cors,
    }
  if (pathname === "/opencode-quotas.txt")
    return { status: 200, type: "text/plain; charset=utf-8", body: textTable(providers, Date.now(), usage), cors }
  if (pathname === "/favicon.ico") return { status: 204, type: "text/plain", body: "", cors }
  return {
    status: 404,
    type: "text/plain; charset=utf-8",
    body: "not found (routes: / /api/status /api/usage /opencode-quotas.txt)",
    cors,
  }
}

export type CompanionServer = { url: string; port: number; stop: () => void }

/** Tiny status server. Prefers Bun.serve (opencode runs on Bun), falls back to node:http. */
export async function startCompanionServer(
  port: number,
  providers: ProviderDef[],
  opts: OpencodeQuotasOptions,
  usage: () => UsageSnapshot[] = () => [],
  keys: () => UsageKeyDiagnostic[] = () => [],
  hidden: () => string[] = () => [],
  auth: ServerAuth = null,
): Promise<CompanionServer> {
  const hostname = opts.hostname ?? "0.0.0.0"
  const loopback = LOOPBACK_HOSTS.has(hostname)
  const allowCors = loopback && !auth
  const Bun_ = (globalThis as unknown as {
    Bun?: {
      serve: (o: unknown) => { port: number; stop: (c: boolean) => void }
    }
  }).Bun
  if (Bun_?.serve) {
    let lastErr: unknown
    for (let p = port; p < port + 10; p++) {
      try {
        const srv = Bun_.serve({
          port: p,
          hostname,
          fetch: (req: { url: string; headers: { get: (k: string) => string | null } }) => {
            if (!basicAuthOk(req.headers?.get?.("authorization"), auth)) {
              const u = unauthorized()
              return new Response(u.body, { status: u.status, headers: { "Content-Type": u.type, ...u.cors } })
            }
            const r = route(new URL(req.url).pathname + new URL(req.url).search, providers, opts, usage(), keys(), hidden(), allowCors)
            return new Response(r.body, { status: r.status, headers: { "Content-Type": r.type, ...r.cors } })
          },
        })
        if (!loopback && !auth)
          console.error("[opencode-quotas] dashboard bound to " + hostname + " without authentication — set OPENCODE_SERVER_PASSWORD (same as opencode web) to protect it")
        return { url: `http://${displayHost(hostname)}:${srv.port}`, port: srv.port, stop: () => srv.stop(true) }
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  }
  const http = (await import("node:http")) as unknown as {
    createServer: (cb: (req: { url?: string; headers?: Record<string, string | string[] | undefined> }, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }) => void) => {
      listen: (port: number, host: string, cb: () => void) => void
      close: () => void
      on: (ev: string, cb: (e: unknown) => void) => void
      address: () => { port: number } | null
    }
  }
  let lastErr: unknown
  for (let p = port; p < port + 10; p++) {
    const srv = http.createServer((req, res) => {
      const raw = req.headers?.authorization
      const header = Array.isArray(raw) ? raw[0] : raw
      if (!basicAuthOk(header, auth)) {
        const u = unauthorized()
        res.writeHead(u.status, { "Content-Type": u.type, ...u.cors })
        res.end(u.body)
        return
      }
      const r = route(req.url ?? "/", providers, opts, usage(), keys(), hidden(), allowCors)
      res.writeHead(r.status, { "Content-Type": r.type, ...r.cors })
      res.end(r.body)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        srv.on("error", reject)
        srv.listen(p, hostname, resolve)
      })
      const bound = srv.address()?.port ?? p
      if (!loopback && !auth)
        console.error("[opencode-quotas] dashboard bound to " + hostname + " without authentication — set OPENCODE_SERVER_PASSWORD (same as opencode web) to protect it")
      return { url: `http://${displayHost(hostname)}:${bound}`, port: bound, stop: () => srv.close() }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function envBool(name: string, dflt: boolean): boolean {
  const v = process.env[name]
  if (v == null || v === "") return dflt
  return !["0", "false", "off", "no"].includes(v.toLowerCase())
}

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : dflt
}

function envStr(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() !== "" ? v.trim() : undefined
}

function mergeOpts(options?: OpencodeQuotasOptions): OpencodeQuotasOptions {
  const o = options ?? {}
  return {
    port: o.port ?? envNum("OPENCODE_QUOTAS_PORT", 4117),
    hostname: o.hostname ?? envStr("OPENCODE_QUOTAS_HOSTNAME") ?? "0.0.0.0",
    leadMinutes: o.leadMinutes ?? envNum("OPENCODE_QUOTAS_LEAD_MINUTES", 15),
    toastOnConnect: o.toastOnConnect ?? envBool("OPENCODE_QUOTAS_TOAST_ON_CONNECT", true),
    cardOnSessionStart: o.cardOnSessionStart ?? envBool("OPENCODE_QUOTAS_SESSION_CARD", true),
    command: o.command ?? envBool("OPENCODE_QUOTAS_COMMAND", true),
    notify: o.notify ?? envBool("OPENCODE_QUOTAS_NOTIFY", false),
    providers: o.providers ?? (process.env.OPENCODE_QUOTAS_PROVIDERS ? process.env.OPENCODE_QUOTAS_PROVIDERS.split(",").map((s) => s.trim()).filter(Boolean) : undefined),
    custom: o.custom ?? [],
    onlyConfigured: o.onlyConfigured ?? envBool("OPENCODE_QUOTAS_ONLY_CONFIGURED", true),
    usage: usageConfig(o.usage),
    disabled: o.disabled ?? envBool("OPENCODE_QUOTAS_DISABLE", false),
  }
}

/** Resolve usage options from plugin options + environment (idempotent). */
function usageConfig(c?: UsageOptions): ResolvedUsageOptions {
  const o = c ?? {}
  const env = (name: string): string | undefined => {
    const v = process.env[name]
    return v && v.trim() !== "" ? v.trim() : undefined
  }
  const region = (v: UsageRegion | undefined, envName: string): UsageRegion => v ?? (env(envName) === "cn" ? "cn" : "global")
  const minBalanceEnv = env("OPENCODE_QUOTAS_MIN_BALANCE")
  const minBalanceNum = minBalanceEnv != null ? Number(minBalanceEnv) : NaN
  return {
    enabled: o.enabled ?? envBool("OPENCODE_QUOTAS_USAGE", true),
    refreshMin: Math.max(1, o.refreshMin ?? envNum("OPENCODE_QUOTAS_USAGE_REFRESH_MIN", 5)),
    timeoutSec: Math.max(1, o.timeoutSec ?? envNum("OPENCODE_QUOTAS_USAGE_TIMEOUT", 8)),
    alertPct: o.alertPct ?? envNum("OPENCODE_QUOTAS_USAGE_ALERT_PCT", 80),
    minBalance: o.minBalance !== undefined ? o.minBalance : Number.isFinite(minBalanceNum) ? minBalanceNum : null,
    keys: {
      deepseek: o.keys?.deepseek ?? env("OPENCODE_QUOTAS_DEEPSEEK_API_KEY"),
      zai: o.keys?.zai ?? env("OPENCODE_QUOTAS_ZAI_API_KEY"),
      kimi: o.keys?.kimi ?? env("OPENCODE_QUOTAS_KIMI_CODE_API_KEY") ?? env("OPENCODE_QUOTAS_KIMI_API_KEY"),
      moonshot: o.keys?.moonshot ?? env("OPENCODE_QUOTAS_MOONSHOT_API_KEY"),
      minimax: o.keys?.minimax ?? env("OPENCODE_QUOTAS_MINIMAX_CODING_API_KEY") ?? env("OPENCODE_QUOTAS_MINIMAX_API_KEY"),
      zen: o.keys?.zen ?? env("OPENCODE_QUOTAS_ZEN_API_KEY") ?? env("OPENCODE_API_KEY"),
    },
    zaiRegion: region(o.zaiRegion, "OPENCODE_QUOTAS_ZAI_REGION"),
    moonshotRegion: region(o.moonshotRegion, "OPENCODE_QUOTAS_MOONSHOT_REGION"),
    minimaxRegion: region(o.minimaxRegion, "OPENCODE_QUOTAS_MINIMAX_REGION"),
    authStore: o.authStore ?? envBool("OPENCODE_QUOTAS_USAGE_AUTH_STORE", true),
  }
}

async function desktopNotify(
  $: { (strings: TemplateStringsArray, ...vals: any[]): PromiseLike<unknown> },
  message: string,
): Promise<void> {
  try {
    const platform = process.platform
    if (platform === "darwin") {
      await $`osascript -e ${"display notification " + JSON.stringify(message) + " with title \"opencode peak-hours\""}`
    } else if (platform === "linux") {
      await $`notify-send ${"opencode peak-hours"} ${message}`
    }
  } catch {
    /* notifications are best-effort */
  }
}

export const OpencodeQuotasPlugin: Plugin = async ({ client, $, directory }, options) => {
  const opts = mergeOpts(options as OpencodeQuotasOptions | undefined)
  if (opts.disabled) return {}

  const providers = [
    ...PROVIDERS.filter((p) => !opts.providers || opts.providers.includes(p.id)),
    ...(opts.custom ?? []),
  ]

  // --- usage / quota monitor -----------------------------------------------

  const ucfg = usageConfig(opts.usage)
  const fetchImpl: FetchImpl | undefined =
    typeof globalThis.fetch === "function" ? ((globalThis.fetch as unknown as FetchImpl).bind(globalThis)) : undefined
  const usageActive = new Map<string, { src: UsageSourceDef; key: string; region: UsageRegion }>()
  const keyInfo = new Map<string, { origin: UsageKeyOrigin; detail: string | null; hint: string }>()
  const envGetter = (name: string): string | undefined => {
    const v = process.env[name]
    return v && v.trim() !== "" ? v.trim() : undefined
  }
  /** Providers currently displayed. With onlyConfigured (default), a built-in provider
   *  appears only while its usage source has a resolved API key; custom providers always
   *  show. The array is mutated in place so server closures see updates. */
  const visible: ProviderDef[] = []
  const recomputeVisible = (): void => {
    const next =
      opts.onlyConfigured === false
        ? providers
        : providers.filter((p) => usageActive.has(p.id) || (opts.custom ?? []).some((c) => c.id === p.id))
    visible.length = 0
    visible.push(...next)
  }
  const hiddenIds = (): string[] => {
    if (opts.onlyConfigured === false || visible.length === providers.length) return []
    return providers.filter((p) => !visible.some((v) => v.id === p.id)).map((p) => p.id)
  }

  /** Re-resolve keys each refresh cycle (options -> env -> opencode auth store -> provider env),
   *  so a fresh `opencode auth login` is picked up without restarting opencode. */
  const syncUsageActive = (): void => {
    if (!ucfg.enabled || !fetchImpl) {
      usageActive.clear()
      keyInfo.clear()
      recomputeVisible()
      return
    }
    const store = ucfg.authStore ? readOpencodeAuthStore() : null
    const optKeys = opts.usage?.keys ?? {}
    for (const src of USAGE_SOURCES) {
      const id = src.id as keyof UsageKeys
      const region = src.regionKey ? ucfg[src.regionKey] : "global"
      const r = resolveUsageKey(src.id, optKeys[id], envGetter, store, region)
      if (r) {
        keyInfo.set(src.id, { origin: r.origin, detail: r.detail, hint: maskKey(r.key) })
        usageActive.set(src.id, { src, key: r.key, region })
      } else {
        keyInfo.delete(src.id)
        usageActive.delete(src.id)
      }
    }
    recomputeVisible()
  }
  syncUsageActive()
  const usageKeyDiags = (): UsageKeyDiagnostic[] =>
    [...keyInfo.entries()].map(([source, i]) => ({ source, origin: i.origin, detail: i.detail, hint: i.hint }))
  const usageState = new Map<string, UsageSnapshot>()
  let usageBusy = false
  const usageSnapshots = (): UsageSnapshot[] => [...usageState.values()]

  async function refreshUsage(): Promise<void> {
    if (!ucfg.enabled || usageBusy || !fetchImpl) return
    syncUsageActive() // re-resolve keys — new `opencode auth login` entries appear within one refresh cycle
    if (usageActive.size === 0) return
    usageBusy = true
    try {
      await Promise.all(
        [...usageActive.values()].map(async ({ src, key, region }) => {
          const snap = await fetchUsageSnapshot(src, key, region, ucfg.timeoutSec * 1000, fetchImpl)
          const prev = usageState.get(src.id)
          // A failed refresh keeps the last good windows so displays degrade gracefully.
          if (snap.status === "error" && prev && prev.status === "ok" && prev.windows.length) {
            usageState.set(src.id, { ...snap, windows: prev.windows, plan: prev.plan, fetchedAt: prev.fetchedAt })
          } else {
            usageState.set(src.id, snap)
          }
        }),
      )
    } finally {
      usageBusy = false
    }
    // Alert on fresh data immediately instead of waiting for the next 30s tick.
    if (!stopped) usageTick(Date.now())
  }

  let stopped = false
  const alerted = new Set<string>()
  const usageAlerted = new Set<string>()
  const carded = new Set<string>()
  let lastConnectToast = 0

  // --- display helpers -----------------------------------------------------

  const toast = async (message: string, title = "Provider peak-hours", variant: "info" | "success" | "warning" | "error" = "info", duration = 12_000) => {
    try {
      await client.tui.showToast({ body: { title, message, variant, duration }, query: { directory } })
    } catch {
      // /tui/show-toast only exists while a TUI client is attached (web/headless mode) — ignore.
    }
  }

  const tick = () => {
    if (stopped) return
    const now = Date.now()
    const leadMs = (opts.leadMinutes ?? 0) * 60_000
    if (leadMs > 0) {
      for (const pv of visible) {
        if (!pv.peakWindows.length) continue
        const st = evaluate(pv, now)
        if (st.until == null || st.toPeak == null) continue
        if (st.until - now > leadMs) continue
        const key = `${pv.id}:${st.until}`
        if (alerted.has(key)) continue
        alerted.add(key)
        if (alerted.size > 512) alerted.clear()
        const what = st.toPeak ? "PEAK starts" : "off-peak starts"
        const msg = `${pv.name}: ${what} at ${fmtClock(st.until)} local (${fmtClock(st.until, "UTC")} UTC) — in ${fmtDur(st.until - now)}`
        void toast(msg, "Peak-hours transition", st.toPeak ? "warning" : "success", 15_000)
        if (opts.notify) void desktopNotify($, msg)
      }
    }
    usageTick(now)
  }

  /** Toast when a quota window crosses the alert threshold or a balance runs low. */
  const usageTick = (now: number) => {
    if (!ucfg.enabled || usageActive.size === 0) return
    for (const snap of usageState.values()) {
      for (const w of snap.windows) {
        if (w.kind === "balance") {
          const min = ucfg.minBalance
          if (min == null || w.remaining == null || w.remaining > min) continue
          const key = `${snap.id}:bal:${Math.floor(now / 3_600_000)}`
          if (usageAlerted.has(key)) continue
          usageAlerted.add(key)
          void toast(`${snap.name}: balance is low — ${fmtMoney(w.remaining, w.currency)} (threshold ${fmtMoney(min, w.currency)})`, "Quota alert", "error", 15_000)
        } else if (ucfg.alertPct > 0 && w.usedPercent != null && w.usedPercent >= ucfg.alertPct) {
          const key = `${snap.id}:${w.label}:${w.resetsAt ?? "x"}`
          if (usageAlerted.has(key)) continue
          usageAlerted.add(key)
          const reset = w.resetsAt != null && w.resetsAt > now ? ` — resets in ${fmtDur(w.resetsAt - now)}` : ""
          void toast(`${snap.name}: ${w.label} window at ${Math.round(w.usedPercent)}% used${reset}`, "Quota alert", "warning", 15_000)
        }
      }
    }
    if (usageAlerted.size > 512) usageAlerted.clear()
  }

  // --- companion server ----------------------------------------------------

  const auth = serverAuthFromEnv()
  let server: CompanionServer | null = null
  if ((opts.port ?? 0) > 0) {
    try {
      server = await startCompanionServer(opts.port!, visible, opts, usageSnapshots, usageKeyDiags, hiddenIds, auth)
    } catch (err) {
      console.error("[opencode-quotas] companion server could not start:", err instanceof Error ? err.message : err)
    }
  }

  // --- lead-time alert loop + usage refresh loop ---------------------------

  const timer = setInterval(tick, 30_000)
  const usageTimer = setInterval(() => void refreshUsage(), Math.max(60_000, ucfg.refreshMin * 60_000))
  const usageKick = setTimeout(() => void refreshUsage(), 1_500)

  return {
    dispose: async () => {
      stopped = true
      clearInterval(timer)
      clearInterval(usageTimer)
      clearTimeout(usageKick)
      server?.stop()
    },

    config: async (config) => {
      if (!opts.command || !server) return
      config.command = config.command ?? {}
      const curlAuth = auth ? ' -u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD}"' : ""
      config.command["quotas"] = {
        template: [
          "The shell output below is the live model-provider peak-hours status fetched from the opencode-quotas companion server.",
          "Render it for the user EXACTLY as given (keep every provider row and number); do not add, drop or reinterpret rows. If the output says the server is unreachable, just say so.",
          "!`curl -sf -m 2" + curlAuth + " " + server.url + "/opencode-quotas.txt || echo OPENCODE_QUOTAS_SERVER_UNREACHABLE`",
        ].join("\n"),
        description: "Show model-provider peak/off-peak hours + live quota & balance (status table)",
      }
    },

    event: async ({ event }) => {
      if (stopped) return

      if (event.type === "server.connected") {
        // A TUI or web client just attached — greet it with the compact status.
        if (!opts.toastOnConnect) return
        const now = Date.now()
        if (now - lastConnectToast < 60_000) return
        lastConnectToast = now
        setTimeout(() => {
          const uSum = usageToastSummary(usageSnapshots())
          const footer = (server ? `\ncompanion page: ${server.url} · /quotas for the full table` : "") + (uSum ? `\nquota: ${uSum}` : "")
          void toast(toastStatus(visible) + footer, "Provider peak-hours", "info", 15_000)
        }, 800)
        return
      }

      if (event.type === "tui.command.execute") {
        if ((event.properties as { command?: string }).command !== "quotas") return
        // Instant zero-cost display (the command's template echo comes separately).
        setTimeout(() => {
          void toast(toastStatus(visible) + (server ? `\ncompanion: ${server.url}` : ""), "Provider peak-hours", "info", 20_000)
        }, 50)
        return
      }

      if (event.type === "session.created") {
        if (!opts.cardOnSessionStart) return
        const info = event.properties.info
        if (!info?.id || info.parentID) return // skip subagent / child sessions
        if (carded.has(info.id)) return
        carded.add(info.id)
        if (carded.size > 512) carded.clear()
        setTimeout(() => {
          client.session
            .prompt({
              path: { id: info.id },
              body: {
                parts: [{ type: "text", text: markdownCard(visible, Date.now(), usageSnapshots()), synthetic: true, ignored: true }],
                noReply: true,
              },
            })
            .catch(() => {
              /* session may be gone already — ignore */
            })
        }, 900)
      }
    },
  }
}

/**
 * Dual-shape default export so the plugin loads under both opencode plugin loaders:
 *  - v1 server loader: default must be a function (called with (input, options)); every
 *    non-function runtime export would abort loading with "Plugin export is not a
 *    function" — so data consts stay module-local on purpose.
 *  - v2 config loader: default must decode as { id, effect } or { id, setup } (otherwise
 *    it is dropped silently). The `id` + `setup` shape below satisfies it; `server` is
 *    what the v1 record path calls with (input, options).
 */
export default {
  id: "opencode-quotas",
  setup: (input: { options?: OpencodeQuotasOptions } & Record<string, unknown>) =>
    OpencodeQuotasPlugin(input as Parameters<typeof OpencodeQuotasPlugin>[0], input.options),
  server: (input: Parameters<typeof OpencodeQuotasPlugin>[0], options?: OpencodeQuotasOptions) =>
    OpencodeQuotasPlugin(input, options),
}
