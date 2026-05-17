# UI Density Overhaul Follow-up Plan

## Goal

Make the density overhaul visibly stronger by shrinking action controls that still dominate the layout, especially in the session list and conversation header.

## Problem Statement

The initial overhaul improved shell spacing, but some of the most obvious sources of wasted space remain action-heavy controls:

- the **Delete** action in each session list row still claims too much of the row
- the conversation header actions (**Hide canvas**, **Rename**, **Delete**) still read as large content blocks instead of secondary controls

That means the UI still feels chrome-heavy even after the first pass. The next iteration should make actions feel lightweight and subordinate to the message list, transcript, and canvas.

## Follow-up Direction

Treat these actions as utility controls, not primary content.

Concretely:

- convert high-footprint text actions to compact icon buttons where the action is already obvious from placement
- keep accessibility by preserving clear `aria-label` and `title` text
- reduce visual weight through smaller button frames, tighter spacing, and less prominent typography
- give the title and message content more room by moving action groups into compact clusters

## Implementation Steps

### 1. Session list actions

Update the session row actions in `apps/web/src/App.tsx` so the delete affordance no longer consumes a large share of each item.

- replace the text delete pill with a compact icon button
- keep the row focused on session name, preview, and modified time
- preserve the current delete confirmation flow

### 2. Conversation header actions

Update the conversation header controls in `apps/web/src/App.tsx`.

- replace **Rename** with a compact icon control
- replace **Delete** with a compact danger icon control
- replace **Hide canvas / Open canvas** with a compact icon control
- keep the controls accessible via `aria-label` so tests and keyboard users still have explicit names

### 3. Tighten action layout

Rebalance the header layout so the title and stream status own the space, while action controls live in a smaller secondary cluster.

### 4. Validate the result

- run the relevant web tests
- run the full repository build
- visually inspect the running worktree frontend to confirm the reduction is obvious

## Files To Change

- `apps/web/src/App.tsx`
- optional supporting style changes in `apps/web/src/index.css`

## Acceptance Criteria

- session list delete controls no longer take up a visually dominant portion of each row
- conversation header actions no longer compete with the title and status pill
- message and canvas surfaces gain more usable room because header chrome is lighter
- accessibility is preserved through explicit labels and focus states
