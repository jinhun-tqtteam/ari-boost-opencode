# ariboost

`ariboost` is an OpenCode plugin that counts model requests from OpenCode's local `service=llm` logs.

It reports:

- total tracked model requests
- model requests from the last 5 hours by default
- per-model breakdowns such as `openai/gpt-5.4`

## What it counts

`ariboost` scans OpenCode log lines that look like this:

```text
INFO  2026-03-30T09:20:52 ... service=llm providerID=openai modelID=gpt-5.4 ... stream
```

The plugin keeps its own state file so totals continue to grow even after older log files are rotated away.

## Install from GitHub

Add the plugin to your OpenCode config:

`~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "ariboost@git+https://github.com/<your-user>/ariboost.git"
  ]
}
```

Restart OpenCode after saving the config.

## Use the tool

Ask OpenCode to run the plugin tool:

```text
Use ariboost_stats
```

Optional parameters:

- `hours`: recent window size, default `5`
- `top`: number of model entries to show, default `5`

Example:

```text
Use ariboost_stats with hours 12 and top 10
```

## Where data is stored

The plugin looks for an existing OpenCode data directory, then uses:

- log directory: `<opencode-data>/log`
- state file: `<opencode-data>/plugins-data/ariboost/state.json`

On a machine like the current Windows setup, that usually resolves to:

- `C:\Users\<user>\.local\share\opencode\log`
- `C:\Users\<user>\.local\share\opencode\plugins-data\ariboost\state.json`

## Optional environment overrides

If you want custom paths, set either of these before launching OpenCode:

- `ARIBOOST_LOG_DIR`
- `ARIBOOST_STATE_FILE`

## Publish your repo

After creating a GitHub repo, push with:

```bash
git init
git add .
git commit -m "feat: add ariboost opencode plugin"
git branch -M main
git remote add origin https://github.com/<your-user>/ariboost.git
git push -u origin main
```

Then update the GitHub URL in your OpenCode config on every machine where you want to use the plugin.
