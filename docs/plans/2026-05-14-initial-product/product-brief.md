# Pi Chat initial product brief

## What we want to build

### Backend

A Node.js / TypeScript backend application that uses pi agent harness to provide a chat bot experience over a REST-API

- embeds pi using its SDK features
- multi-user and multi-session support with persistent sessions (using either session persistence provided by pi, if available, or our own postgres database)
- response streaming support
- support for uploading and downloading files to/from the session
- SANDBOXED execution: each user should have their own "workspace" - the pi agent must not be allowed to access files outside of its workspace. Workspaces are created dynamically on-demand when the first user session is created

### Frontend

A minimal React/Typescript and TailwindCSS application that provides the following features:

- split view with session list on the left and message bubbles / conversation view on the right side
- session list allows to select previous sessions or create a new session. When selecting a session the stored conversation is shown in the conversation view
- conversation view has message bubbles like a chat app and a text box for entering a message at the bottom
- conversation view should show stored / persistent conversation and also support streaming of the current response

## Implementation notes

Important: pi source code and documentation is available in the "coding-agent" workspace. In particular have a look at `docs/sdk.md` and the `examples/sdk` folder.

Important: never make modification in the "coding-agent" workspace. All work, including plan files, docs and actual coding must be done in the "pi-chat" workspace.

## Limitation in initial prototype

To reduce the scope of the initial prototype we will add a few restrictions:

- no login and authentication in initial prototype. Prepare for multi-user support, but use a hard-coded "anonymous" userId for all requests, sessions, interactions
- we can skip the file upload/download feature for now and add it in a later iteration