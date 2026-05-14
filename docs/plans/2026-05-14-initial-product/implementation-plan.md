# Pi Chat implementation plan

## Goal

Build a new application inside the `pi-chat` workspace with:

- a Node.js / TypeScript backend that embeds Pi through its SDK
- persistent multi-session chat over a REST API
- streaming assistant responses
- a React / TypeScript / Tailwind frontend with a session list and chat view
- per-user workspace isolation that is treated as a real sandboxing problem, not just a `cwd` setting

## Scope and prototype decisions

This plan assumes the initial prototype will:

- use a hard-coded `anonymous` user ID everywhere
- skip file upload and download for now
- use Pi's built-in persisted session files for v1 instead of introducing Postgres immediately
- keep all runtime state inside the `pi-chat` workspace or its deployment volume, not under `~/.pi/agent`
- use the Pi SDK directly instead of running Pi as a subprocess over RPC

## Architecture summary

### Proposed repository layout

```text
pi-chat/
  apps/
    api/                 # Fastify backend embedding Pi
    web/                 # React + Vite + Tailwind frontend
  packages/
    shared/              # Shared DTOs, event types, validation schemas
  data/
    system/              # backend-owned auth/model/config state if needed
    users/
      anonymous/
        workspace/       # sandbox root / cwd for Pi
        sessions/        # persisted Pi JSONL sessions
  docs/
    plans/
      2026-05-14-initial-product/
```

### Proposed technology choices

- package manager: `npm` workspaces
- backend: Fastify + TypeScript
- frontend: React + Vite + TailwindCSS
- shared contracts: TypeScript package under `packages/shared`
- tests: Vitest for unit and backend integration tests, React Testing Library for frontend behavior

## Backend plan

### 1. Backend runtime model

Use request-scoped Pi sessions instead of keeping a long-lived in-memory session runtime per chat.

For each prompt request:

1. resolve the effective user (`anonymous` for v1)
2. ensure that user's workspace and session directory exist
3. open or create the target Pi session via `SessionManager`
4. create a request-scoped `AgentSession`
5. subscribe to Pi events and forward them to the HTTP response stream
6. wait for completion
7. dispose the session

Why this shape:

- it matches the REST request model cleanly
- it keeps memory usage bounded
- it relies on Pi's persisted session state instead of app-level in-memory state
- it avoids the complexity of many long-lived runtime instances

### 2. Backend-owned Pi configuration

Do not use Pi's interactive defaults.

The backend should explicitly own:

- `AuthStorage`
- `ModelRegistry`
- `SettingsManager`
- `ResourceLoader`
- tool registration and overrides

Implementation stance:

- use `AuthStorage.create(<app-owned-path>)`
- set runtime API keys from environment variables
- use `ModelRegistry.inMemory(authStorage)` or a controlled custom registry
- use `SettingsManager.inMemory()` with explicit retry / compaction settings
- use a controlled `ResourceLoader` based on the full-control SDK example

This avoids ambient discovery from:

- `~/.pi/agent`
- workspace `AGENTS.md`
- project skills, prompts, or extensions that users may create inside their workspace

### 3. Session and workspace storage

Use Pi session files as the source of truth for v1.

Suggested directory layout:

```text
data/
  system/
    auth.json
  users/
    anonymous/
      workspace/
      sessions/
```

Recommended service boundaries:

- `UserWorkspaceService`
  - resolves user paths
  - creates workspace on first use
  - can later support non-anonymous users without changing API handlers

- `PiSessionStore`
  - wraps `SessionManager.create/open/list`
  - returns sidebar-friendly session metadata
  - resolves session ID to session file path

- `ConversationMapper`
  - converts Pi session entries into frontend DTOs
  - uses `getBranch()` when stable entry IDs are needed in the UI
  - uses `buildSessionContext()` when a resolved LLM-facing transcript is needed

### 4. Concurrency and correctness

Add a per-session execution queue in the backend.

Reason:

- Pi sessions persist to append-only JSONL files
- overlapping requests against the same session would be hard to reason about and could corrupt the user experience even if the file stays valid

Implementation requirement:

- only one active prompt is allowed per persisted session at a time
- concurrent requests to different sessions are allowed
- the queue lives in the backend process for v1

### 5. Streaming API design

Use HTTP streaming for assistant output.

Recommended initial contract:

- `GET /api/health`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/messages`

Endpoint behavior:

- `GET /api/sessions`
  - returns session sidebar data such as `id`, `name`, `firstMessage`, `modifiedAt`

- `POST /api/sessions`
  - creates a new persisted Pi session for the current user
  - returns new session metadata and an empty transcript

- `GET /api/sessions/:sessionId`
  - returns session metadata and current-branch chat messages

- `POST /api/sessions/:sessionId/messages`
  - accepts a user message
  - streams assistant output back as chunked HTTP events
  - persists the turn through Pi's session manager

Recommended stream event types:

- `session.started`
- `message.user`
- `message.assistant.delta`
- `tool.start`
- `tool.update`
- `tool.end`
- `message.assistant.done`
- `session.done`
- `error`

Transport recommendation:

- use an SSE-style event stream over a standard `fetch()` request response
- parse the stream manually in the frontend instead of relying on `EventSource`, because the message submission endpoint is naturally a `POST`

### 6. Sandbox and workspace isolation

Treat this as a mandatory architecture slice, not optional hardening.

The SDK review showed that:

- file tools accept absolute paths
- `bash` executes arbitrary commands in the provided working directory
- `cwd` is not a security boundary

Recommended isolation design:

#### Layer 1: per-user workspace root

- each user gets a dedicated workspace directory
- all Pi execution for that user uses that workspace as `cwd`
- for v1, `anonymous` gets one shared workspace under `data/users/anonymous/workspace`

#### Layer 2: guarded file tools

Override or replace Pi's file-oriented tools:

- `read`
- `write`
- `edit`
- `grep`
- `find`
- `ls`

Rules:

- resolve the requested path against the user workspace
- reject paths that escape the workspace after normalization and symlink resolution
- reject direct absolute paths outside the workspace
- log denials for audit/debugging

#### Layer 3: sandboxed shell execution

Override Pi's `bash` behavior using the sandbox extension pattern from the example project.

For Linux:

- use `bubblewrap`
- allow write access to the user workspace and `/tmp`
- deny access to host secrets and parent directories
- make outbound network policy explicit rather than implicit

Operational requirement:

- backend startup should validate sandbox prerequisites
- if sandboxing is required but unavailable, the server should fail fast instead of silently running unsandboxed

#### Layer 4: controlled Pi resources

Do not load user-created:

- `AGENTS.md`
- skills
- prompts
- extensions

This prevents the workspace itself from redefining the system behavior of the embedded agent.

### 7. Model and auth configuration

Use server-owned environment configuration.

Suggested configuration surface:

- `PI_PROVIDER`
- `PI_MODEL_ID`
- provider API key env vars such as `ANTHROPIC_API_KEY`
- optional sandbox policy flags

Implementation rules:

- model/provider must be validated at startup
- credentials should come from environment or deployment secrets, not interactive login
- do not depend on a developer's `~/.pi/agent/auth.json`

### 8. Backend implementation phases

#### Phase 1: scaffold backend foundation

- create workspace package structure
- add shared config and environment loading
- add backend app bootstrap, logging, and health endpoint
- add `UserWorkspaceService` and `PiSessionStore`

#### Phase 2: Pi integration without UI

- build request-scoped `AgentSession` factory
- wire explicit auth/model/settings/resource loading
- create session list, create session, and get session endpoints
- add transcript mapping from Pi sessions to API DTOs

#### Phase 3: streaming prompt endpoint

- add per-session execution locking
- add `POST /api/sessions/:sessionId/messages`
- translate Pi streaming events to HTTP event frames
- add backend integration tests for persisted history and stream completion

#### Phase 4: sandbox enforcement

- implement guarded file tools
- implement sandboxed `bash`
- add startup validation for sandbox dependencies
- add tests that prove blocked access outside the workspace

## Frontend plan

### 1. Frontend shell

Build a single-page React application with a split layout:

- left column: session list
- right column: conversation view and composer

Minimum screens and states:

- empty state when no sessions exist
- loading state for session list and transcript fetch
- streaming state while the assistant is responding
- error state for failed requests or interrupted streams

### 2. Frontend state model

Use server state for persisted data and local component state for in-flight streaming UI.

Suggested responsibilities:

- session list query loads existing sessions
- selected session query loads transcript
- composer submit starts a streaming POST request
- optimistic user message is shown immediately
- assistant response bubble is appended incrementally from stream deltas

The frontend should not try to reconstruct persistence locally. The backend remains the source of truth.

### 3. Component breakdown

- `AppShell`
- `SessionSidebar`
- `NewSessionButton`
- `ChatHeader`
- `MessageList`
- `MessageBubble`
- `Composer`
- `StreamingStatus`

### 4. Frontend data contract

Suggested DTOs in `packages/shared`:

- `SessionSummary`
- `SessionDetail`
- `ChatMessage`
- `PromptRequest`
- `StreamEvent`

Suggested `ChatMessage` shape:

- `id`
- `role`
- `content`
- `createdAt`
- `status` for in-flight assistant messages if needed

### 5. Frontend implementation phases

#### Phase 1: app shell and static layout

- create React app with Tailwind
- build split-pane layout
- implement responsive behavior for narrower screens

#### Phase 2: session browsing

- connect to `GET /api/sessions`
- create new sessions from the UI
- load session transcript on selection

#### Phase 3: streaming chat

- connect composer to streaming message endpoint
- render optimistic user bubble
- append assistant deltas into a single active assistant bubble
- refresh or reconcile persisted transcript after stream completion

#### Phase 4: polish and resilience

- add disabled states while a session is busy
- handle stream interruption cleanly
- keep scroll pinned to bottom while streaming unless user scrolls away

## Cross-cutting concerns

### 1. Shared typing and validation

Put API request/response types in `packages/shared` so the backend and frontend use the same contracts.

### 2. Logging and observability

Add structured logs for:

- session creation
- prompt start and completion
- sandbox denials
- backend errors
- model selection failures

### 3. Test strategy

Backend tests should cover:

- workspace creation on first session
- session creation and listing
- transcript retrieval from persisted sessions
- streamed prompt completion
- serialization of concurrent requests to the same session
- blocked reads or writes outside the workspace
- blocked shell access outside the sandbox

Frontend tests should cover:

- session list rendering
- selecting a session loads transcript
- composer submits a message and shows optimistic UI
- streaming assistant message updates the active bubble progressively

### 4. Future-ready seams

Keep these seams explicit even if the first implementation is simple:

- `UserContext` abstraction even though `userId` is always `anonymous`
- `SessionStore` abstraction even though v1 uses Pi JSONL files
- `WorkspaceProvisioner` abstraction even though v1 creates empty directories
- transport abstraction around stream parsing if a WebSocket UI is added later

## Delivery sequence

1. Scaffold npm workspaces, shared package, backend, and frontend.
2. Implement backend bootstrap plus app-owned Pi configuration.
3. Implement filesystem-backed workspace and session services.
4. Implement session list, create, and detail endpoints.
5. Implement streaming prompt endpoint and per-session locking.
6. Implement sandboxed tool overrides and startup validation.
7. Build frontend session list, chat view, and streaming composer.
8. Add integration tests and tighten error handling.

## Acceptance criteria for the prototype

- A user can create a new chat session from the UI.
- Reloading the app shows previously created sessions.
- Selecting an existing session shows its stored conversation.
- Sending a message streams the assistant response into the UI.
- Restarting the backend does not lose sessions or workspace files.
- The agent cannot read, write, or execute outside the user's allowed workspace.
- The backend does not depend on ambient Pi configuration from the host machine.

## Questions to resolve

- Is Pi's file-based JSONL session persistence acceptable for v1 if the code keeps a clean storage abstraction for a future Postgres implementation?
- Should the prototype use one shared `anonymous` workspace, or do you still want one workspace per session until real user accounts exist?
- What model/provider should be the default target for the first implementation?
- Should outbound network access in sandboxed `bash` be denied by default, or should the prototype allow a minimal package-development allowlist such as GitHub, npm, and PyPI?
- Should a newly created workspace start completely empty, or should it be initialized from a template repository or starter files?
- Do you want the backend to serve the built frontend bundle in production, or should frontend and backend remain separately deployed from the start?
- Should editable session names be in scope for the initial UI, or is deriving the label from the first user message sufficient for now?