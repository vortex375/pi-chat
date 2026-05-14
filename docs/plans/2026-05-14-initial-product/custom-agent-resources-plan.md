# Custom Agent Resources Plan

## Goal

Add a file-based mechanism for backend-owned custom agent resources that mirrors the existing workspace template pattern.

The backend agent should be able to load:

- one optional Markdown file whose contents are appended to the system prompt
- zero or more custom skills, where each skill is a directory containing `SKILL.md` plus any supporting scripts or reference files

This mechanism must remain explicit and backend-controlled. It must not enable ambient discovery from the user workspace.

## Constraints

- Keep the current security stance: do not load `AGENTS.md`, `.pi/skills`, `.agents/skills`, or other prompt resources from the user workspace.
- Keep the current backend-owned base system prompt in place and append custom instructions after it.
- Keep custom skills file-based and reviewable in the repository.
- Reuse the `templates/workspace` directory pattern, but treat `templates/agent-resources` as the managed source of truth rather than a one-time seed.
- Avoid changing the sandbox boundary. Skills may guide the model, but file and shell access must still go through the existing restricted tools.

## Proposed Layout

Add a new template tree alongside the workspace template:

```text
templates/
  workspace/
  agent-resources/
    append-system-prompt.md
    skills/
      example-skill/
        SKILL.md
        scripts/
        references/
```

Add a provisioned runtime location under backend-owned system data:

```text
data/
  system/
    auth.json
    agent-resources/
      append-system-prompt.md
      skills/
```

Rationale:

- `templates/agent-resources` gives a repo-local place to define custom instructions and skills.
- `data/system/agent-resources` matches the existing pattern of copying template content into runtime-owned storage.
- The backend can load only from `data/system/agent-resources`, keeping the trust boundary outside the user workspace.

## Synchronization Model

Introduce a dedicated synchronizer for backend agent resources.

Suggested shape:

- `AgentResourceSynchronizer`
  - constructor takes `templateDir`
  - `syncInto(targetDir)` makes the runtime target directory match the template directory
  - create the target directory if needed
  - copy new files and directories from the template
  - overwrite existing runtime files when the template version changes
  - remove runtime files that no longer exist in the template

Suggested initialization behavior:

- Synchronize `data/system/agent-resources` from `templates/agent-resources` during backend startup.
- If the target directory is missing or empty, create it and copy in the full template contents.
- If the template changes, update the provisioned runtime copy on the next backend start.
- If a template file or skill directory is deleted, remove it from the runtime copy on the next backend start.

This makes `templates/agent-resources` the canonical repo-managed configuration while still loading from backend-owned runtime storage under `data/system`.

## Backend Loading Model

Keep ambient discovery disabled, but explicitly load the provisioned resources.

### DefaultResourceLoader wiring

Update `PiAgentService` so the resource loader continues to set:

- `noContextFiles: true`
- `noPromptTemplates: true`
- `noSkills: true`

Then add explicit resource inputs:

- `appendSystemPrompt`: path to `data/system/agent-resources/append-system-prompt.md` when present
- `additionalSkillPaths`: path to `data/system/agent-resources/skills` when present

Rationale:

- `appendSystemPrompt` preserves the backend-owned base prompt and adds custom instructions after it.
- `additionalSkillPaths` works even with `noSkills: true`, so the backend can load only the skill directories it explicitly trusts.

### Runtime behavior

For every request-scoped agent session:

1. ensure the user workspace is ready as today
2. use the synchronized agent resources already prepared during backend startup
3. create the `DefaultResourceLoader` with explicit append prompt and skill paths
4. reload the resource loader
5. create the agent session

The result is a backend agent that still ignores user workspace instructions, but can use curated instructions and skills supplied through the new template tree.

## Configuration Surface

Keep the initial implementation convention-based rather than adding new environment variables.

Suggested defaults:

- agent resource template dir: `templates/agent-resources`
- provisioned agent resource dir: `data/system/agent-resources`

Implementation detail:

- extend `AppConfig` with resolved paths for these two directories
- validate the template directory exists in the same way the workspace template directory is validated

This keeps the first version simple and fully file-based. If needed later, the backend can add env overrides for alternative template or runtime paths.

Operational note:

- `data/system/agent-resources` is now an implementation detail and synchronized mirror, not the long-term source of truth for manual edits
- changes should be made under `templates/agent-resources`

## Files Likely To Change

- `apps/api/src/env.ts`
  - add resolved paths for the agent resource template directory and provisioned runtime directory
  - validate the template directory exists

- `apps/api/src/services/pi-agent-service.ts`
  - load synchronized agent resources from the runtime mirror when creating the resource loader
  - pass explicit append prompt and skill paths into `DefaultResourceLoader`

- `apps/api/src/services/`
  - add `agent-resource-synchronizer.ts`

- `apps/api/src/index.ts`
  - synchronize agent resources during backend startup before serving requests

- `templates/agent-resources/`
  - add placeholder `append-system-prompt.md`
  - add placeholder `skills/` structure or a README explaining how to add skills

- `README.md`
  - document how to customize backend instructions and skills using the new template directory

## Testing Plan

Add focused backend tests for the new file-based resource path.

### Synchronizer tests

- copies template contents into an empty target directory
- updates existing runtime files when the template changes
- removes runtime files that are no longer present in the template
- preserves nested skill directories and supporting files

### PiAgentService tests

- when `append-system-prompt.md` exists in the provisioned resource directory, the session system prompt includes its contents
- when a skill directory exists under `skills/`, the resource loader exposes that skill
- when the template resource directory is empty, session creation still succeeds
- user workspace files named `AGENTS.md` or `.pi/skills/...` are still ignored

### Startup integration tests

- when `templates/agent-resources` changes before backend startup, the synchronized runtime copy reflects the updated prompt append and skill set
- template changes require a backend restart before new request-scoped sessions see them

### Regression coverage

- existing request-scoped session creation test continues to pass
- existing sandbox/tool restriction behavior remains unchanged

## Rollout Notes

The first version should treat `templates/agent-resources` as the source of truth and `data/system/agent-resources` as a synchronized runtime mirror.

That means:

- the template tree is synchronized into the runtime directory during backend startup
- later edits to files under `templates/agent-resources` take effect after the next backend restart
- later edits made directly under `data/system/agent-resources` are temporary and may be overwritten or removed on the next startup sync

This intentionally differs from the current workspace template semantics because the goal here is repo-managed agent behavior, not runtime-local customization.

## Locked Decision

Synchronization cadence is locked to backend startup.

The implementation should:

- synchronize `templates/agent-resources` into `data/system/agent-resources` during backend startup
- overwrite changed files and remove deleted files so the runtime mirror stays exact
- require a backend restart for template changes to take effect in new request-scoped sessions

This trades immediate propagation for a simpler runtime path and avoids filesystem sync work on every request.