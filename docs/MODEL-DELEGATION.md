# Model delegation

CodexRemote includes an optional local plugin at
`plugins/codex-model-delegator`. Its MCP server exposes a provider-neutral
`delegate_to_model` tool and, for configured coding runtimes, a
`delegate_to_agent` tool. The parent Codex model stays on its configured
provider and can send an independent task to a cheaper or specialist model.

It also supports a local DeepSeek Harness (`dsh`) child through the
`delegate_to_dsh` tool. This uses DSH's supported headless entry point:
`dsh --profile headless` receives one self-contained task on stdin, runs in the
requested workspace, and returns its final answer on stdout. It does not share
the parent conversation; only the task text and working directory are passed to
the child. `review` uses `DSH_PERMISSION_MODE=read-only`, while `implement`
uses `workspace-write`.

The router reads `.relay-data/model-providers.json`. Direct API providers resolve
keys from the environment variables named by `apiKeyEnv`; coding CLIs use their
own configured authentication. Do not put API keys in that JSON file.

The current example includes DeepSeek Flash through an OpenAI-compatible chat
endpoint, Claude through the Anthropic Messages API, and a full DeepSeek Codex
child that starts an isolated `codex exec` with a temporary DeepSeek Provider
config. The local `.relay-data/model-providers.json` also contains a DSH entry;
its `route` uses `provider/model` syntax, and the adapter writes a temporary
Cordis overlay for each run. The overlay can re-enable DSH's saved credentials
and account provider without modifying the user's persistent DSH profile. Add
another provider by adding a model entry and implementing its protocol in
`src/model-router.mjs`.

To expose the tool to Codex, add this block to the active Codex config:

```toml
[mcp_servers.codex-model-delegator]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Projects\CodexRemote\plugins\codex-model-delegator\server.mjs']
startup_timeout_sec = 20
tool_timeout_sec = 720

[mcp_servers.codex-model-delegator.env]
MODEL_DELEGATE_CONFIG = 'C:\Projects\CodexRemote\.relay-data\model-providers.json'
```

The command can use any Node.js executable on the machine. Set
`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, or another configured key in the MCP
process environment. A new MCP connection loads the configuration and adapter;
an existing process does not hot-reload source changes. A full Codex restart is
not required for the standalone CLI entry point below. The
full-agent path creates a temporary child `CODEX_HOME`, so the parent's
official Provider configuration is not replaced.

For DSH, point the `dsh` provider's `command` at the installed `dsh.cmd` (the
Windows installer normally places it under the DeepSeek Harness resources
directory). Then call `delegate_to_dsh` with `task`, optional `cwd`, and
`mode: "review"` or `"implement"`. The child uses DSH's own saved login/key;
the MCP server never reads or stores that credential.

## Claude Code using DeepSeek

The local `cc-deepseek-flash` alias uses the official Claude Code CLI with the
DeepSeek Anthropic-compatible endpoint. This is a full Read/Edit/Write/Bash
agent loop, independent of DSH. The parent Codex provider is unchanged.

Authentication is configured in `%USERPROFILE%\.claude\settings.json` using
`apiKeyHelper` and `https://api.deepseek.com/anthropic`. The helper decrypts
`%USERPROFILE%\.claude\deepseek-auth.dpapi` using this Windows account's DPAPI.
It emits the key only to the CLI's private stdout pipe. **Do not invoke the
helper directly to inspect authentication.** Use `claude auth status --json`.

To replace the key, run `Setup-ClaudeDeepSeekCredential.ps1` and enter it at
the hidden prompt. `-ImportFromDsh` instead copies the existing saved DeepSeek
API key into DPAPI without modifying DSH. The configured helper uses an absolute
project path, so update `apiKeyHelper` if this repository moves.

The user-level default model and Opus/Sonnet aliases are `deepseek-flash[1m]`,
the Haiku/subagent alias is `deepseek-flash`, and the effort is `max`. These
aliases all call DeepSeek; they do not invoke Anthropic models.

A configured CLI provider looks like this (use the installed native executable
path on Windows; `.cmd`/`.bat` wrappers are intentionally rejected):

```json
{
  "name": "Claude Code with DeepSeek",
  "execution": "claude-cli",
  "command": "C:\\Tools\\ClaudeCode\\claude.exe",
  "effort": "max",
  "timeoutMs": 600000,
  "models": {
    "cc-deepseek-flash": {
      "id": "deepseek-flash[1m]",
      "label": "DeepSeek V4.1 Flash (Claude Code)"
    }
  }
}
```

In an already-running Codex conversation, invoke the same adapter without
reloading MCP or restarting the desktop:

```powershell
node scripts/delegate-agent.mjs --model cc-deepseek-flash --mode implement --cwd D:\MyProject --task-file D:\task.txt
```

The result includes the actual model, usage, native `sessionId`, `runId`,
tool names, and `proofDirectory`. Use `--session-id <UUID>` with the same working
directory for follow-up or repair, or open it interactively with
`claude --resume <UUID>`. This does not create a Codex native sidebar subagent.

New MCP connections expose the same alias via `delegate_to_agent`, with
optional `session_id` and `effort`. The current desktop's already-loaded MCP
process may still expose the earlier adapter; the standalone entry point works
immediately. Do not restart the desktop merely to run a CC task.

`review` exposes only Read/Glob/Grep. `implement` additionally permits
Write/Edit/Bash with `acceptEdits` and explicit tool grants. These grants are
not an OS sandbox: the parent must choose a trusted workspace and inspect the
result. Hooks are disabled and unrelated MCP servers are excluded for these
delegations. The tool loop has a 10-minute default timeout, retains its native
session, and does not automatically retry tasks that may already have edited
files. An API error, missing result, malformed output, or nonzero exit is
reported as failure even if text was printed.

Execution records are in the ignored `.relay-data/agent-runs/<run-id>/`:
`request.json` (metadata, no environment dump), `events.jsonl` (CLI events),
`result.json`, and optional `stderr.txt`. These can contain task code/output;
the adapter does not put the API key into its arguments or records. The parent
still verifies artifacts and tests; a successful CLI result alone does not
prove the requested implementation is correct.

## Web task panel and shared background runner

Open **外部子代理** in the existing Relay sidebar, or `/agent-tasks.html` on
the same Relay address. The page uses the existing origin checks and browser
pairing. It lists CC tasks on that computer, including tasks launched from
other local Codex conversations through the shared runner. It does not mirror
the CC desktop UI or create a native Codex sidebar agent.

The panel shows the actual model selection, task text, source Codex thread ID
when supplied, native CC session ID, elapsed time, worker heartbeat, last model
response, tool requests/results, and files. A process or session ID alone does
not prove that the model responded. A quiet period is displayed as a long wait,
not a confirmed hang. Success requires the final CC result and normal process
exit; failures, timeouts, interruption, and user cancellation remain distinct.
Old logs without a heartbeat are labelled as historical records.

The web panel can start tasks, request a scoped stop, and continue a finished
CC session. Stop is acknowledged only after the owning worker exits its child;
it never targets Codex or an unrelated process. Continuation preserves the
session, workspace and permissions, and returns a new linked run ID. Session
locks prevent two workers from writing through the same CC conversation.
HTTP dispatch/continue requests require a UUID `requestId`: a retry with the
same contents returns the original task instead of starting another one.

Other local conversations can use the same runner without depending on an
already-loaded MCP tool catalog:

```powershell
node scripts/agent-tasks.mjs start --model cc-deepseek-flash --mode implement --cwd C:\Projects\MyProject --task-file C:\Tasks\task.txt
node scripts/agent-tasks.mjs status RUN_UUID
node scripts/agent-tasks.mjs show RUN_UUID
node scripts/agent-tasks.mjs continue RUN_UUID --task-file C:\Tasks\follow-up.txt
node scripts/agent-tasks.mjs stop RUN_UUID
```

`start` returns immediately after dispatch. `status` and `show` distinguish
dispatch from model activity and completion. The configured CC timeout still
applies. The worker is independent of the web request and continues if the
page closes. `--source-thread` optionally identifies the parent Codex thread;
otherwise the runner uses `CODEX_THREAD_ID` when available.

If you install an optional `cc-deepseek` skill yourself, use `$cc-deepseek`
or ask “让 CC 用 DeepSeek 做这个任务”. Skills are not installed globally by
this repository. Such a skill still requires a local conversation that can
access the execution computer; installing it does not grant a cloud
conversation access to local credentials.

The panel shows bounded task/message/tool events, not internal reasoning.
Token-count heartbeats are coalesced into status updates instead of recording
one raw log line per token. File links distinguish tool-mentioned files from
recent workspace files. They are limited to the task workspace, reject symlink
escapes and sensitive file names, and use the existing script-disabled preview
CSP. HTML links are labelled static previews; download files to use interactive
pages locally. Raw credentials, configuration environments and the DPAPI helper
output are not sent to the panel.
