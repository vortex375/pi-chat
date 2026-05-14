# Workspace canvas plan

## Goal

Add a workspace-scoped canvas to Pi Chat that can display interactive custom UI cards authored by the agent as React components, without tying those cards to any one chat session.

## Product requirements

- Add a third frontend area alongside the session list and conversation view for custom UI cards.
- Let the user open and close the canvas from the UI.
- Keep published cards workspace-scoped, but keep canvas open or closed state local to the current browser session.
- Give the agent a tool to open and close the canvas.
- Let the agent write React component files into the workspace using its normal coding workflow, then publish those components onto the canvas.
- Surface component build and runtime errors so the agent can repair broken cards.
- Render custom components as cards rather than as full-screen takeovers.

## Current constraints

- The current web UI is a two-pane layout owned almost entirely by `apps/web/src/App.tsx`.
- Session streaming state is already being moved toward per-session UI state, but there is no workspace-level UI state domain yet.
- The backend exposes session APIs only. There is no canvas API, no workspace event stream, and no frontend-facing route that serves user-authored UI artifacts.
- The agent runs inside a per-user workspace sandbox and currently only has generic file tools plus `bash`.
- The user workspace is separate from the built web app. A React component written under `data/users/<user>/workspace` cannot be imported directly by Vite at runtime without a compile-and-serve pipeline.
- Backend-managed agent resources already exist, so the feature can be taught to the agent through a new skill or appended system prompt update.

## Options considered

### 1. Schema-driven widgets

The agent emits JSON that maps to a fixed library of frontend widgets such as forms, tables, progress views, and status panels.

Pros:

- Lowest implementation risk.
- Strong control over styling, safety, and accessibility.
- No runtime compilation pipeline.

Cons:

- Does not satisfy the requirement that the agent write React component files into the workspace.
- Limits the agent to whatever primitives the product team pre-builds.
- Makes the feature feel more like structured UI output than real coding.

Assessment:

- Useful fallback if arbitrary React proves too risky, but not the intended primary direction.

### 2. Browser-side TSX evaluation from workspace files

The frontend fetches raw TSX source from the backend, transpiles it in the browser, and executes it directly in the main React tree.

Pros:

- Fastest path to a visible prototype.
- Minimal backend work beyond file serving.
- Keeps the authoring loop short.

Cons:

- Arbitrary generated code runs inside the same page context as the host app.
- A broken card can crash the main UI, leak styles, or create hard-to-debug state corruption.
- Error reporting quality is weak unless a large client-side compiler stack is added.
- Security posture is poor even for an internal prototype.

Assessment:

- Acceptable only as a throwaway spike. Not a good base architecture.

### 3. Server-built workspace cards rendered in the main app shell

The agent writes TSX files into the workspace. The backend validates and bundles each card entry file, stores metadata in a workspace-scoped manifest, and the frontend renders the result directly inside the canvas card shells.

Pros:

- Satisfies the file-backed React requirement.
- Gives the backend a clean place to run validation and return diagnostics.
- Supports relative imports within the workspace card folder.
- Makes card publication an explicit lifecycle step rather than “any file is live immediately”.
- Keeps the runtime simpler for v1 because there is no iframe bridge to build yet.

Cons:

- Requires new backend services, routes, and a card runtime bridge.
- Adds a manifest and bundle cache to manage.
- Same-page rendering means generated code can still destabilize the host UI if the host boundaries are too weak.
- More moving parts than a schema-driven approach.

Assessment:

- Best fit for the requested feature.
- Recommended for v1.

### 4. Full workspace micro-frontend

Treat the canvas as a mini app platform where the agent can publish multi-file React apps, routes, and assets.

Pros:

- Maximum flexibility.
- Could later support richer dashboards and multi-card applications.

Cons:

- Too much surface area for the current product stage.
- Blurs the boundary between “cards on a canvas” and “agent-generated application hosting”.
- Greatly increases runtime, security, and packaging complexity.

Assessment:

- Keep out of v1.

## Recommended approach

Implement option 3 with an explicit publish workflow:

1. The agent writes React component files into a dedicated workspace folder.
2. The agent calls a canvas tool to publish a specific component as a card.
3. The backend validates and bundles the component, persists the card metadata, and emits a workspace-level canvas update.
4. The frontend renders the card in the main app shell and reports a `card ready` signal after the first successful mount.
5. The publish flow waits for that ready signal before reporting success to the agent.
6. Build or runtime failures are stored as diagnostics and exposed both to the UI and to the agent.

This keeps authoring file-based and agent-friendly while staying simpler than an iframe-based runtime for v1.

## Locked decisions

- Published cards are workspace-scoped, but canvas visibility is browser-session local and not persisted.
- Card source files live in a visible `canvas/` folder in the user workspace.
- Supported imports for v1 stay minimal: `react` only.
- Same-page rendering inside the main frontend is acceptable for v1.
- `canvas_publish_card` should wait for and return a `card ready` signal.
- v1 ships with a simple vertical card stack, not a configurable layout system.
- Card interactions stay client-side only in v1 and are not sent back to the backend, the conversation, or agent tools.

## Proposed architecture

### 1. Storage model

Use a visible workspace folder for card source code and a hidden workspace metadata area for backend-owned state.

Suggested layout inside each user workspace:

```text
workspace/
  canvas/
    cards/
      weather-panel.tsx
      task-board.tsx
  .pi-chat/
    canvas-manifest.json
    canvas-diagnostics/
      <card-id>.json
```

Recommended split:

- `canvas/` is agent-authored and user-visible.
- `.pi-chat/` is backend-owned metadata.

Suggested `canvas-manifest.json` fields per card:

- `id`
- `title`
- `componentPath`
- `status: draft | ready | build_error | runtime_error`
- `props`
- `createdAt`
- `updatedAt`
- `lastPublishedAt`
- `lastReadyAt`

### 2. Backend domain model

Add a dedicated canvas slice in the API.

Suggested services:

- `CanvasStore`
  - reads and writes workspace manifest and diagnostics files
  - persists diagnostics
  - resolves card file paths relative to the workspace root

- `CanvasBuildService`
  - validates a card entry file
  - produces browser-executable output from TSX
  - captures syntax, import, and type diagnostics
  - caches bundles by file content hash or manifest version

- `CanvasRuntimeEventService`
  - accepts runtime events from rendered cards
  - persists runtime errors and lifecycle signals such as readiness or resize
  - publishes canvas update events to connected clients

- `CanvasEventBus`
  - broadcasts workspace-level canvas updates
  - broadcasts targeted browser-session visibility requests
  - backs a dedicated `/api/canvas/events` stream for the frontend

### 3. API surface

Add workspace-scoped endpoints rather than session-scoped ones.

Suggested first-pass routes:

- `GET /api/canvas`
  - returns current card manifest and diagnostics summary

- `GET /api/canvas/events`
  - SSE-style stream of workspace canvas updates plus browser-session visibility requests

- `POST /api/canvas/cards/publish`
  - validates and publishes a card from a workspace entry path
  - waits for a `card ready` signal from the active browser session before returning success
  - returns manifest entry plus diagnostics

- `DELETE /api/canvas/cards/:cardId`
  - removes a published card from the canvas

- `GET /api/canvas/cards/:cardId/bundle.js`
  - serves the compiled card bundle

- `POST /api/canvas/cards/:cardId/runtime-events`
  - accepts `ready`, `resize`, and `runtime_error` events from the rendered card

### 4. Shared contracts

Add shared schemas under `packages/shared/src/index.ts` for:

- `CanvasCard`
- `CanvasDiagnostics`
- `CanvasSnapshot`
- `CanvasEvent`
- `PublishCanvasCardRequest`
- `CanvasVisibilityRequest`

Suggested `CanvasEvent` types:

- `canvas.card.published`
- `canvas.card.removed`
- `canvas.card.updated`
- `canvas.card.error`
- `canvas.visibility.requested`

### 5. Agent tools

Keep code authoring on the existing file tools. Add a small canvas-specific toolset for publication and UI control.

Recommended tools:

- `canvas_set_visibility`
  - input: `open` or `closed`
  - sends an ephemeral visibility request to the active browser session for the current conversation

- `canvas_publish_card`
  - input: component path, title, props
  - validates the component, updates the manifest, waits for `card ready`, and returns diagnostics

- `canvas_remove_card`
  - input: card id
  - removes a card from the manifest

- `canvas_list_cards`
  - returns current manifest entries and status

- `canvas_get_diagnostics`
  - returns stored build and runtime diagnostics for one card or all cards

Recommended agent workflow:

1. Write or edit `workspace/canvas/cards/<name>.tsx` with the normal file tools.
2. Call `canvas_publish_card`.
3. If diagnostics are returned, repair the source file and republish.
4. Call `canvas_set_visibility(open)` when the agent wants to bring the canvas into view.

### 6. Frontend shell changes

Refactor the web app from a two-pane layout into a three-area shell.

Recommended behavior:

- Desktop:
  - left sidebar for sessions
  - middle conversation pane
  - right canvas pane with a simple vertical stack of cards

- Narrow screens:
  - canvas becomes a drawer or slide-over controlled by the same open/close state

Suggested UI additions in `apps/web/src/App.tsx`:

- app-level canvas manifest and diagnostics loaded from `GET /api/canvas`
- browser-local canvas visibility state held in React state only
- a persistent canvas toggle button in the conversation header
- a `CanvasPanel` component that renders card chrome and diagnostics
- a workspace-level SSE subscription for canvas updates independent of the selected session
- handling for targeted `canvas.visibility.requested` events from the backend agent tool

The canvas must remain stable while the user switches sessions, because the canvas belongs to the workspace rather than the active conversation.

### 7. Card rendering model

Render each published component inside a host-managed card shell.

Recommended card shell responsibilities:

- title bar and status badge
- open error state if the latest build or runtime failed
- remove or refresh actions
- bounded scroll region
- consistent spacing in a simple vertical stack
- a `ready` handshake that marks the card live only after the component mounts successfully

Recommended same-page safeguards:

- render card content under a per-card React error boundary
- keep host chrome outside the generated component
- constrain the generated component contract so host callbacks are passed as props rather than broad app internals

Same-page rendering is acceptable for v1, but the host boundaries should be strong enough that an individual card failure stays scoped to that card.

### 8. Component contract

Provide a very small supported component contract instead of letting cards depend on the entire web app internals.

Suggested supported imports for v1:

- `react`

Suggested component shape:

- default export is a React component
- the host passes props that include:
  - `data`
  - `cardId`
  - `host.ready()`
  - `host.setTitle(title)`

This keeps the import surface minimal while still giving the host a narrow way to receive lifecycle signals.

### 9. Validation and diagnostics

The error-correction loop is central to this feature.

Recommended validation stages for `canvas_publish_card`:

1. Resolve and sandbox-check the component path.
2. Parse and bundle the entry file and its relative imports.
3. Run a TypeScript diagnostic pass against a dedicated canvas tsconfig.
4. Persist diagnostics to `.pi-chat/canvas-diagnostics/<card-id>.json`.
5. Wait for a browser `ready` event from the rendered card, with a bounded timeout.
6. Return a structured result to the agent.

Suggested diagnostic categories:

- syntax error
- import resolution error
- type error
- runtime bootstrap error
- runtime interaction error

Suggested frontend behavior:

- show build failures directly on the affected card shell
- show runtime failures directly on the affected card shell
- allow a quick “retry render” action for runtime-only failures

### 10. Agent-resource updates

Teach the backend agent the new canvas workflow through backend-managed agent resources.

Expected updates:

- append system prompt note that canvas cards live under `workspace/canvas/cards`
- a new skill describing:
  - supported imports: `react` only in v1
  - expected component shape
  - how to publish a card
  - how to inspect diagnostics
  - when to open or close the canvas

This matters because Pi Chat intentionally does not load arbitrary workspace `AGENTS.md` files from the user workspace.

## Suggested implementation phases

### Phase 1: Canvas shell and browser-local visibility

- Add shared canvas contracts.
- Add canvas store and workspace-scoped API routes.
- Add frontend canvas panel and open/close toggle.
- Keep canvas visibility in browser-local React state only.
- Persist an empty manifest.

Outcome:

- The app has a real workspace-scoped canvas even before custom React cards are live.

### Phase 2: File-backed card publication

- Add card source folder conventions.
- Add `canvas_publish_card` and manifest updates.
- Add server-side build validation and bundle serving.
- Render published cards in a host shell.

Outcome:

- The agent can author TSX files and publish them as cards.

### Phase 3: Error loop and runtime bridge

- Add runtime error reporting from rendered cards.
- Persist diagnostics and expose them to the agent.
- Add card-ready and resize events.

Outcome:

- Broken cards are visible and repairable.

### Phase 4: Rich interactions

- Keep card interactions client-side only for the initial implementation.
- Revisit backend-visible interaction events only after the basic canvas authoring and publish loop is stable.
- Add higher-level host prop patterns for common UI use cases if the minimal component contract proves too limiting.

Outcome:

- Cards remain interactive in the browser while the backend integration surface stays intentionally narrow.

## Test plan

### Backend

- `CanvasStore` reads and writes manifest and diagnostics correctly.
- publish rejects paths outside the user workspace.
- publish returns validation errors for invalid TSX or unresolved imports.
- runtime error reports update card status and diagnostics.
- SSE subscribers receive `canvas.visibility.requested` and card lifecycle events.

### Agent-tool integration

- `canvas_set_visibility` pushes a browser-session visibility event.
- `canvas_publish_card` waits for `card ready`, returns success for a valid card, and returns diagnostics for an invalid card.
- the agent can write a card file, publish it, receive an error, edit the file, and republish successfully.

### Frontend

- the canvas toggle opens and closes the right-side panel without affecting session selection.
- canvas state survives session switching.
- canvas visibility resets when the browser session reloads.
- the frontend reflects manifest updates from the backend.
- published cards render inside card chrome.
- the publish flow waits for a rendered `card ready` signal before success is surfaced.
- build and runtime errors render as card-level error states.

### Manual smoke coverage

- publish a simple counter card
- interact with the card
- trigger a deliberate render error after an interaction
- verify the error appears on the canvas and through diagnostics
- repair the file and republish

## Risks and edge cases

- Arbitrary generated frontend code is inherently risky. Even without iframe isolation, a bad card can consume CPU, spam events, or degrade the page.
- The allowed import surface must stay narrow or dependency management will expand quickly.
- Runtime diagnostics are harder than build diagnostics because some errors only appear after user interaction, even when those interactions are client-side only.
- Concurrent agent edits and manual user edits to the same card file need clear last-write behavior.
- If no browser is connected, build diagnostics are still available but a `card ready` handshake cannot complete.
- Bundle caching must invalidate correctly when source files or relative imports change.
- Same-page rendering raises the cost of mistakes in host boundaries and error containment.

## Suggested implementation order

1. Add shared canvas contracts and backend storage.
2. Add canvas API routes and frontend canvas shell.
3. Add backend canvas tools and agent-resource documentation.
4. Add card validation, bundling, and serving.
5. Add same-page card rendering in the frontend with error boundaries and ready signaling.
6. Add runtime diagnostics.

## Deferred follow-up

- Backend-visible card interaction events are intentionally out of scope for the initial implementation.
- If later iterations need the agent to respond to card usage, add a separate design for structured interaction logging and explicit opt-in tools rather than piping raw UI events into the conversation.