import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const PLUGIN_ID = "ariboost";
const DEFAULT_WINDOW_HOURS = 5;
const DEFAULT_TOP_MODELS = 5;
const RECENT_RETENTION_HOURS = 24 * 30;
const STATE_VERSION = 2;

// FIX 1: Nới lỏng Regex, bỏ dấu `^` ở đầu để chống vỡ trận nếu log có dính mã màu ANSI hoặc prefix lạ.
const LLM_LOG_PATTERN = /(?:INFO|WARN|ERROR)\s+(\d{4}-\d{2}-\d{2}T[^\s]+)\s+.*?service=llm\s+providerID=([A-Za-z0-9._:/-]+)\s+modelID=([A-Za-z0-9._:/-]+)/;

function createDefaultState() {
  return {
    version: STATE_VERSION,
    totalRequests: 0,
    byModel: {},
    recentBuckets: {},
    files: {},
    updatedAt: null,
  };
}

function toModelKey(providerID, modelID) {
  return `${providerID}/${modelID}`;
}

function toHourBucket(ts) {
  const hour = new Date(ts);
  hour.setMinutes(0, 0, 0);
  return hour.toISOString();
}

function createHourlyBuckets(requests) {
  const buckets = {};

  for (const request of requests) {
    const bucket = toHourBucket(request.ts);
    const key = toModelKey(request.providerID, request.modelID);
    if (!buckets[bucket]) {
      buckets[bucket] = {};
    }

    buckets[bucket][key] = (buckets[bucket][key] || 0) + 1;
  }

  return buckets;
}

function getHomeDirectory() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || ".";
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean))];
}

function getOpencodeDataCandidates() {
  const home = getHomeDirectory();
  return uniquePaths([
    process.env.OPENCODE_DATA_DIR,
    process.env.OPENCODE_HOME,
    path.join(home, ".local", "share", "opencode"),
    path.join(home, ".config", "opencode"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode") : null,
  ]);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOpencodeDataDir() {
  for (const candidate of getOpencodeDataCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return getOpencodeDataCandidates()[0];
}

async function resolveLogDir() {
  if (process.env.ARIBOOST_LOG_DIR) {
    return process.env.ARIBOOST_LOG_DIR;
  }

  const dataDir = await resolveOpencodeDataDir();
  return path.join(dataDir, "log");
}

async function resolveStatePath() {
  if (process.env.ARIBOOST_STATE_FILE) {
    return process.env.ARIBOOST_STATE_FILE;
  }

  const dataDir = await resolveOpencodeDataDir();
  return path.join(dataDir, "plugins-data", PLUGIN_ID, "state.json");
}

async function loadState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return createDefaultState();
    }

    const recentRequests = Array.isArray(parsed.recentRequests) ? parsed.recentRequests : [];
    const recentBuckets = parsed.recentBuckets && typeof parsed.recentBuckets === "object"
      ? parsed.recentBuckets
      : createHourlyBuckets(recentRequests);

    return {
      ...createDefaultState(),
      ...parsed,
      byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {},
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      recentBuckets,
      version: STATE_VERSION,
    };
  } catch {
    return createDefaultState();
  }
}

async function saveState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseLogLine(line) {
  const match = line.match(LLM_LOG_PATTERN);
  if (!match) {
    return null;
  }

  const timestamp = new Date(match[1]).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return {
    ts: timestamp,
    providerID: match[2],
    modelID: match[3],
  };
}

function addRequestToState(state, request) {
  const key = toModelKey(request.providerID, request.modelID);
  const bucket = toHourBucket(request.ts);
  state.totalRequests += 1;
  state.byModel[key] = (state.byModel[key] || 0) + 1;
  if (!state.recentBuckets[bucket]) {
    state.recentBuckets[bucket] = {};
  }

  state.recentBuckets[bucket][key] = (state.recentBuckets[bucket][key] || 0) + 1;
}

function pruneRecentBuckets(state, now, windowMs) {
  for (const bucket of Object.keys(state.recentBuckets)) {
    if (now - new Date(bucket).getTime() > windowMs) {
      delete state.recentBuckets[bucket];
    }
  }
}

function collectRecentBreakdown(recentBuckets, now, windowMs) {
  const byModel = {};
  let totalRequests = 0;

  for (const [bucket, counts] of Object.entries(recentBuckets)) {
    if (now - new Date(bucket).getTime() > windowMs) {
      continue;
    }

    for (const [model, count] of Object.entries(counts)) {
      byModel[model] = (byModel[model] || 0) + count;
      totalRequests += count;
    }
  }

  return { byModel, totalRequests };
}

// FIX 2: Viết lại hoàn toàn logic scan log để đọc Text an toàn, tránh vỡ buffer và rò rỉ bộ nhớ.
async function scanLogFile(filePath, state) {
  const fileState = state.files[filePath] || { offset: 0, remainder: "" };
  const fileStat = await fs.stat(filePath);

  // Nếu file bị rotate (size nhỏ hơn offset) hoặc là một file ctime mới tinh -> Reset offset
  if ((fileState.createdAt && fileStat.ctimeMs > fileState.createdAt) || fileStat.size < fileState.offset) {
    fileState.offset = 0;
    fileState.remainder = "";
  }

  fileState.createdAt = fileStat.ctimeMs;

  // Đọc nguyên cục file dưới dạng UTF-8 string, xử lý dứt điểm bài toán nứt byte
  const content = await fs.readFile(filePath, "utf8");
  
  // Slice chuỗi từ vị trí offset cũ
  const appended = content.slice(fileState.offset);
  const combined = `${fileState.remainder || ""}${appended}`;
  
  // Tách dòng
  const lines = combined.split(/\r?\n/);
  
  // Xử lý line cuối cùng (có thể là dòng đang ghi dở chưa có \n)
  const endsWithNewline = /\r?\n$/.test(combined);
  fileState.remainder = endsWithNewline ? "" : lines.pop() || "";

  // Bắt đầu loop parse
  for (const line of lines) {
    if (!line.trim()) continue; // Bỏ qua dòng trống rác
    const request = parseLogLine(line);
    if (request) {
      addRequestToState(state, request);
    }
  }

  // Cập nhật lại offset mới dựa trên length của string đã đọc xong
  fileState.offset = content.length;
  state.files[filePath] = fileState;
}

async function collectStats(hours) {
  const windowMs = hours * 60 * 60 * 1000;
  const retentionMs = RECENT_RETENTION_HOURS * 60 * 60 * 1000;
  const now = Date.now();
  const logDir = await resolveLogDir();
  const statePath = await resolveStatePath();
  const state = await loadState(statePath);

  await fs.mkdir(logDir, { recursive: true });
  const entries = await fs.readdir(logDir, { withFileTypes: true });
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => path.join(logDir, entry.name))
    .sort();

  const activeFiles = new Set(logFiles);
  for (const existingFile of Object.keys(state.files)) {
    if (!activeFiles.has(existingFile)) {
      delete state.files[existingFile];
    }
  }

  for (const filePath of logFiles) {
    await scanLogFile(filePath, state);
  }

  pruneRecentBuckets(state, now, retentionMs);
  state.updatedAt = new Date(now).toISOString();
  await saveState(statePath, state);

  const recent = collectRecentBreakdown(state.recentBuckets, now, windowMs);

  return {
    logDir,
    statePath,
    totalRequests: state.totalRequests,
    recentRequests: recent.totalRequests,
    byModel: state.byModel,
    recentByModel: recent.byModel,
    trackedFiles: logFiles.length,
    updatedAt: state.updatedAt,
  };
}

function formatBreakdown(title, breakdown, topN) {
  const entries = Object.entries(breakdown)
    .sort((left, right) => right[1] - left[1])
    .slice(0, topN);

  if (entries.length === 0) {
    return `${title}: none`;
  }

  return `${title}: ${entries.map(([key, value]) => `${key} (${value})`).join(", ")}`;
}

function formatStats(result, hours, topN) {
  return [
    `Ariboost model request stats`,
    `- Total tracked requests: ${result.totalRequests}`,
    `- Last ${hours} hours: ${result.recentRequests}`,
    `- Log files scanned: ${result.trackedFiles}`,
    `- Updated at: ${result.updatedAt}`,
    `- ${formatBreakdown("Top models overall", result.byModel, topN)}`,
    `- ${formatBreakdown(`Top models last ${hours}h`, result.recentByModel, topN)}`,
    `- Log directory: ${result.logDir}`,
    `- State file: ${result.statePath}`,
  ].join("\n");
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AriboostPlugin() {
  return {
    tool: {
      ariboost_stats: tool({
        description: "Count OpenCode model requests from local llm log lines across all tracked time and the recent window.",
        args: {
          hours: tool.schema.number().int().positive().optional().describe("Recent time window in hours. Defaults to 5."),
          top: tool.schema.number().int().positive().max(20).optional().describe("How many model entries to show in each breakdown. Defaults to 5."),
        },
        async execute(args, context) {
          const hours = args.hours ?? DEFAULT_WINDOW_HOURS;
          const top = args.top ?? DEFAULT_TOP_MODELS;
          const stats = await collectStats(hours);

          context.metadata({
            title: "Ariboost Stats",
            metadata: {
              totalRequests: stats.totalRequests,
              recentRequests: stats.recentRequests,
              hours,
              top,
            },
          });

          return formatStats(stats, hours, top);
        },
      }),
    },
  };
}

export const __test = {
  collectRecentBreakdown,
  collectStats,
  createHourlyBuckets,
  createDefaultState,
  loadState,
  parseLogLine,
  pruneRecentBuckets,
  saveState,
  scanLogFile,
  toHourBucket,
};

export default AriboostPlugin;
