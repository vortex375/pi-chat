import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../env.js";
import { PiAgentService } from "./pi-agent-service.js";
import { PiSessionStore } from "./pi-session-store.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

function createFixture() {
	const root = join(tmpdir(), `pi-chat-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanupPaths.push(root);

	const templateDir = join(root, "templates", "workspace");
	const usersRoot = join(root, "data", "users");
	const systemDataDir = join(root, "data", "system");
	mkdirSync(templateDir, { recursive: true });
	mkdirSync(systemDataDir, { recursive: true });
	writeFileSync(join(templateDir, "README.md"), "template", "utf-8");

	const config: AppConfig = {
		appVersion: "0.1.0",
		host: "127.0.0.1",
		port: 3000,
		nodeEnv: "test",
		projectRoot: root,
		dataRoot: join(root, "data"),
		systemDataDir,
		usersRoot,
		workspaceTemplateDir: templateDir,
		defaultUserId: "anonymous",
		piProvider: "openrouter",
		piModelId: "openai/gpt-oss-120b",
		piOpenAiBaseUrl: "https://openrouter.ai/api/v1",
		piOpenAiApiKey: "test-key",
		sandboxRequired: false,
	};

	const templateProvisioner = new WorkspaceTemplateProvisioner(templateDir);
	const userWorkspaceService = new UserWorkspaceService({
		usersRoot,
		defaultUserId: "anonymous",
		templateProvisioner,
	});
	const sessionStore = new PiSessionStore(userWorkspaceService);
	const piAgentService = new PiAgentService(config, userWorkspaceService, sessionStore);

	return { piAgentService, sessionStore };
}

describe("PiAgentService", () => {
	it("creates a request-scoped agent session for a persisted session", async () => {
		const fixture = createFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const runtime = await fixture.piAgentService.createRequestSession("anonymous", created.id);

		try {
			expect(runtime.session.sessionId).toBe(created.id);
			expect(runtime.session.sessionFile).toContain(created.id);
		} finally {
			runtime.session.dispose();
		}
	});
});