import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { __test } from "./index.mjs";

async function withTempDir(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ariboost-"));
  try {
    await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("parseLogLine accepts timezone timestamps without stream", () => {
  const parsed = __test.parseLogLine(
    "INFO  2026-03-30T09:20:52.123+07:00 foo service=llm providerID=openai modelID=gpt-5.4 extra=data",
  );

  assert.ok(parsed);
  assert.equal(parsed.providerID, "openai");
  assert.equal(parsed.modelID, "gpt-5.4");
  assert.equal(parsed.ts, new Date("2026-03-30T09:20:52.123+07:00").getTime());
});

test("recent window stays accurate across repeated queries", async () => {
  await withTempDir(async (tempDir) => {
    const logDir = path.join(tempDir, "log");
    const statePath = path.join(tempDir, "state.json");
    await fs.mkdir(logDir, { recursive: true });

    const now = new Date("2026-03-31T12:00:00.000Z").getTime();
    const logFile = path.join(logDir, "session.log");
    await fs.writeFile(
      logFile,
      [
        "INFO  2026-03-31T01:00:00.000Z a service=llm providerID=openai modelID=gpt-4.1",
        "INFO  2026-03-31T04:00:00.000Z b service=llm providerID=openai modelID=gpt-5.4",
        "INFO  2026-03-31T10:00:00.000Z c service=llm providerID=openai modelID=gpt-5.4",
      ].join("\n") + "\n",
      "utf8",
    );

    const originalLogDir = process.env.ARIBOOST_LOG_DIR;
    const originalStatePath = process.env.ARIBOOST_STATE_FILE;
    const originalNow = Date.now;

    process.env.ARIBOOST_LOG_DIR = logDir;
    process.env.ARIBOOST_STATE_FILE = statePath;
    Date.now = () => now;

    try {
      const first = await __test.collectStats(5);
      const second = await __test.collectStats(12);

      assert.equal(first.totalRequests, 3);
      assert.equal(first.recentRequests, 1);
      assert.deepEqual(first.recentByModel, { "openai/gpt-5.4": 1 });

      assert.equal(second.totalRequests, 3);
      assert.equal(second.recentRequests, 3);
      assert.deepEqual(second.recentByModel, {
        "openai/gpt-4.1": 1,
        "openai/gpt-5.4": 2,
      });
    } finally {
      if (originalLogDir === undefined) {
        delete process.env.ARIBOOST_LOG_DIR;
      } else {
        process.env.ARIBOOST_LOG_DIR = originalLogDir;
      }

      if (originalStatePath === undefined) {
        delete process.env.ARIBOOST_STATE_FILE;
      } else {
        process.env.ARIBOOST_STATE_FILE = originalStatePath;
      }

      Date.now = originalNow;
    }
  });
});

test("loadState migrates legacy recentRequests into hourly buckets", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        totalRequests: 2,
        byModel: { "openai/gpt-5.4": 2 },
        recentRequests: [
          { ts: new Date("2026-03-31T10:10:00.000Z").getTime(), providerID: "openai", modelID: "gpt-5.4" },
          { ts: new Date("2026-03-31T10:40:00.000Z").getTime(), providerID: "openai", modelID: "gpt-5.4" },
        ],
        files: {},
      }, null, 2)}\n`,
      "utf8",
    );

    const state = await __test.loadState(statePath);

    assert.deepEqual(state.recentBuckets, {
      "2026-03-31T10:00:00.000Z": {
        "openai/gpt-5.4": 2,
      },
    });
    assert.equal(state.version, 2);
  });
});

test("scanLogFile rescans recreated files with same size", async () => {
  await withTempDir(async (tempDir) => {
    const logFile = path.join(tempDir, "rotate.log");
    const state = __test.createDefaultState();

    await fs.writeFile(
      logFile,
      "INFO  2026-03-31T10:00:00.000Z a service=llm providerID=openai modelID=gpt-4.1\n",
      "utf8",
    );
    await __test.scanLogFile(logFile, state);

    const firstFileState = { ...state.files[logFile] };
    await fs.rm(logFile);
    await fs.writeFile(
      logFile,
      "INFO  2026-03-31T11:00:00.000Z b service=llm providerID=openai modelID=gpt-5.4\n",
      "utf8",
    );
    state.files[logFile] = firstFileState;

    await __test.scanLogFile(logFile, state);

    assert.equal(state.totalRequests, 2);
    assert.deepEqual(state.byModel, {
      "openai/gpt-4.1": 1,
      "openai/gpt-5.4": 1,
    });
  });
});
