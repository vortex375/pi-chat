import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../env.js";
import { PiAgentService } from "./pi-agent-service.js";
import { PiSessionStore } from "./pi-session-store.js";
import {
	buildSessionNamingPrompt,
	normalizeGeneratedSessionTitle,
	SessionNamingService,
} from "./session-naming-service.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

const cleanupPaths: string[] = [];

function createFixture(): {
	config: AppConfig;
	sessionStore: PiSessionStore;
	userWorkspaceService: UserWorkspaceService;
} {
	const root = join(tmpdir(), `pi-chat-session-naming-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		agentResourceTemplateDir: join(root, "templates", "agent-resources"),
		agentResourceDir: join(systemDataDir, "agent-resources"),
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
		defaultUserId: config.defaultUserId,
		templateProvisioner,
	});
	const sessionStore = new PiSessionStore(userWorkspaceService);

	return { config, sessionStore, userWorkspaceService };
}

afterEach(async () => {
	vi.clearAllMocks();
	const { rm } = await import("node:fs/promises");
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

describe("session naming helpers", () => {
	it("builds a prompt from the first completed exchange", () => {
		expect(
			buildSessionNamingPrompt({
				firstUserMessage: "Inspect the execution queue",
				firstAssistantMessage: "It serializes work per session.",
			}),
		).toContain("First user message: Inspect the execution queue");
		expect(
			buildSessionNamingPrompt({
				firstUserMessage: "Inspect the execution queue",
				firstAssistantMessage: "It serializes work per session.",
			}),
		).toContain("First assistant response: It serializes work per session.");
	});

	it("normalizes noisy model output into a safe title", () => {
		expect(normalizeGeneratedSessionTitle('Title: "Review execution queue."')).toBe("Review execution queue");
	});
});

describe("SessionNamingService", () => {
	it("writes the generated title through the existing session title persistence path", async () => {
		const fixture = createFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const completeSimple = vi.mocked((await import("@earendil-works/pi-ai")).completeSimple);
		completeSimple.mockResolvedValue({
			content: [{ type: "text", text: '"Queue coordination audit"' }],
		} as never);

		const service = new SessionNamingService(
			{
				getConfiguredModel() {
					return {
						api: "openai-completions",
						baseUrl: "https://openrouter.ai/api/v1",
						contextWindow: 256000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						headers: {},
						id: fixture.config.piModelId!,
						input: ["text"],
						maxTokens: 32768,
						name: fixture.config.piModelId!,
						provider: fixture.config.piProvider,
						reasoning: true,
					};
				},
				async getConfiguredRequestAuth() {
					return { apiKey: "test-key", headers: undefined };
				},
			} as PiAgentService,
			fixture.sessionStore,
		);

		const result = await service.generateTitle("anonymous", created.id, {
			firstUserMessage: "Inspect the queue",
			firstAssistantMessage: "It serializes work.",
		});
		const detail = await fixture.sessionStore.getSession("anonymous", created.id);

		expect(result).toBe("Queue coordination audit");
		expect(detail?.name).toBe("Queue coordination audit");
		expect(detail?.displayName).toBe("Queue coordination audit");
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(completeSimple.mock.calls[0]?.[1]).toMatchObject({
			systemPrompt: expect.stringContaining("Return title text only"),
			messages: [
				expect.objectContaining({
					content: expect.stringContaining("First user message: Inspect the queue"),
				}),
			],
		});
	});

	it("does not persist a title when the model call fails", async () => {
		const fixture = createFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const completeSimple = vi.mocked((await import("@earendil-works/pi-ai")).completeSimple);
		completeSimple.mockRejectedValue(new Error("Synthetic title failure"));

		const service = new SessionNamingService(
			{
				getConfiguredModel() {
					return {
						api: "openai-completions",
						baseUrl: "https://openrouter.ai/api/v1",
						contextWindow: 256000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						headers: {},
						id: fixture.config.piModelId!,
						input: ["text"],
						maxTokens: 32768,
						name: fixture.config.piModelId!,
						provider: fixture.config.piProvider,
						reasoning: true,
					};
				},
				async getConfiguredRequestAuth() {
					return { apiKey: "test-key", headers: undefined };
				},
			} as PiAgentService,
			fixture.sessionStore,
		);

		await expect(
			service.generateTitle("anonymous", created.id, {
				firstUserMessage: "Inspect the queue",
				firstAssistantMessage: "It serializes work.",
			}),
		).rejects.toThrow("Synthetic title failure");
		const detail = await fixture.sessionStore.getSession("anonymous", created.id);

		expect(detail?.name).toBeUndefined();
		expect(detail?.displayName).toBe("(no messages)");
	});
});
