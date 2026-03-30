import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const PLUGIN_ID = "ariboost";
const DEFAULT_WINDOW_HOURS = 5;
const DEFAULT_TOP_MODELS = 5;
const STATE_VERSION = 1;
const LLM_LOG_PATTERN = /^(?:INFO|WARN|ERROR)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\s+.*?service=llm\s+providerID=([A-Za-z0-9._:/-]+)\s+modelID=([A-Za-z0-9._:/-]+)\b.*\bstream\b/;

function createDefaultState() {
  return {
    version: STATE_VERSION,
    totalRequests: 0,
    byModel: {},
    recentRequests: [],
    files: {},
    updatedAt: null,
  };
}

function toModelKey(providerID, modelID) {
  return `${providerID}/${modelID}`;
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

    return {
      ...createDefaultState(),
      ...parsed,
      byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {},
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      recentRequests: Array.isArray(parsed.recentRequests) ? parsed.recentRequests : [],
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
  state.totalRequests += 1;
  state.byModel[key] = (state.byModel[key] || 0) + 1;
  state.recentRequests.push(request);
}

function pruneRecentRequests(state, now, windowMs) {
  state.recentRequests = state.recentRequests.filter((request) => now - request.ts <= windowMs);
}

async function scanLogFile(filePath, state) {
  const fileState = state.files[filePath] || { offset: 0, remainder: "" };
  const buffer = await fs.readFile(filePath);

  if (buffer.length < fileState.offset) {
    fileState.offset = 0;
    fileState.remainder = "";
  }

  const appended = buffer.subarray(fileState.offset).toString("utf8");
  const combined = `${fileState.remainder || ""}${appended}`;
  const lines = combined.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(combined);
  fileState.remainder = endsWithNewline ? "" : lines.pop() || "";

  for (const line of lines) {
    const request = parseLogLine(line);
    if (request) {
      addRequestToState(state, request);
    }
  }

  fileState.offset = buffer.length;
  state.files[filePath] = fileState;
}

async function collectStats(hours) {
  const windowMs = hours * 60 * 60 * 1000;
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

  pruneRecentRequests(state, now, windowMs);
  state.updatedAt = new Date(now).toISOString();
  await saveState(statePath, state);

  const recentByModel = {};
  for (const request of state.recentRequests) {
    const key = toModelKey(request.providerID, request.modelID);
    recentByModel[key] = (recentByModel[key] || 0) + 1;
  }

  return {
    logDir,
    statePath,
    totalRequests: state.totalRequests,
    recentRequests: state.recentRequests.length,
    byModel: state.byModel,
    recentByModel,
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

export default AriboostPlugin;
