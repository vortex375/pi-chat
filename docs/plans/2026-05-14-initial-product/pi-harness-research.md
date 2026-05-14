# Pi harness research notes for Pi Chat

## Files examined

- `coding-agent/README.md`
- `coding-agent/docs/sdk.md`
- `coding-agent/docs/session-format.md`
- `coding-agent/examples/sdk/README.md`
- `coding-agent/examples/sdk/01-minimal.ts`
- `coding-agent/examples/sdk/11-sessions.ts`
- `coding-agent/examples/sdk/12-full-control.ts`
- `coding-agent/examples/sdk/13-session-runtime.ts`
- `coding-agent/examples/extensions/sandbox/index.ts`
- `coding-agent/examples/extensions/tool-override.ts`
- `coding-agent/src/core/session-manager.ts`
- `coding-agent/src/core/agent-session-runtime.ts`
- `coding-agent/src/core/tools/path-utils.ts`
- `coding-agent/src/core/tools/read.ts`
- `coding-agent/src/core/tools/write.ts`
- `coding-agent/src/core/tools/bash.ts`
- `coding-agent/package.json`

## Key SDK findings

### 1. Embedding path

The SDK is the right integration surface for Pi Chat. It gives direct access to:

- `createAgentSession()` for request-scoped execution
- `SessionManager` for persisted JSONL sessions
- `session.subscribe()` for token and tool-event streaming
- custom `AuthStorage`, `ModelRegistry`, `SettingsManager`, and `ResourceLoader`

RPC mode exists, but the SDK is a better fit here because the backend will be a Node.js process and needs direct event streaming, direct session access, and explicit control over tools and sandboxing.

### 2. Persistence is already available

Pi already supports persistent sessions through `SessionManager.create/open/continueRecent/list/listAll`.

Important details:

- session files are JSONL
- the file format is append-only and tree-based (`id` / `parentId`)
- `SessionManager.list()` already returns session metadata useful for a sidebar
- `SessionManager.getBranch()` and `buildSessionContext()` can reconstruct the current branch for display or replay
- `SessionManager.create(cwd, sessionDir)` lets the app store sessions in its own directory instead of `~/.pi/agent/sessions`

This makes Pi's built-in persistence good enough for the initial prototype. A separate database is optional, not required on day one.

### 3. Streaming model

The backend can stream assistant output by subscribing to session events.

Most relevant event types:

- `message_update` with `text_delta` for token streaming
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end` for tool progress
- `agent_end` and `turn_end` for completion markers
- `queue_update` if queued follow-up or steering behavior is ever exposed later

This maps cleanly to HTTP streaming from the backend to the React client.

### 4. Session runtime is useful, but not required for a stateless HTTP server

`AgentSessionRuntime` is the right abstraction when one long-lived host process needs to replace the active session in place with `newSession()`, `switchSession()`, or `fork()`.

For Pi Chat's initial REST backend, a simpler pattern is available:

- create or open the target session per request
- create a request-scoped `AgentSession`
- subscribe to events
- run the prompt
- dispose the session

This avoids keeping many live runtimes in memory. The backend still needs a per-session execution lock to prevent concurrent writes to the same session file.

### 5. Full-control mode is important for a server integration

The `12-full-control.ts` example is especially relevant.

The default resource loader discovers:

- `AGENTS.md`
- project skills
- prompt templates
- extensions
- user-global config under `~/.pi/agent`

That is useful for an interactive developer CLI, but risky for a multi-user backend. The server should not accidentally load:

- developer-specific home-directory config
- workspace-authored `AGENTS.md` files
- user-created prompt templates or extensions

For Pi Chat, the safer default is a controlled `ResourceLoader` or an app-owned loader configuration that only exposes explicitly selected tools, prompts, and extensions.

### 6. `cwd` is not a sandbox boundary

This is the most important implementation constraint from the source review.

The built-in tools resolve paths relative to `cwd`, but they also accept absolute paths. `bash` executes arbitrary shell commands in `cwd`, which is only a working directory, not a security boundary.

Observed directly in source:

- `read` accepts relative or absolute paths
- `write` accepts relative or absolute paths
- path resolution expands `~` and absolute paths
- `bash` spawns the local shell with the provided command and the provided `cwd`

Implication: a per-user workspace directory is necessary, but not sufficient, to satisfy the product requirement for sandboxed execution.

### 7. Sandbox support exists as a pattern, not as a default

The sandbox example shows a viable approach:

- override or wrap the built-in `bash` tool
- use an OS sandbox runtime (`bubblewrap` on Linux)
- apply filesystem and network policy externally to the shell command

The tool-override example shows how to override built-in tools with the same tool names to add policy, logging, or path checks.

This strongly suggests a layered containment design for Pi Chat:

- custom path-guarded file tools for `read`, `write`, `edit`, `grep`, `find`, `ls`
- sandboxed `bash` for command execution
- per-user workspace root as the only allowed writable area

## Recommended integration stance for Pi Chat

### Use these SDK capabilities directly

- `createAgentSession()`
- `SessionManager.create/open/list`
- custom `AuthStorage`
- `ModelRegistry` configured from backend environment
- `SettingsManager.inMemory()` for backend-owned settings
- controlled `ResourceLoader`
- custom or overridden tools for sandboxing

### Avoid these defaults in the first version

- ambient discovery from `~/.pi/agent`
- ambient discovery from user workspace `AGENTS.md` or skills
- default tool set without containment
- relying on `cwd` for security

## Consequences for the application plan

1. The backend should use Pi's file-based session persistence first, behind an adapter that can later be replaced by Postgres.
2. The backend should create request-scoped agent sessions and serialize execution per persisted session.
3. The backend should own its auth, model selection, settings, and resource loading instead of using Pi's interactive defaults.
4. The backend should implement sandboxing as part of the core architecture, not as a later hardening step.
5. The frontend can remain simple because the SDK already provides persistent history and token streaming; the main frontend work is rendering, optimistic state, and stream handling.