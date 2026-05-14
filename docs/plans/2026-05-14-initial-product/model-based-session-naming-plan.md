# Model-Based Session Naming Plan

## Goal

Add backend-driven model-based session naming that replaces the truncated fallback title with a concise, meaningful label once a session has enough conversation context.

This should preserve the current immediate fallback behavior while adding a second naming phase driven by an explicit model call.

## Current State

The current committed behavior is:

- the fallback session title is derived from the first user prompt
- that fallback title is now truncated to a short, readable label
- explicit user renames are persisted through Pi session metadata via `appendSessionInfo()`
- Pi exposes explicit session naming primitives, but does not provide built-in automatic post-context naming

That means model-based naming must be implemented in pi-chat rather than enabled via an existing Pi feature flag.

## Target Behavior

The proposed naming lifecycle is:

1. create a new session with the existing fallback title behavior
2. once the session reaches the naming threshold, make a dedicated model call to generate a short title
3. persist that generated title
4. resolve the displayed title with this precedence:
   - custom user title
   - generated model title
   - truncated fallback title

User intent should always win:

- if the user manually renames a session, never overwrite that title with a generated one
- if the user clears a manual rename, fall back to the generated title when one exists, otherwise to the truncated fallback title

## Recommendation

Use a dedicated backend `SessionNamingService` and perform the naming call inline after the first completed assistant turn for a session that still has only a fallback title.

Rationale:

- one full user/assistant exchange is the smallest context window that is usually richer than the first prompt alone
- keeping the call inline avoids adding a second event channel or polling mechanism just to surface the new title in the web UI
- the existing post-stream refresh path can pick up the generated title without additional frontend architecture

Tradeoff:

- the first named response will complete slightly later because the title-generation call runs before the final session refresh

If that latency is unacceptable after testing, the implementation can move the naming call into a background queue later.

## Naming Trigger

Recommended initial trigger:

- run only after `runtime.session.prompt()` completes successfully
- run only when the session has at least one assistant message and one user message
- run only when there is no custom title
- run only when there is no previously generated title

Non-goals for the first version:

- no repeated title regeneration as the conversation keeps growing
- no attempt to keep renaming the session as topics drift
- no background retry worker

This keeps the first pass deterministic and easy to reason about.

## Model Call Design

The naming call should be separate from the main agent session.

Suggested shape:

- input: a compact transcript slice from the current session
- output: plain text title only
- tools: none
- system instructions: strongly constrain the output format

Suggested prompt contract:

- produce a title of roughly 3 to 7 words
- describe the main task or topic of the conversation
- do not include quotes, markdown, prefixes, or trailing punctuation unless required
- prefer specific task nouns over generic labels like "Help" or "Question"

Suggested transcript input for v1:

- the first user message
- the first assistant response
- optionally the latest user message when the first assistant response is too short

This keeps the prompt small and predictable while still using real conversation context.

## Backend Architecture

Add a dedicated service rather than embedding prompt logic into `PiSessionStore` or `PiAgentService`.

Suggested files:

- `apps/api/src/services/session-naming-service.ts`
- `apps/api/src/services/session-title-metadata.ts` if metadata parsing/persistence needs to be isolated

Suggested responsibilities:

### `SessionNamingService`

- determine whether a session qualifies for generation
- build the naming prompt from session messages
- invoke the configured model with a lightweight completion request
- normalize the result into a safe display title
- persist the generated title

### `PiSessionStore`

- expose helper methods for reading and writing generated-title metadata
- resolve `displayName` using custom > generated > fallback precedence
- continue to expose `firstMessage` separately for sidebar context

## Persistence Strategy

This is the main design choice to settle before implementation.

### Recommended approach

Store generated-title metadata in the session file as pi-chat-owned metadata, separate from Pi's explicit custom title field.

Reasoning:

- generated titles are app-owned state, not equivalent to a user-authored rename
- we need to distinguish generated titles from custom titles permanently
- that distinction should survive reloads and remain local to the session artifact

Practical implication:

- `appendSessionInfo()` should remain the source of truth for explicit user renames
- pi-chat should persist generated-title metadata separately and resolve the final `displayName` in `PiSessionStore`

### Open implementation options

Option A:

- store generated metadata as a Pi custom entry in the session JSONL
- extend pi-chat session parsing to read that custom entry

Option B:

- store generated metadata in a sidecar file next to the session file

Recommendation: prefer Option A if the parsing work stays local and straightforward, because it keeps all session state co-located in one artifact.

## API and DTO Changes

The current DTO surface only distinguishes `name` and `hasCustomName`.

Recommended API addition:

- add `generatedName?: string`
- add `titleSource: "fallback" | "generated" | "custom"`

Rationale:

- the frontend should not have to infer whether a title was generated
- `hasCustomName` alone is not expressive enough once generated titles exist
- the UI can show clearer copy for generated vs custom titles

Compatibility note:

- `displayName` should remain the resolved field used for rendering
- existing rename behavior can continue to send `{ name: string }`

## Request Flow Changes

Update the message streaming endpoint flow as follows:

1. run the main Pi request as today
2. persist the completed conversation turn
3. if the session still only has a fallback title and meets the naming trigger, invoke `SessionNamingService`
4. persist the generated title metadata
5. emit the existing `session.done` event
6. let the frontend refresh the session detail as it already does

This preserves the current frontend architecture and keeps naming behavior tied to successful persisted turns.

## Frontend Behavior

The first version should keep frontend changes small.

Suggested UI behavior:

- continue to optimistically show the truncated fallback title immediately
- after the stream completes and the detail refresh returns, render the generated title if present
- show rename controls exactly as today
- when a generated title is active, update helper copy so the user understands it can still be renamed

No extra websocket or polling behavior is required for the first pass if naming stays inline.

## Failure Handling

Title generation should be best-effort.

If the naming call fails:

- do not fail the main chat request
- keep the fallback title unchanged
- log the failure with session id and provider/model context
- allow future implementation to add retries, but do not add retry logic in v1

If the model returns unusable output:

- trim whitespace
- collapse newlines to spaces
- enforce a maximum title length
- if the output is empty after normalization, keep the fallback title

## Testing Plan

### Session naming service tests

- skips generation when a custom title already exists
- skips generation when a generated title already exists
- builds the prompt from the expected transcript slice
- normalizes noisy model output into a safe title
- treats model-call failures as non-fatal

### Session store tests

- resolves `displayName` with custom > generated > fallback precedence
- exposes generated title metadata in session detail and session summary DTOs
- clearing a custom title falls back to the generated title when present

### API tests

- after the first completed exchange, the returned refreshed session detail shows a generated title
- when generation fails, the session still completes successfully with the fallback title intact
- manual rename continues to override a previously generated title

### Web tests

- the optimistic title still uses the truncated fallback title immediately
- the final refreshed title switches to the generated title when returned by the API
- generated titles do not mark the session as manually renamed in the UI

## Files Likely To Change

- `apps/api/src/services/pi-session-store.ts`
- `apps/api/src/services/pi-agent-service.ts`
- `apps/api/src/services/session-naming-service.ts`
- `apps/api/src/app.ts`
- `apps/api/src/app.test.ts`
- `apps/api/src/services/pi-agent-service.test.ts` or a new focused service test file
- `packages/shared/src/index.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`

## Open Questions For Review

1. Is the first completed assistant turn the right naming threshold, or do you want to wait for two full turns before generating a title?
2. Do you want the title-generation call inline in the request path for simpler UI updates, or do you prefer a background follow-up even if that requires extra refresh behavior?
3. Are you comfortable adding `generatedName` and `titleSource` to the DTOs, or do you want to keep the API surface smaller and infer more on the client?
4. Do you want generated titles to be immutable after first generation, or should we allow one later regeneration pass if the conversation becomes much clearer?

## Proposed Next Step After Review

If this plan looks right, the implementation should proceed in this order:

1. lock the persistence shape for generated titles
2. add shared DTO fields for generated title metadata
3. implement `SessionNamingService` with a model-backed prompt
4. wire the naming call into the post-stream request flow
5. update UI rendering and helper copy
6. add focused API and web regression coverage