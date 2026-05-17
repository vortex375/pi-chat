Workspace canvas cards live under `workspace/canvas/cards`.

- Author canvas cards as React components in that folder.
- Supported imports stay narrow in v1: `react` plus relative imports within `workspace/canvas/cards`.
- Publish cards with `canvas_publish_card` after writing the file.
- Use `canvas_get_diagnostics` when publish or runtime errors occur, repair the source file, and republish.
- Use `canvas_list_cards` to inspect current canvas state.
- Use `canvas_set_visibility` when you want to bring the canvas into view.
- Card components receive `cardId`, `data`, and a `host` object with `ready()` and `setTitle(title)`.
- Keep card interactions client-side only; do not expect user clicks or form input to be sent back to the backend.