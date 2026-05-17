import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../env.js";
import { AgentResourceSynchronizer } from "./agent-resource-synchronizer.js";
import { CanvasBuildService } from "./canvas-build-service.js";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasRuntimeEventService } from "./canvas-runtime-event-service.js";
import { CanvasStore } from "./canvas-store.js";
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
	const agentResourceTemplateDir = join(root, "templates", "agent-resources");
	const usersRoot = join(root, "data", "users");
	const systemDataDir = join(root, "data", "system");
	const agentResourceDir = join(systemDataDir, "agent-resources");
	mkdirSync(templateDir, { recursive: true });
	mkdirSync(join(agentResourceTemplateDir, "skills"), { recursive: true });
	mkdirSync(systemDataDir, { recursive: true });
	writeFileSync(join(templateDir, "README.md"), "template", "utf-8");
	writeFileSync(
		join(systemDataDir, "auth.json"),
		JSON.stringify({ openrouter: { type: "api_key", key: "test-key" } }, null, 2),
		"utf-8",
	);
	writeFileSync(join(agentResourceTemplateDir, "append-system-prompt.md"), "Follow backend template instructions.", "utf-8");

	const config: AppConfig = {
		appVersion: "0.1.0",
		host: "127.0.0.1",
		port: 3000,
		nodeEnv: "test",
		projectRoot: root,
		dataRoot: join(root, "data"),
		systemDataDir,
		agentResourceTemplateDir,
		agentResourceDir,
		usersRoot,
		workspaceTemplateDir: templateDir,
		defaultUserId: "anonymous",
		piProvider: "openrouter",
		piModelId: "openai/gpt-oss-120b",
		sandboxRequired: false,
	};

	const templateProvisioner = new WorkspaceTemplateProvisioner(templateDir);
	const userWorkspaceService = new UserWorkspaceService({
		usersRoot,
		defaultUserId: "anonymous",
		templateProvisioner,
	});
	const sessionStore = new PiSessionStore(userWorkspaceService);
	const canvasStore = new CanvasStore(userWorkspaceService);
	const canvasEventBus = new CanvasEventBus();
	const canvasRuntimeEventService = new CanvasRuntimeEventService(canvasStore, canvasEventBus);
	const canvasBuildService = new CanvasBuildService(canvasStore, canvasEventBus, canvasRuntimeEventService);
	const piAgentService = new PiAgentService(
		config,
		userWorkspaceService,
		sessionStore,
		canvasStore,
		canvasEventBus,
		canvasBuildService,
	);

	return { agentResourceDir, agentResourceTemplateDir, piAgentService, root, sessionStore, userWorkspaceService };
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

	it("accepts provider-native env auth without auth.json credentials", () => {
		const fixture = createFixture();
		process.env.OPENROUTER_API_KEY = "env-test-key";

		try {
			expect(
				() =>
					new PiAgentService(
						fixture.piAgentService["config"],
						fixture.userWorkspaceService,
						fixture.sessionStore,
						fixture.piAgentService["canvasStore"],
						fixture.piAgentService["canvasEventBus"],
						fixture.piAgentService["canvasBuildService"],
					),
			).not.toThrow();
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("loads the synced append prompt and custom skills", async () => {
		const fixture = createFixture();
		const skillDir = join(fixture.agentResourceTemplateDir, "skills", "backend-review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			[
				"---",
				"name: backend-review",
				"description: Review backend changes and surface implementation risks.",
				"---",
				"",
				"# Backend Review",
			].join("\n"),
			"utf-8",
		);
		new AgentResourceSynchronizer(fixture.agentResourceTemplateDir).syncInto(fixture.agentResourceDir);

		const created = await fixture.sessionStore.createSession("anonymous");
		const runtime = await fixture.piAgentService.createRequestSession("anonymous", created.id);

		try {
			expect(runtime.session.systemPrompt).toContain("Follow backend template instructions.");
			expect(runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain("backend-review");
		} finally {
			runtime.session.dispose();
		}
	});

	it("ignores AGENTS.md and workspace-local skills from the user workspace", async () => {
		const fixture = createFixture();
		const paths = fixture.userWorkspaceService.ensureUserReady("anonymous");
		mkdirSync(join(paths.workspaceDir, ".pi", "skills", "workspace-skill"), { recursive: true });
		writeFileSync(join(paths.workspaceDir, "AGENTS.md"), "workspace instructions that must be ignored", "utf-8");
		writeFileSync(
			join(paths.workspaceDir, ".pi", "skills", "workspace-skill", "SKILL.md"),
			[
				"---",
				"name: workspace-skill",
				"description: A workspace-local skill that should not be loaded.",
				"---",
				"",
				"# Workspace Skill",
			].join("\n"),
			"utf-8",
		);

		const created = await fixture.sessionStore.createSession("anonymous");
		const runtime = await fixture.piAgentService.createRequestSession("anonymous", created.id);

		try {
			expect(runtime.session.systemPrompt).not.toContain("workspace instructions that must be ignored");
			expect(runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toContain(
				"workspace-skill",
			);
		} finally {
			runtime.session.dispose();
		}
	});

	it("fails fast when the configured model does not exist for the provider", () => {
		const fixture = createFixture();

		expect(
			() =>
				new PiAgentService(
					{ ...fixture.piAgentService["config"], piModelId: "missing-model" },
					fixture.userWorkspaceService,
					fixture.sessionStore,
					fixture.piAgentService["canvasStore"],
					fixture.piAgentService["canvasEventBus"],
					fixture.piAgentService["canvasBuildService"],
				),
		).toThrow(/Configured model not found/);
	});
});