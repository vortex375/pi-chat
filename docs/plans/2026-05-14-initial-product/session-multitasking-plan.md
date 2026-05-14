# Session multitasking plan

## Goal

Allow the web UI to keep streaming a response for one session while the user switches to another session, and surface per-session activity directly in the sidebar so background work is visible.

## Current behavior

- The web app keeps streaming state in a single global slice inside [apps/web/src/App.tsx](/home/vortex/work/projects/pi-chat/apps/web/src/App.tsx).
- The sidebar receives a global `isBusy` flag and disables session selection while any stream is active.
- Streaming updates are applied only through `selectedSession`, so the in-flight transcript is tied to whichever session is currently open.
- The top-right conversation status pill is driven by a single `streamStatus` object, but `SessionSummary` in [packages/shared/src/index.ts](/home/vortex/work/projects/pi-chat/packages/shared/src/index.ts) has no per-session activity field for the sidebar.

## Proposed approach

### 1. Split global streaming state into per-session activity state

Introduce an app-level map keyed by `sessionId` for ephemeral UI activity, for example:

- stream phase: `idle | connecting | streaming | done | error`
- short status label for the latest state
- optional active assistant placeholder/message id for optimistic updates
- optional error string or completion timestamp if useful for rendering transitions

This state should be UI-local only. It does not need backend persistence for the first pass.

### 2. Decouple stream updates from the selected session

Refactor the streaming path in [apps/web/src/App.tsx](/home/vortex/work/projects/pi-chat/apps/web/src/App.tsx) so a stream always updates the owning session by id, regardless of which session is currently selected.

Planned changes:

- Store session details in a session-id keyed cache in addition to `selectedSessionId`, or replace `selectedSession` with a detail map plus a derived selected detail.
- Update optimistic messages, deltas, completion, and error handling through that per-session cache.
- Keep the selected conversation header pill derived from the selected session's activity entry instead of the current global `streamStatus`.
- Prevent stream completion for session A from overwriting the transcript currently shown for session B.

### 3. Re-scope disabled states

Remove session switching from the global busy lock.

Planned rules:

- Session selection remains enabled while another session is streaming.
- Composer submission stays disabled only for the currently selected session if that same session is already streaming.
- Rename and delete remain disabled only when they would conflict with the selected session's active stream or their own pending request.
- Creating a new session remains enabled while another session is streaming in the background.

This should replace the current `isBusy = isStreaming || ...` coupling with narrower booleans per action.

### 4. Add sidebar session activity indicators

Render a compact status indicator on each session row in the sidebar.

Planned behavior:

- `connecting` and `streaming`: prominent live indicator
- `done`: brief success state after completion, then fade out automatically
- `error`: error tone and label
- `idle`: no extra badge

The indicator should be badge-only to preserve row density. Do not add an inline status label to the session row.

### 5. Decide whether the sidebar needs backend-derived activity

For this iteration, keep activity purely client-side unless we need cross-refresh continuity.

Why this is sufficient now:

- The request and SSE stream already originate in the active browser tab.
- The new multitasking need is about switching sessions within one live page.
- No current API returns active execution state for sessions after reload.

If we later need persistence across reloads or across browser tabs, extend `SessionSummarySchema` with a server-derived activity field and have `GET /api/sessions` populate it.

## Detailed implementation outline

### Frontend state changes

In [apps/web/src/App.tsx](/home/vortex/work/projects/pi-chat/apps/web/src/App.tsx):

- Introduce `sessionDetailsById` state and derive `selectedSessionDisplay` from `selectedSessionId`.
- Introduce `sessionActivityById` state for ephemeral activity.
- Replace helpers that mutate only `selectedSession` with helpers that update a session detail by id.
- Update `refreshCurrentSession()` and initial session loading to keep the detail cache and summary list in sync.
- Replace global `isStreaming` checks with `activeSessionIsStreaming` for the selected session plus targeted pending flags for other actions.

### Sidebar rendering changes

In [apps/web/src/App.tsx](/home/vortex/work/projects/pi-chat/apps/web/src/App.tsx), `SessionSidebar`:

- Accept the per-session activity map or a derived lookup.
- Show an inline status chip/spinner for sessions with non-idle activity.
- Stop disabling the session select button because another session is streaming.
- Keep delete disabled only for the row being deleted or for rows whose active stream should block deletion.

### Selected-session status pill changes

Keep the existing top-right pill, but derive it from the selected session's activity entry.

Expected behavior:

- When viewing the streaming session, the current pill behaves as it does today.
- When viewing a different session, the pill reflects that selected session rather than the background stream from another session.
- The sidebar becomes the place where global multitasking awareness lives.

### Shared contract changes

No shared schema change is required for the first pass if activity stays client-local.

Optional follow-up if needed later:

- add `activity` to `SessionSummarySchema` in [packages/shared/src/index.ts](/home/vortex/work/projects/pi-chat/packages/shared/src/index.ts)
- populate it in the API session list response

That should be deferred unless the implementation shows a real need.

## Test plan

Update [apps/web/src/App.test.tsx](/home/vortex/work/projects/pi-chat/apps/web/src/App.test.tsx) with focused behavior tests:

- streaming in session A does not disable selecting session B
- after switching to session B, session A continues receiving streamed deltas and completion
- the selected conversation view shows session B while session A finishes in the background
- the sidebar shows a live indicator on session A during streaming
- the sidebar shows a done or error indicator after stream completion or failure
- sending a second prompt is blocked only for the currently streaming session, not globally

If the implementation introduces a reusable activity helper, add unit coverage for its state transitions.

## Risks and edge cases

- Refresh races: a background stream completion plus a foreground session load can overwrite cached session details if updates are not keyed carefully.
- Activity cleanup: `done` should not remain sticky forever; the implementation should clear it automatically after a short timeout.
- Deletion during background streaming needs an explicit rule. Safest first pass is to block deleting a session while that same session is streaming.
- Abort handling on unmount should cancel all active streams, not just the most recently started one, if we later allow concurrent streams.

## Suggested implementation order

1. Introduce per-session detail and activity state in the app.
2. Refactor stream event handlers to target sessions by id instead of `selectedSession`.
3. Remove sidebar selection disablement tied to global streaming.
4. Add sidebar activity indicators.
5. Add multitasking regression tests.

## Locked decisions

- The sidebar activity indicator is badge-only.
- The `done` indicator fades out automatically after completion.
- Creating a new session remains allowed during a background stream.