import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./env.js";
import { PiAgentService } from "./services/pi-agent-service.js";
import { PiSessionStore } from "./services/pi-session-store.js";
import { SessionExecutionQueue } from "./services/session-execution-queue.js";
import { WorkspaceTemplateProvisioner } from "./services/workspace-template-provisioner.js";
import { UserWorkspaceService } from "./services/user-workspace-service.js";

const cleanupPaths: string[] = [];

function createConfigFixture(): {
	config: AppConfig;
	piAgentService: PiAgentService;
	sessionStore: PiSessionStore;
	sessionExecutionQueue: SessionExecutionQueue;
	userWorkspaceService: UserWorkspaceService;
} {
	const root = join(tmpdir(), `pi-chat-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		defaultUserId: config.defaultUserId,
		templateProvisioner,
	});
	const sessionStore = new PiSessionStore(userWorkspaceService);
	const piAgentService = new PiAgentService(config, userWorkspaceService, sessionStore);
	const sessionExecutionQueue = new SessionExecutionQueue();

	return { config, piAgentService, sessionStore, sessionExecutionQueue, userWorkspaceService };
}

function parseSseEvents(body: string) {
	return body
		.trim()
		.split("\n\n")
		.map((chunk) => {
			const lines = chunk.split("\n");
			const dataLine = lines.find((line) => line.startsWith("data: "));
			return dataLine ? JSON.parse(dataLine.slice(6)) : undefined;
		})
		.filter((event): event is Record<string, unknown> => event !== undefined);
}

function createFakeStreamingAgentService(fixture: ReturnType<typeof createConfigFixture>) {
	return {
		async createRequestSession(_userId: string, sessionId: string) {
			const sessionPath = await fixture.sessionStore.getSessionPath(fixture.config.defaultUserId, sessionId);
			if (!sessionPath) {
				throw new Error("Missing session path");
			}

			const paths = fixture.userWorkspaceService.ensureUserReady(fixture.config.defaultUserId);
			const sessionManager = SessionManager.open(sessionPath, paths.sessionsDir, paths.workspaceDir);
			const listeners = new Set<(event: any) => void>();

			return {
				session: {
					sessionId,
					sessionFile: sessionPath,
					subscribe(listener: (event: any) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async prompt(text: string) {
						const emit = (event: any) => {
							for (const listener of listeners) {
								listener(event);
							}
						};

						const userMessage = { role: "user", content: text };
						const assistantMessage = { role: "assistant", content: [{ type: "text", text: "Hello back" }] };

						emit({ type: "message_start", message: userMessage });
						sessionManager.appendMessage(userMessage as never);
						emit({ type: "message_end", message: userMessage });
						emit({ type: "tool_execution_start", toolName: "read" });
						emit({
							type: "tool_execution_update",
							toolName: "read",
							partialResult: { content: [{ type: "text", text: "tool output" }] },
						});
						emit({ type: "tool_execution_end", toolName: "read" });
						emit({ type: "message_start", message: assistantMessage });
						emit({
							type: "message_update",
							message: assistantMessage,
							assistantMessageEvent: { type: "text_delta", delta: "Hello back" },
						});
						sessionManager.appendMessage(assistantMessage as never);
						emit({ type: "message_end", message: assistantMessage });
						emit({ type: "agent_end", messages: [userMessage, assistantMessage] });
					},
					dispose() {},
				},
			};
		},
	} as PiAgentService;
}

function createThrowingAgentService() {
	return {
		async createRequestSession(_userId: string, sessionId: string) {
			const listeners = new Set<(event: any) => void>();
			return {
				session: {
					sessionId,
					sessionFile: `/tmp/${sessionId}.jsonl`,
					subscribe(listener: (event: any) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async prompt() {
						throw new Error("synthetic stream failure");
					},
					dispose() {},
				},
			};
		},
	} as PiAgentService;
}

function createQueuedAgentService(log: string[]) {
	let firstRelease!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		firstRelease = resolve;
	});
	let firstStartedResolve!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		firstStartedResolve = resolve;
	});

	return {
		firstRelease,
		firstStarted,
		service: {
			async createRequestSession(_userId: string, sessionId: string) {
				const listeners = new Set<(event: any) => void>();
				return {
					session: {
						sessionId,
						sessionFile: `/tmp/${sessionId}.jsonl`,
						subscribe(listener: (event: any) => void) {
							listeners.add(listener);
							return () => listeners.delete(listener);
						},
						async prompt(text: string) {
							log.push(`${text}:start`);
							if (text === "first") {
								firstStartedResolve();
								await firstGate;
							}
							log.push(`${text}:end`);
						},
						dispose() {},
					},
				};
			},
		} as PiAgentService,
	};
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

describe("createApp", () => {
	it("returns the health response", async () => {
		const fixture = createConfigFixture();
		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const response = await app.inject({ method: "GET", url: "/api/health" });
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			status: "ok",
			service: "pi-chat-api",
			version: "0.1.0",
		});
	});

	it("creates, lists, fetches, and renames sessions through the API", async () => {
		const fixture = createConfigFixture();
		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const createResponse = await app.inject({ method: "POST", url: "/api/sessions" });
		const created = createResponse.json();
		const listResponse = await app.inject({ method: "GET", url: "/api/sessions" });
		const detailResponse = await app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
		const renameResponse = await app.inject({
			method: "PATCH",
			url: `/api/sessions/${created.id}`,
			payload: { name: "Renamed session" },
		});

		await app.close();

		expect(createResponse.statusCode).toBe(201);
		expect(listResponse.statusCode).toBe(200);
		expect(detailResponse.statusCode).toBe(200);
		expect(renameResponse.statusCode).toBe(200);
		expect(listResponse.json()).toHaveLength(1);
		expect(detailResponse.json().id).toBe(created.id);
		expect(renameResponse.json().name).toBe("Renamed session");
		expect(renameResponse.json().displayName).toBe("Renamed session");
	});

	it("returns 404 for unknown sessions", async () => {
		const fixture = createConfigFixture();
		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const getResponse = await app.inject({ method: "GET", url: "/api/sessions/missing-session" });
		const patchResponse = await app.inject({
			method: "PATCH",
			url: "/api/sessions/missing-session",
			payload: { name: "Does not exist" },
		});

		await app.close();

		expect(getResponse.statusCode).toBe(404);
		expect(patchResponse.statusCode).toBe(404);
	});

	it("rejects patch requests without a name field", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const response = await app.inject({
			method: "PATCH",
			url: `/api/sessions/${created.id}`,
			payload: {},
		});

		await app.close();

		expect(response.statusCode).toBe(400);
	});

	it("streams message events and persists the completed turn", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createApp({
			config: fixture.config,
			piAgentService: createFakeStreamingAgentService(fixture),
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "Say hello" },
		});
		const events = parseSseEvents(response.body);
		const detail = await fixture.sessionStore.getSession("anonymous", created.id);

		await app.close();

		expect(response.statusCode).toBe(200);
		expect(events.map((event) => event.type)).toEqual([
			"session.started",
			"message.user",
			"tool.start",
			"tool.update",
			"tool.end",
			"message.assistant.delta",
			"message.assistant.done",
			"session.done",
		]);
		expect(detail?.messages).toHaveLength(2);
		expect(detail?.messages[0]?.content).toBe("Say hello");
		expect(detail?.messages[1]?.content).toBe("Hello back");
	});

	it("returns 404 for a missing streaming session", async () => {
		const fixture = createConfigFixture();
		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const response = await app.inject({
			method: "POST",
			url: "/api/sessions/missing/messages",
			payload: { content: "Hello" },
		});

		await app.close();

		expect(response.statusCode).toBe(404);
	});

	it("rejects empty prompt payloads", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "" },
		});

		await app.close();

		expect(response.statusCode).toBe(400);
	});

	it("streams an error event when prompt execution fails", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createApp({
			config: fixture.config,
			piAgentService: createThrowingAgentService(),
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "Boom" },
		});
		const events = parseSseEvents(response.body);

		await app.close();

		expect(events.map((event) => event.type)).toEqual(["session.started", "error"]);
	});

	it("serializes concurrent streaming requests for the same session", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const log: string[] = [];
		const queued = createQueuedAgentService(log);
		const app = createApp({
			config: fixture.config,
			piAgentService: queued.service,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const firstRequest = app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "first" },
		});
		const secondRequest = app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "second" },
		});

		await queued.firstStarted;
		expect(log).toEqual(["first:start"]);

		queued.firstRelease();
		await Promise.all([firstRequest, secondRequest]);
		await app.close();

		expect(log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("serves the built frontend in production without intercepting API routes", async () => {
		const fixture = createConfigFixture();
		fixture.config.nodeEnv = "production";
		const webDistDir = join(fixture.config.projectRoot, "apps", "web", "dist");
		const assetDir = join(webDistDir, "assets");
		mkdirSync(assetDir, { recursive: true });
		writeFileSync(join(webDistDir, "index.html"), "<html><body><div id=\"root\">Pi Chat</div></body></html>", "utf-8");
		writeFileSync(join(assetDir, "app.js"), "console.log('pi-chat');", "utf-8");

		const app = createApp({
			config: fixture.config,
			piAgentService: fixture.piAgentService,
			sessionStore: fixture.sessionStore,
			sessionExecutionQueue: fixture.sessionExecutionQueue,
			userWorkspaceService: fixture.userWorkspaceService,
			logger: false,
		});

		const indexResponse = await app.inject({ method: "GET", url: "/" });
		const assetResponse = await app.inject({ method: "GET", url: "/assets/app.js" });
		const spaResponse = await app.inject({ method: "GET", url: "/sessions/demo" });
		const apiResponse = await app.inject({ method: "GET", url: "/api/health" });

		await app.close();

		expect(indexResponse.statusCode).toBe(200);
		expect(indexResponse.body).toContain("Pi Chat");
		expect(assetResponse.statusCode).toBe(200);
		expect(assetResponse.body).toContain("pi-chat");
		expect(spaResponse.statusCode).toBe(200);
		expect(spaResponse.body).toContain("Pi Chat");
		expect(apiResponse.statusCode).toBe(200);
		expect(apiResponse.json()).toEqual({
			status: "ok",
			service: "pi-chat-api",
			version: "0.1.0",
		});
	});

	it("fails fast in production when index.html is missing", () => {
		const fixture = createConfigFixture();
		fixture.config.nodeEnv = "production";
		const webDistDir = join(fixture.config.projectRoot, "apps", "web", "dist");
		mkdirSync(webDistDir, { recursive: true });

		expect(() =>
			createApp({
				config: fixture.config,
				piAgentService: fixture.piAgentService,
				sessionStore: fixture.sessionStore,
				sessionExecutionQueue: fixture.sessionExecutionQueue,
				userWorkspaceService: fixture.userWorkspaceService,
				logger: false,
			}),
		).toThrow(/Missing frontend build output/);
	});
});


