import { DEFAULT_WAKE_PROMPT } from "./prompt.ts";

type PhoneActivity = {
  app_name?: string | null;
  action?: string | null;
  opened_at: string;
};

type ChatActivityState = {
  currentlyActive: boolean;
  lastEndedAt: Date | null;
};

type RunRecord = { id: number };

type RecentDecision = {
  started_at: string;
  model_decided_at?: string | null;
  status: "pushed" | "no_action";
  reason?: string | null;
  push_title?: string | null;
  push_body?: string | null;
};

type RuntimeSettings = {
  enabled: boolean;
  attentionWindowStartMinute: number;
  attentionWindowEndMinute: number;
  attentionWakeAfterMinutes: number;
  offHoursWakeAfterMinutes: number;
  attentionCheckIntervalMinutes: number;
  offHoursCheckIntervalMinutes: number;
  minPushGapMinutes: number;
  chatAppName: string;
  maxTokens: number;
  wakeIfNoActivity: boolean;
  weatherEnabled: boolean;
  weatherLocationName: string;
  weatherLat: number | null;
  weatherLon: number | null;
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const SUPABASE_URL = readRequiredEnv("SUPABASE_URL").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const HEARTBEAT_SECRET = readRequiredEnv("HEARTBEAT_SECRET");
const TIME_ZONE = resolveTimeZone(Deno.env.get("TIME_ZONE") || "Asia/Shanghai");

function readRequiredEnv(name: string): string {
  const value = String(Deno.env.get(name) || "").trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function readNumberEnv(name: string, fallback: number, min = -Infinity, max = Infinity): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = String(Deno.env.get(name) || "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveTimeZone(raw: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date(0));
    return raw;
  } catch {
    return "Asia/Shanghai";
  }
}

function getDateParts(date = new Date()): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function getMinuteOfDay(date = new Date()): number {
  const parts = getDateParts(date);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function formatDateTime(date = new Date()): string {
  const parts = getDateParts(date);
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    weekday: "short"
  }).format(date);
  return `${parts.year}-${parts.month}-${parts.day} ${weekday} ${parts.hour}:${parts.minute}`;
}

function isAttentionWindow(settings: RuntimeSettings, date = new Date()): boolean {
  const minuteOfDay = getMinuteOfDay(date);
  const start = settings.attentionWindowStartMinute;
  const end = settings.attentionWindowEndMinute;
  if (start === end) return true;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

function getWakeAfterMinutes(settings: RuntimeSettings, date = new Date()): number {
  return isAttentionWindow(settings, date)
    ? settings.attentionWakeAfterMinutes
    : settings.offHoursWakeAfterMinutes;
}

function getModelDecisionIntervalMinutes(settings: RuntimeSettings, date = new Date()): number {
  return isAttentionWindow(settings, date)
    ? settings.attentionCheckIntervalMinutes
    : settings.offHoursCheckIntervalMinutes;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function databaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function numberFromSetting(value: unknown, fallback: number, min: number, max = Infinity): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function nullableNumberFromEnv(name: string): number | null {
  const raw = String(Deno.env.get(name) || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchRuntimeSettings(): Promise<RuntimeSettings> {
  const defaults: RuntimeSettings = {
    enabled: true,
    attentionWindowStartMinute: readNumberEnv("ATTENTION_WINDOW_START_MINUTE", 1140, 0, 1439),
    attentionWindowEndMinute: readNumberEnv("ATTENTION_WINDOW_END_MINUTE", 120, 0, 1439),
    attentionWakeAfterMinutes: readNumberEnv("DAY_WAKE_AFTER_MINUTES", 45, 1),
    offHoursWakeAfterMinutes: readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 240, 1),
    attentionCheckIntervalMinutes: readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 30, 1),
    offHoursCheckIntervalMinutes: readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, 1),
    minPushGapMinutes: readNumberEnv("MIN_PUSH_GAP_MINUTES", 0, 0),
    chatAppName: String(Deno.env.get("CHAT_APP_NAME") || "Kelivo").trim(),
    maxTokens: readNumberEnv("MAX_TOKENS", 256, 32, 2048),
    wakeIfNoActivity: readBooleanEnv("WAKE_IF_NO_ACTIVITY", false),
    weatherEnabled: readBooleanEnv("WEATHER_ENABLED", false),
    weatherLocationName: String(Deno.env.get("WEATHER_LOCATION_NAME") || "Hangzhou").trim(),
    weatherLat: nullableNumberFromEnv("WEATHER_LAT"),
    weatherLon: nullableNumberFromEnv("WEATHER_LON")
  };

  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dylan_heartbeat_settings?select=*&id=eq.true&limit=1`,
    { headers: databaseHeaders() },
    15_000
  );
  if (!response.ok) {
    console.warn(`读取 dylan_heartbeat_settings 失败（HTTP ${response.status}），使用环境变量默认值`);
    return defaults;
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return defaults;

  return {
    enabled: row.enabled !== false,
    attentionWindowStartMinute: numberFromSetting(
      row.attention_window_start_minute,
      defaults.attentionWindowStartMinute,
      0,
      1439
    ),
    attentionWindowEndMinute: numberFromSetting(
      row.attention_window_end_minute,
      defaults.attentionWindowEndMinute,
      0,
      1439
    ),
    attentionWakeAfterMinutes: numberFromSetting(
      row.attention_wake_after_minutes,
      defaults.attentionWakeAfterMinutes,
      1
    ),
    offHoursWakeAfterMinutes: numberFromSetting(
      row.off_hours_wake_after_minutes,
      defaults.offHoursWakeAfterMinutes,
      1
    ),
    attentionCheckIntervalMinutes: numberFromSetting(
      row.attention_check_interval_minutes,
      defaults.attentionCheckIntervalMinutes,
      1
    ),
    offHoursCheckIntervalMinutes: numberFromSetting(
      row.off_hours_check_interval_minutes,
      defaults.offHoursCheckIntervalMinutes,
      1
    ),
    minPushGapMinutes: numberFromSetting(row.min_push_gap_minutes, defaults.minPushGapMinutes, 0),
    chatAppName: String(row.chat_app_name || defaults.chatAppName).trim(),
    maxTokens: numberFromSetting(row.max_tokens, defaults.maxTokens, 32, 2048),
    wakeIfNoActivity: typeof row.wake_if_no_activity === "boolean"
      ? row.wake_if_no_activity
      : defaults.wakeIfNoActivity,
    weatherEnabled: typeof row.weather_enabled === "boolean"
      ? row.weather_enabled
      : defaults.weatherEnabled,
    weatherLocationName: String(row.weather_location_name || defaults.weatherLocationName).trim(),
    weatherLat: row.weather_lat !== null && row.weather_lat !== undefined &&
        Number.isFinite(Number(row.weather_lat))
      ? Number(row.weather_lat)
      : defaults.weatherLat,
    weatherLon: row.weather_lon !== null && row.weather_lon !== undefined &&
        Number.isFinite(Number(row.weather_lon))
      ? Number(row.weather_lon)
      : defaults.weatherLon
  };
}

async function fetchPhoneActivity(chatAppName: string): Promise<PhoneActivity[]> {
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/phone_activity?select=app_name,action,opened_at&order=opened_at.desc&limit=100`,
    { headers: databaseHeaders() },
    15_000
  );
  if (!response.ok) {
    throw new Error(`Supabase phone_activity 查询失败（HTTP ${response.status}）`);
  }
  const records = await response.json();
  const recentRecords: PhoneActivity[] = Array.isArray(records) ? records : [];
  const normalizedChatAppName = chatAppName.trim();
  if (!normalizedChatAppName) return recentRecords;

  // The general activity feed can be very busy, so the last Kelivo session may
  // fall outside the latest 100 rows. Fetch its last named event separately,
  // plus the immediately following event (blank close rows identify the app
  // through the preceding open event).
  const chatResponse = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/phone_activity?select=app_name,action,opened_at&app_name=ilike.${encodeURIComponent(normalizedChatAppName)}&order=opened_at.desc&limit=1`,
    { headers: databaseHeaders() },
    15_000
  );
  if (!chatResponse.ok) {
    throw new Error(`Supabase Kelivo 活动查询失败（HTTP ${chatResponse.status}）`);
  }
  const chatRows = await chatResponse.json();
  const lastChatRecord: PhoneActivity | undefined = Array.isArray(chatRows) ? chatRows[0] : undefined;
  if (!lastChatRecord?.opened_at) return recentRecords;

  const followingResponse = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/phone_activity?select=app_name,action,opened_at&opened_at=gt.${encodeURIComponent(lastChatRecord.opened_at)}&order=opened_at.asc&limit=1`,
    { headers: databaseHeaders() },
    15_000
  );
  if (!followingResponse.ok) {
    throw new Error(`Supabase Kelivo 后续活动查询失败（HTTP ${followingResponse.status}）`);
  }
  const followingRows = await followingResponse.json();
  const anchorRecords: PhoneActivity[] = [
    lastChatRecord,
    ...(Array.isArray(followingRows) ? followingRows : [])
  ];
  const seen = new Set<string>();
  return [...recentRecords, ...anchorRecords].filter((record) => {
    const key = `${record.opened_at}\u0000${record.action}\u0000${record.app_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getRunSlot(date = new Date()): string {
  const intervalMinutes = readNumberEnv("CRON_INTERVAL_MINUTES", 10, 1, 1440);
  const slotMs = intervalMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / slotMs) * slotMs).toISOString();
}

async function claimRun(runSlot: string): Promise<number | null> {
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dylan_heartbeat_runs`,
    {
      method: "POST",
      headers: databaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({ run_slot: runSlot, status: "running" })
    },
    15_000
  );

  if (response.status === 409) return null;
  if (!response.ok) {
    throw new Error(`创建运行记录失败（HTTP ${response.status}）：${(await response.text()).slice(0, 300)}`);
  }
  const rows = await response.json() as RunRecord[];
  return rows[0]?.id ?? null;
}

async function updateRun(id: number, values: Record<string, unknown>): Promise<void> {
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dylan_heartbeat_runs?id=eq.${id}`,
    {
      method: "PATCH",
      headers: databaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ ...values, finished_at: new Date().toISOString() })
    },
    15_000
  );
  if (!response.ok) console.error(`更新运行记录失败（HTTP ${response.status}）`);
}

async function fetchRecentDecisions(): Promise<RecentDecision[]> {
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dylan_heartbeat_runs?select=started_at,model_decided_at,status,reason,push_title,push_body&status=in.(pushed,no_action)&order=model_decided_at.desc.nullslast,started_at.desc&limit=20`,
    { headers: databaseHeaders() },
    15_000
  );
  if (!response.ok) return [];
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

function getChatActivityState(
  records: PhoneActivity[],
  settings: RuntimeSettings
): ChatActivityState {
  const chatAppName = settings.chatAppName.trim().toLowerCase();
  const sorted = [...records].sort(
    (a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
  );
  let activeApp: string | null = null;
  let lastChatEnd: Date | null = null;
  let lastChatOpen: Date | null = null;

  for (const record of sorted) {
    const time = new Date(record.opened_at);
    if (Number.isNaN(time.getTime())) continue;
    const action = String(record.action || "").trim().toLowerCase();
    const rawAppName = String(record.app_name || "").trim();
    const appName = rawAppName && rawAppName.toUpperCase() !== "EMPTY"
      ? rawAppName.toLowerCase()
      : null;

    if (action === "open") {
      if (activeApp === chatAppName && appName !== chatAppName) {
        lastChatEnd = time;
      }
      activeApp = appName;
      if (appName === chatAppName) lastChatOpen = time;
      continue;
    }

    if (action === "close") {
      const closingApp = appName || activeApp;
      if (closingApp === chatAppName) lastChatEnd = time;
      if (!appName || activeApp === closingApp) activeApp = null;
    }
  }

  if (activeApp === chatAppName) {
    return { currentlyActive: true, lastEndedAt: null };
  }
  return { currentlyActive: false, lastEndedAt: lastChatEnd || lastChatOpen };
}

function formatPhoneActivityContext(records: PhoneActivity[]): string {
  if (!records.length) return "";
  const now = new Date();
  const sortedRecords = [...records].sort(
    (a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
  );
  const sessions = new Map<string, { opens: Date[]; closes: Date[]; lastActivity: Date }>();
  const opens: Array<{ name: string; time: Date }> = [];

  for (const record of sortedRecords) {
    const time = new Date(record.opened_at);
    if (Number.isNaN(time.getTime())) continue;
    if (record.action !== "close") {
      const name = record.app_name || "未知";
      opens.push({ name, time });
      const current = sessions.get(name) || { opens: [], closes: [], lastActivity: time };
      current.opens.push(time);
      if (time > current.lastActivity) current.lastActivity = time;
      sessions.set(name, current);
    } else {
      const name = record.app_name && record.app_name !== "EMPTY"
        ? record.app_name
        : opens.at(-1)?.name;
      if (!name) continue;
      const current = sessions.get(name) || { opens: [], closes: [], lastActivity: time };
      current.closes.push(time);
      if (time > current.lastActivity) current.lastActivity = time;
      sessions.set(name, current);
    }
  }

  const lines = ["## 用户手机使用记录（最近）"];
  const sortedSessions = [...sessions.entries()].sort(
    (a, b) => b[1].lastActivity.getTime() - a[1].lastActivity.getTime()
  );
  for (const [appName, info] of sortedSessions) {
    const diffMinutes = Math.max(0, Math.floor((now.getTime() - info.lastActivity.getTime()) / 60_000));
    const lastText = diffMinutes < 1
      ? "刚刚"
      : diffMinutes < 60
      ? `${diffMinutes}分钟前`
      : `${Math.floor(diffMinutes / 60)}小时前`;
    lines.push(`- ${appName}：最近${lastText}，打开${info.opens.length}次`);
  }
  const latestTime = new Date(records[0].opened_at);
  const totalDiffMinutes = Math.max(0, Math.floor((now.getTime() - latestTime.getTime()) / 60_000));
  lines.push(`\n最后一次手机活动：${totalDiffMinutes}分钟前`);
  return lines.join("\n");
}

function formatWakeHistory(decisions: RecentDecision[]): string {
  if (!decisions.length) return "";
  return [...decisions].reverse().map((decision) => {
    const time = formatDateTime(new Date(decision.model_decided_at || decision.started_at));
    if (decision.status === "pushed") {
      const body = String(decision.push_body || "").slice(0, 500);
      return `[AI] （${time} 刚刚给用户发了Bark推送：${decision.push_title || "无标题"}｜${body}）`;
    }
    return `[AI] （${time} 自动唤醒：本次未发送推送｜原因：${decision.reason || "模型选择静默"}）`;
  }).join("\n\n");
}

function buildWakePrompt(
  currentTime: string,
  diffMinutes: number,
  phoneContext: string
): string {
  const template = Deno.env.get("WAKE_PROMPT_TEMPLATE")?.replace(/\\n/g, "\n") || DEFAULT_WAKE_PROMPT;
  return template
    .replace(/\$\{currentTime\}/g, currentTime)
    .replace(/\$\{diffMinutes\}/g, String(diffMinutes))
    .replace(/\$\{phoneState\}/g, phoneContext)
    .replace(/\$\{phoneContext\}/g, phoneContext);
}

async function fetchWeatherContext(settings: RuntimeSettings): Promise<string> {
  if (!settings.weatherEnabled) return "";
  const latitude = settings.weatherLat;
  const longitude = settings.weatherLon;
  if (latitude === null || longitude === null) return "";

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code"
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  const response = await fetchWithTimeout(url, {}, 8_000);
  if (!response.ok) return "";
  const data = await response.json();
  const current = data.current || {};
  return [
    "## 天气信息",
    `- 位置：${settings.weatherLocationName || "当前位置"}`,
    `- 温度：${current.temperature_2m ?? "未知"}°C，体感 ${current.apparent_temperature ?? "未知"}°C`,
    `- 湿度：${current.relative_humidity_2m ?? "未知"}%`,
    `- 降雨：${current.precipitation ?? "未知"}mm`
  ].join("\n");
}

function extractDiary(text: string): { diary: string; remaining: string } {
  const entries: string[] = [];
  const remaining = text.replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_match, content) => {
    const clean = String(content || "").trim();
    if (clean) entries.push(clean);
    return "";
  }).trim();
  return { diary: entries.join("\n\n"), remaining };
}

function parsePushText(text: string): { title: string; body: string } | null {
  let clean = text.trim();
  const barkMatch = clean.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/i);
  clean = barkMatch
    ? barkMatch[1].trim()
    : clean.replace(/^\[BARK\]\s*/i, "").replace(/\s*\[\/BARK\]$/i, "").trim();
  clean = clean.replace(/^标题[：:]\s*/gm, "").replace(/^正文[：:]\s*/gm, "");
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  let title = lines.length === 1 ? "4.6" : lines[0];
  const body = (lines.length === 1 ? lines[0] : lines.slice(1).join(" ")).slice(0, 500);
  if (!title.startsWith("4.6")) title = `4.6｜${title}`;
  return { title: title.slice(0, 100), body };
}

async function callModel(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
) {
  const targetUrl = readRequiredEnv("TARGET_API_URL");
  const targetKey = readRequiredEnv("TARGET_API_KEY");
  const model = readRequiredEnv("MODEL_NAME");
  const response = await fetchWithTimeout(
    targetUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${targetKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.8,
        top_p: 0.95,
        stream: false
      })
    },
    readNumberEnv("MODEL_TIMEOUT_MS", 90_000, 5_000, 140_000)
  );
  const text = await response.text();
  let data: Record<string, any>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`模型返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  return {
    content: String(data.choices?.[0]?.message?.content || "").trim(),
    usage: data.usage || null
  };
}

async function sendBark(title: string, body: string): Promise<void> {
  const barkKey = readRequiredEnv("BARK_KEY");
  const payload: Record<string, string> = { title, body, device_key: barkKey };
  const icon = String(Deno.env.get("CUSTOM_ICON_URL") || "").trim();
  if (icon) payload.icon = icon;

  const response = await fetchWithTimeout(
    "https://api.day.app/push",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    20_000
  );
  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {}
  if (!response.ok || (data.code && data.code !== 200)) {
    throw new Error(`Bark 推送失败（HTTP ${response.status}）：${String(data.message || text).slice(0, 300)}`);
  }
}

async function handleHeartbeat(): Promise<Record<string, unknown>> {
  const now = new Date();
  const runSlot = getRunSlot(now);
  const runId = await claimRun(runSlot);
  if (!runId) return { ok: true, action: "duplicate_skipped", runSlot };
  let modelDecidedAt: string | null = null;

  try {
    const settings = await fetchRuntimeSettings();
    if (!settings.enabled) {
      await updateRun(runId, { status: "skipped", reason: "disabled" });
      return { ok: true, action: "skipped", reason: "disabled" };
    }
    const phoneActivity = await fetchPhoneActivity(settings.chatAppName);
    const chatState = getChatActivityState(phoneActivity, settings);
    if (chatState.currentlyActive) {
      await updateRun(runId, { status: "skipped", reason: "kelivo_currently_active" });
      return { ok: true, action: "skipped", reason: "kelivo_currently_active" };
    }
    if (!chatState.lastEndedAt && !settings.wakeIfNoActivity) {
      await updateRun(runId, { status: "skipped", reason: "no_kelivo_end_data" });
      return { ok: true, action: "skipped", reason: "no_kelivo_end_data" };
    }

    const effectiveLastKelivoEnd = chatState.lastEndedAt ||
      new Date(now.getTime() - (getWakeAfterMinutes(settings, now) + 1) * 60_000);
    const diffMinutes = Math.max(
      0,
      Math.floor((now.getTime() - effectiveLastKelivoEnd.getTime()) / 60_000)
    );
    const wakeAfterMinutes = getWakeAfterMinutes(settings, now);
    if (diffMinutes < wakeAfterMinutes) {
      await updateRun(runId, {
        status: "skipped",
        reason: "kelivo_recently_ended",
        last_kelivo_end_at: effectiveLastKelivoEnd.toISOString()
      });
      return { ok: true, action: "skipped", reason: "kelivo_recently_ended", diffMinutes };
    }

    const recentDecisions = await fetchRecentDecisions();
    const latestDecision = recentDecisions[0];
    if (latestDecision) {
      const lastDecisionTime = new Date(latestDecision.model_decided_at || latestDecision.started_at);
      const minutesSinceDecision = Math.floor((now.getTime() - lastDecisionTime.getTime()) / 60_000);
      const modelDecisionIntervalMinutes = getModelDecisionIntervalMinutes(settings, now);
      if (minutesSinceDecision < modelDecisionIntervalMinutes) {
        await updateRun(runId, {
          status: "skipped",
          reason: "model_cooldown",
          last_kelivo_end_at: effectiveLastKelivoEnd.toISOString()
        });
        return {
          ok: true,
          action: "skipped",
          reason: "model_cooldown",
          minutesSinceDecision
        };
      }
    }

    const minPushGapMinutes = settings.minPushGapMinutes;
    const latestPush = recentDecisions.find((decision) => decision.status === "pushed");
    if (latestPush && minPushGapMinutes > 0) {
      const minutesSincePush = Math.floor(
        (now.getTime() - new Date(latestPush.model_decided_at || latestPush.started_at).getTime()) / 60_000
      );
      if (minutesSincePush < minPushGapMinutes) {
        await updateRun(runId, {
          status: "skipped",
          reason: "push_cooldown",
          last_kelivo_end_at: effectiveLastKelivoEnd.toISOString()
        });
        return { ok: true, action: "skipped", reason: "push_cooldown", minutesSincePush };
      }
    }

    const phoneContext = formatPhoneActivityContext(phoneActivity);
    const weatherContext = await fetchWeatherContext(settings);
    const context = [weatherContext, phoneContext].filter(Boolean).join("\n\n");
    const wakePrompt = buildWakePrompt(formatDateTime(now), diffMinutes, context);
    const historyText = formatWakeHistory(recentDecisions);
    const userContent = historyText
      ? `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
      : "你现在处于后台自主唤醒状态。\n用户并没有给你发消息。\n请根据当前时间和可用信息决定是否主动联系用户。";
    const modelResult = await callModel(
      [
        { role: "system", content: wakePrompt },
        { role: "user", content: userContent }
      ],
      settings.maxTokens
    );
    modelDecidedAt = new Date().toISOString();

    const diaryResult = extractDiary(modelResult.content);
    const diaryContent = readBooleanEnv("DIARY_ENABLED", true)
      ? diaryResult.diary
      : "";
    const diarySaved = Boolean(diaryContent);
    const diaryFields = diarySaved ? { diary_content: diaryContent } : {};
    const aiText = diaryResult.remaining;
    const usage = modelResult.usage || {};
    const usageFields = {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0
    };

    if (!aiText) {
      await updateRun(runId, {
        status: "no_action",
        reason: diarySaved ? "diary_only" : "empty_model_response",
        last_kelivo_end_at: effectiveLastKelivoEnd.toISOString(),
        model_decided_at: modelDecidedAt,
        ...diaryFields,
        ...usageFields
      });
      return { ok: true, action: "no_action", reason: diarySaved ? "diary_only" : "empty_model_response" };
    }

    const noAction = aiText.match(/^\[NO_ACTION\]\s*(.{0,80})?/i);
    if (noAction) {
      await updateRun(runId, {
        status: "no_action",
        reason: String(noAction[1] || "").trim() || "model_decision",
        last_kelivo_end_at: effectiveLastKelivoEnd.toISOString(),
        model_decided_at: modelDecidedAt,
        ...diaryFields,
        ...usageFields
      });
      return { ok: true, action: "no_action" };
    }

    const push = parsePushText(aiText);
    if (!push) {
      await updateRun(runId, {
        status: "no_action",
        reason: "empty_push_content",
        last_kelivo_end_at: effectiveLastKelivoEnd.toISOString(),
        model_decided_at: modelDecidedAt,
        ...diaryFields,
        ...usageFields
      });
      return { ok: true, action: "no_action", reason: "empty_push_content" };
    }

    await sendBark(push.title, push.body);
    await updateRun(runId, {
      status: "pushed",
      push_title: push.title,
      push_body: push.body,
      last_kelivo_end_at: effectiveLastKelivoEnd.toISOString(),
      model_decided_at: modelDecidedAt,
      ...diaryFields,
      ...usageFields
    });
    return { ok: true, action: "pushed", title: push.title, diffMinutes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(runId, {
      status: "error",
      reason: message.slice(0, 500),
      ...(modelDecidedAt ? { model_decided_at: modelDecidedAt } : {})
    });
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: JSON_HEADERS });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: JSON_HEADERS
    });
  }
  if (request.headers.get("x-heartbeat-secret") !== HEARTBEAT_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: JSON_HEADERS
    });
  }

  try {
    const result = await handleHeartbeat();
    return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: JSON_HEADERS
    });
  }
});
