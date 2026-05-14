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
- use one shared `anonymous` workspace for v1; later each real `userId` will get its own workspace
- skip file upload and download for now
- use Pi's built-in persisted JSONL session files for v1 behind a clean storage abstraction, instead of introducing Postgres immediately
- initialize new workspaces from a template; the initial template is an empty placeholder
- keep all runtime state inside the `pi-chat` workspace or its deployment volume, not under `~/.pi/agent`
- target OpenRouter first, using an OpenAI-compatible base URL, model ID, and API key provided through app configuration
- do not restrict outbound network access for sandboxed `bash` in v1
- use the Pi SDK directly instead of running Pi as a subprocess over RPC
- have the backend serve the built frontend in production so the application can later ship as a single Docker image

## Architecture summary

### Proposed repository layout

```text
pi-chat/
  apps/
    api/                 # Fastify backend embedding Pi and serving the web build in production
    web/                 # React + Vite + Tailwind frontend
  packages/
    shared/              # Shared DTOs, event types, validation schemas
  data/
    system/              # backend-owned auth/model/config state if needed
    users/
      anonymous/
        workspace/       # sandbox root / cwd for Pi
        sessions/        # persisted Pi JSONL sessions
  templates/
    workspace/           # placeholder template copied into new workspaces
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
- deployment shape: backend serves static frontend assets in production, with a single Docker image as the target packaging model

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
templates/
  workspace/
```

Recommended service boundaries:

- `UserWorkspaceService`
  - resolves user paths
  - creates workspace on first use
  - initializes a new workspace by copying the configured template placeholder
  - can later support non-anonymous users without changing API handlers

- `WorkspaceTemplateProvisioner`
  - copies template contents into a newly created workspace
  - starts as an empty placeholder directory in v1
  - can later support richer starter repositories or per-user bootstrap flows

- `PiSessionStore`
  - wraps `SessionManager.create/open/list`
  - uses `appendSessionInfo()` / `getSessionName()` for editable session titles
  - returns sidebar-friendly session metadata
  - resolves session ID to session file path
  - derives the default display name from the first user message when no explicit title is set

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
- `PATCH /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/messages`

Endpoint behavior:

- `GET /api/sessions`
  - returns session sidebar data such as `id`, `name`, `displayName`, `firstMessage`, `modifiedAt`

- `POST /api/sessions`
  - creates a new persisted Pi session for the current user
  - returns new session metadata and an empty transcript

- `GET /api/sessions/:sessionId`
  - returns session metadata and current-branch chat messages

- `PATCH /api/sessions/:sessionId`
  - updates the editable session name
  - persists the explicit title via Pi session metadata
  - clears the explicit title when sent an empty value so the default label falls back to the first user message

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
- do not restrict outbound network access in v1; keep the policy seam so restrictions can be added later without redesigning the execution layer

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

- `PI_PROVIDER` or equivalent app-level provider selector
- `PI_MODEL_ID`
- `PI_OPENAI_BASE_URL`
- `PI_OPENAI_API_KEY`
- optional sandbox policy flags

Implementation rules:

- the initial default target is OpenRouter through an OpenAI-compatible endpoint
- backend configuration must accept a model ID, base URL, and API key and map them into the Pi model/provider setup
- model/provider must be validated at startup
- credentials should come from environment or deployment secrets, not interactive login
- do not depend on a developer's `~/.pi/agent/auth.json`

### 8. Backend implementation phases

#### Phase 1: scaffold backend foundation

- create workspace package structure
- add shared config and environment loading
- add backend app bootstrap, logging, and health endpoint
- add `UserWorkspaceService`, `WorkspaceTemplateProvisioner`, and `PiSessionStore`

#### Phase 2: Pi integration without UI

- build request-scoped `AgentSession` factory
- wire explicit auth/model/settings/resource loading
- create session list, create session, and get session endpoints
- add session rename support using Pi session metadata and default-name fallback logic
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

#### Phase 5: production assembly

- serve the built frontend assets from the backend in production
- keep local development split between the API server and the web dev server
- keep the file layout compatible with a single Docker image build later

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
- session title edits persist through a dedicated rename request
- composer submit starts a streaming POST request
- optimistic user message is shown immediately
- assistant response bubble is appended incrementally from stream deltas

The frontend should not try to reconstruct persistence locally. The backend remains the source of truth.

### 3. Component breakdown

- `AppShell`
- `SessionSidebar`
- `NewSessionButton`
- `ChatHeader`
- `EditableSessionTitle`
- `MessageList`
- `MessageBubble`
- `Composer`
- `StreamingStatus`

### 4. Frontend data contract

Suggested DTOs in `packages/shared`:

- `SessionSummary`
- `SessionDetail`
- `RenameSessionRequest`
- `ChatMessage`
- `PromptRequest`
- `StreamEvent`

Suggested session metadata fields:

- `name` for the explicit editable title
- `displayName` for the resolved title shown in the UI
- `hasCustomName` to distinguish explicit names from fallback labels

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
- allow editing session titles
- show the first user message as the default label until a custom title is saved

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
- workspace template initialization on first session
- session creation and listing
- session rename and default-name fallback behavior
- transcript retrieval from persisted sessions
- streamed prompt completion
- serialization of concurrent requests to the same session
- blocked reads or writes outside the workspace
- blocked shell access outside the sandbox

Frontend tests should cover:

- session list rendering
- selecting a session loads transcript
- editing a session title updates the sidebar and header
- composer submits a message and shows optimistic UI
- streaming assistant message updates the active bubble progressively

### 4. Future-ready seams

Keep these seams explicit even if the first implementation is simple:

- `UserContext` abstraction even though `userId` is always `anonymous`
- `SessionStore` abstraction even though v1 uses Pi JSONL files
- `WorkspaceProvisioner` abstraction even though v1 starts from an empty placeholder template
- transport abstraction around stream parsing if a WebSocket UI is added later

## Delivery sequence

1. Scaffold npm workspaces, shared package, backend, frontend, and the placeholder workspace template.
2. Implement backend bootstrap plus app-owned Pi configuration for OpenRouter-style OpenAI-compatible settings.
3. Implement filesystem-backed workspace, template provisioning, and session services.
4. Implement session list, create, detail, and rename endpoints.
5. Implement streaming prompt endpoint and per-session locking.
6. Implement sandboxed tool overrides and startup validation, while leaving outbound network unrestricted in v1.
7. Build frontend session list, editable titles, chat view, and streaming composer.
8. Make the backend serve the built frontend in production.
9. Add integration tests and tighten error handling.

## Acceptance criteria for the prototype

- A user can create a new chat session from the UI.
- Reloading the app shows previously created sessions.
- Selecting an existing session shows its stored conversation.
- Session titles default to the first user message and can be edited later.
- Sending a message streams the assistant response into the UI.
- Restarting the backend does not lose sessions or workspace files.
- First-time workspace creation copies the placeholder template into the shared `anonymous` workspace.
- The backend can serve the built frontend in production.
- The agent cannot read, write, or execute outside the user's allowed workspace.
- The backend does not depend on ambient Pi configuration from the host machine.