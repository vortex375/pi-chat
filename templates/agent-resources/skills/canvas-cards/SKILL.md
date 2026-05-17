---
name: canvas-cards
description: Author, publish, debug, and manage workspace canvas cards.
---

# Canvas cards

Use this workflow when you want to render custom UI in the workspace canvas.

## File location

Write card source files under:

```text
workspace/canvas/cards/
```

Keep related relative imports inside that same tree.

## Supported imports

v1 supports:

- `react`
- relative imports inside `workspace/canvas/cards`

Do not rely on app-internal imports, external packages, or browser-global Pi Chat internals.

## Component contract

Export a default React component. The host passes:

- `cardId`
- `data`
- `host.ready()`
- `host.setTitle(title)`

Example:

```tsx
import { useEffect, useState } from "react";

type Props = {
	cardId: string;
	data?: { start?: number };
	host: {
		ready: () => void;
		setTitle: (title: string) => void;
	};
};

export default function CounterCard({ data, host }: Props) {
	const [count, setCount] = useState(data?.start ?? 0);

	useEffect(() => {
		host.ready();
	}, [host]);

	useEffect(() => {
		host.setTitle(`Counter: ${count}`);
	}, [count, host]);

	return (
		<div>
			<p>Count: {count}</p>
			<button onClick={() => setCount((value) => value + 1)}>Increment</button>
		</div>
	);
}
```

## Publish flow

1. Write or update the component file under `workspace/canvas/cards`.
2. Call `canvas_publish_card` with the component path, title, and optional props payload.
3. If publish returns diagnostics, inspect them with `canvas_get_diagnostics`, fix the file, and republish.
4. Call `canvas_set_visibility` with `open` if you want the user to see the canvas immediately.

## Diagnostics

- Build diagnostics come from bundling and import validation.
- Runtime diagnostics come from the browser if the mounted card throws.
- `canvas_get_diagnostics` returns stored diagnostics for one card or the whole canvas.

## Scope boundaries

- Card interactions stay in the browser in v1.
- The backend only receives lifecycle/runtime signals such as ready, resize, and runtime errors.
- Do not assume button clicks, form submissions, or arbitrary client events are sent back to the conversation.
