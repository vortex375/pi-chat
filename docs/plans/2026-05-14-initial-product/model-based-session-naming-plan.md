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
2. after the first completed assistant turn, kick off a background model call to generate a short title
3. persist that generated title into the existing session title field
4. from that point on, treat the stored title exactly like any other conversation title

This keeps the feature simple:

- no separate generated-title metadata
- no custom precedence rules between generated and user-provided titles
- no DTO fields that distinguish generated titles from other titles

In this design, the background generation pass is allowed to overwrite the existing session title when it completes. If there is already a reliable placeholder check available, it is also fine to guard the write behind that check, but no extra persistence shape should be introduced for that purpose.

## Recommendation

Use a dedicated backend `SessionNamingService` and perform the naming call as a background follow-up after the first completed assistant turn.

Rationale:

- one full user/assistant exchange is the smallest context window that is usually richer than the first prompt alone
- keeping generation off the main request path avoids adding latency to the first completed response
- using the existing title field keeps the implementation much smaller than a metadata-based design

Tradeoff:

- the generated title may appear slightly later, on a later refresh, instead of being available immediately at stream completion

## Naming Trigger

Recommended initial trigger:

- run only after `runtime.session.prompt()` completes successfully
- run only after the first completed assistant turn for the session
- use the transcript snapshot available at that first completed exchange
- run only once per session

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

This keeps the prompt small and predictable while still using real conversation context.

## Backend Architecture

Add a dedicated service rather than embedding prompt logic into `PiSessionStore` or `PiAgentService`.

Suggested files:

- `apps/api/src/services/session-naming-service.ts`

Suggested responsibilities:

### `SessionNamingService`

- determine whether a session qualifies for generation
- build the naming prompt from session messages
- invoke the configured model with a lightweight completion request
- normalize the result into a safe display title
- write the generated title through the existing session-title persistence path

### `PiSessionStore`

- expose the existing title read/write behavior
- continue to expose `firstMessage` separately for sidebar context

## Persistence Strategy

Use the existing conversation title field as the only persisted title state.

Reasoning:

- the generated title is created very early, after the first assistant turn, so the chance of clobbering a meaningful user rename is low
- using the existing field avoids metadata parsing, sidecar files, DTO expansion, and custom precedence rules
- after generation, the title should behave exactly like any other editable session title

Practical implication:

- `appendSessionInfo()` remains the only persistence path needed for titles
- there is no separate generated-title record to read, expose, or preserve
- if the implementation already has an easy placeholder equality check before overwriting, that is acceptable, but it should not require new metadata

## API and DTO Changes

No API or DTO changes are required for v1.

Rationale:

- the existing `name` field is sufficient because generated titles are stored as ordinary titles
- the frontend does not need to know whether a title came from the model or from a manual rename
- rename behavior can continue to use the existing API contract unchanged

## Request Flow Changes

Update the message streaming endpoint flow as follows:

1. run the main Pi request as today
2. persist the completed conversation turn
3. if this was the first completed assistant turn, enqueue or trigger a best-effort background call to `SessionNamingService` using that first completed exchange as input
4. emit the existing `session.done` event without waiting for title generation
5. when the background naming call completes, persist the generated title through the existing title update path
6. let the frontend pick up the new title on its normal next refresh

This keeps naming tied to successful persisted turns without extending the main request latency.

## Frontend Behavior

The first version should keep frontend changes small.

Suggested UI behavior:

- continue to optimistically show the truncated fallback title immediately
- allow the title to update naturally when a later refresh returns the generated value
- show rename controls exactly as today
- do not add special UI treatment for generated titles

Because generated titles use the ordinary title field, they remain editable with the current rename UX.

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

- runs only for the first completed assistant turn
- builds the prompt from the expected transcript slice
- normalizes noisy model output into a safe title
- writes the generated title through the existing title persistence path
- treats model-call failures as non-fatal

### Session store tests

- existing title reads continue to return the persisted conversation title
- existing rename writes still work after a generated title has been stored

### API tests

- after the first completed exchange, background generation eventually updates the session title
- when generation fails, the session still completes successfully with the fallback title intact
- a later manual rename still updates the title normally

### Web tests

- the optimistic title still uses the truncated fallback title immediately
- a later refresh switches the displayed title when the generated value has been persisted
- generated titles remain editable through the existing rename UI

## Files Likely To Change

- `apps/api/src/services/pi-session-store.ts`
- `apps/api/src/services/pi-agent-service.ts`
- `apps/api/src/services/session-naming-service.ts`
- `apps/api/src/app.ts`
- `apps/api/src/app.test.ts`
- `apps/api/src/services/pi-agent-service.test.ts` or a new focused service test file
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`

## Review Decisions

1. use the first completed assistant turn as the naming threshold
2. run title generation as a background follow-up rather than inline in the main request path
3. overwrite the existing title when the generated title is ready, without adding generated-title DTO fields or custom metadata fields
4. after generation, treat the stored title exactly like any other user-editable conversation title

## Proposed Next Step After Review

If this plan looks right, the implementation should proceed in this order:

1. wire first-turn detection into the post-stream request flow
2. implement `SessionNamingService` with a model-backed prompt and output normalization
3. write the generated title through the existing session title persistence path
4. update UI refresh behavior only as needed to surface the later title change
5. add focused API and web regression coverage