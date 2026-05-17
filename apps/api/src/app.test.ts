import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./env.js";
import { CanvasBuildService } from "./services/canvas-build-service.js";
import { CanvasEventBus } from "./services/canvas-event-bus.js";
import { CanvasRuntimeEventService } from "./services/canvas-runtime-event-service.js";
import { CanvasStore } from "./services/canvas-store.js";
import { PiAgentService } from "./services/pi-agent-service.js";
import { PiSessionStore } from "./services/pi-session-store.js";
import { SessionNamingService } from "./services/session-naming-service.js";
import { SessionExecutionQueue } from "./services/session-execution-queue.js";
import { WorkspaceTemplateProvisioner } from "./services/workspace-template-provisioner.js";
import { UserWorkspaceService } from "./services/user-workspace-service.js";

const cleanupPaths: string[] = [];

function createConfigFixture(): {
	config: AppConfig;
	canvasBuildService: CanvasBuildService;
	canvasEventBus: CanvasEventBus;
	canvasRuntimeEventService: CanvasRuntimeEventService;
	canvasStore: CanvasStore;
	piAgentService: PiAgentService;
	sessionStore: PiSessionStore;
	sessionNamingService: SessionNamingService;
	sessionExecutionQueue: SessionExecutionQueue;
	userWorkspaceService: UserWorkspaceService;
} {
	const root = join(tmpdir(), `pi-chat-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanupPaths.push(root);

	const templateDir = join(root, "templates", "workspace");
	const agentResourceTemplateDir = join(root, "templates", "agent-resources");
	const usersRoot = join(root, "data", "users");
	const systemDataDir = join(root, "data", "system");
	mkdirSync(templateDir, { recursive: true });
	mkdirSync(agentResourceTemplateDir, { recursive: true });
	mkdirSync(systemDataDir, { recursive: true });
	writeFileSync(join(templateDir, "README.md"), "template", "utf-8");
	writeFileSync(join(agentResourceTemplateDir, "append-system-prompt.md"), "test prompt", "utf-8");
	writeFileSync(
		join(systemDataDir, "auth.json"),
		JSON.stringify({ openrouter: { type: "api_key", key: "test-key" } }, null, 2),
		"utf-8",
	);

	const config: AppConfig = {
		appVersion: "0.1.0",
		host: "127.0.0.1",
		port: 3000,
		nodeEnv: "test",
		projectRoot: root,
		dataRoot: join(root, "data"),
		systemDataDir,
		agentResourceTemplateDir,
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
	const canvasStore = new CanvasStore(userWorkspaceService);
	const canvasEventBus = new CanvasEventBus();
	const canvasRuntimeEventService = new CanvasRuntimeEventService(canvasStore, canvasEventBus);
	const canvasBuildService = new CanvasBuildService(canvasStore, canvasEventBus, canvasRuntimeEventService);
	const sessionStore = new PiSessionStore(userWorkspaceService);
	const piAgentService = new PiAgentService(
		config,
		userWorkspaceService,
		sessionStore,
		canvasStore,
		canvasEventBus,
		canvasBuildService,
	);
	const sessionNamingService = {
		async generateTitle() {
			return undefined;
		},
	} as SessionNamingService;
	const sessionExecutionQueue = new SessionExecutionQueue();

	return {
		config,
		canvasBuildService,
		canvasEventBus,
		canvasRuntimeEventService,
		canvasStore,
		piAgentService,
		sessionStore,
		sessionNamingService,
		sessionExecutionQueue,
		userWorkspaceService,
	};
}

function createTestApp(
	fixture: ReturnType<typeof createConfigFixture>,
	overrides: Partial<Parameters<typeof createApp>[0]> = {},
) {
	return createApp({
		config: fixture.config,
		canvasBuildService: fixture.canvasBuildService,
		canvasEventBus: fixture.canvasEventBus,
		canvasRuntimeEventService: fixture.canvasRuntimeEventService,
		canvasStore: fixture.canvasStore,
		piAgentService: fixture.piAgentService,
		sessionStore: fixture.sessionStore,
		sessionNamingService: fixture.sessionNamingService,
		sessionExecutionQueue: fixture.sessionExecutionQueue,
		userWorkspaceService: fixture.userWorkspaceService,
		logger: false,
		...overrides,
	});
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
		const app = createTestApp(fixture);

		const response = await app.inject({ method: "GET", url: "/api/health" });
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			status: "ok",
			service: "pi-chat-api",
			version: "0.1.0",
		});
	});

	it("creates, lists, fetches, renames, and deletes sessions through the API", async () => {
		const fixture = createConfigFixture();
		const app = createTestApp(fixture);

		const createResponse = await app.inject({ method: "POST", url: "/api/sessions" });
		const created = createResponse.json();
		const listResponse = await app.inject({ method: "GET", url: "/api/sessions" });
		const detailResponse = await app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
		const renameResponse = await app.inject({
			method: "PATCH",
			url: `/api/sessions/${created.id}`,
			payload: { name: "Renamed session" },
		});
		const deleteResponse = await app.inject({ method: "DELETE", url: `/api/sessions/${created.id}` });
		const listAfterDeleteResponse = await app.inject({ method: "GET", url: "/api/sessions" });
		const detailAfterDeleteResponse = await app.inject({ method: "GET", url: `/api/sessions/${created.id}` });

		await app.close();

		expect(createResponse.statusCode).toBe(201);
		expect(listResponse.statusCode).toBe(200);
		expect(detailResponse.statusCode).toBe(200);
		expect(renameResponse.statusCode).toBe(200);
		expect(deleteResponse.statusCode).toBe(204);
		expect(listResponse.json()).toHaveLength(1);
		expect(listAfterDeleteResponse.json()).toHaveLength(0);
		expect(detailResponse.json().id).toBe(created.id);
		expect(detailAfterDeleteResponse.statusCode).toBe(404);
		expect(renameResponse.json().name).toBe("Renamed session");
		expect(renameResponse.json().displayName).toBe("Renamed session");
	});

	it("returns 404 for unknown sessions", async () => {
		const fixture = createConfigFixture();
		const app = createTestApp(fixture);

		const getResponse = await app.inject({ method: "GET", url: "/api/sessions/missing-session" });
		const patchResponse = await app.inject({
			method: "PATCH",
			url: "/api/sessions/missing-session",
			payload: { name: "Does not exist" },
		});
		const deleteResponse = await app.inject({ method: "DELETE", url: "/api/sessions/missing-session" });

		await app.close();

		expect(getResponse.statusCode).toBe(404);
		expect(patchResponse.statusCode).toBe(404);
		expect(deleteResponse.statusCode).toBe(404);
	});

	it("rejects patch requests without a name field", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createTestApp(fixture);

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
		const app = createTestApp(fixture, {
			piAgentService: createFakeStreamingAgentService(fixture),
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

	it("updates the session title in a background follow-up after the first completed exchange", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		let backgroundComplete!: () => void;
		const backgroundDone = new Promise<void>((resolve) => {
			backgroundComplete = resolve;
		});
		const app = createTestApp(fixture, {
			piAgentService: createFakeStreamingAgentService(fixture),
			sessionNamingService: {
				async generateTitle(userId: string, sessionId: string, snapshot: { firstUserMessage: string; firstAssistantMessage: string }) {
					expect(snapshot).toEqual({
						firstUserMessage: "Say hello",
						firstAssistantMessage: "Hello back",
					});
					await fixture.sessionStore.setSessionTitle(userId, sessionId, "Greeting flow");
					backgroundComplete();
					return "Greeting flow";
				},
			} as SessionNamingService,
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "Say hello" },
		});
		await backgroundDone;
		const detail = await fixture.sessionStore.getSession("anonymous", created.id);

		await app.close();

		expect(response.statusCode).toBe(200);
		expect(detail?.displayName).toBe("Greeting flow");
		expect(detail?.name).toBe("Greeting flow");
	});

	it("does not wait for background title generation before completing the stream", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		let releaseTitleGeneration!: () => void;
		const titleGenerationGate = new Promise<void>((resolve) => {
			releaseTitleGeneration = resolve;
		});
		const app = createTestApp(fixture, {
			piAgentService: createFakeStreamingAgentService(fixture),
			sessionNamingService: {
				async generateTitle() {
					await titleGenerationGate;
					return undefined;
				},
			} as SessionNamingService,
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "Say hello" },
		});
		const events = parseSseEvents(response.body);

		releaseTitleGeneration();
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(events.map((event) => event.type)).toContain("session.done");
		expect(events.map((event) => event.type)).not.toContain("error");
	});

	it("keeps the fallback title when background title generation fails", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createTestApp(fixture, {
			piAgentService: createFakeStreamingAgentService(fixture),
			sessionNamingService: {
				async generateTitle() {
					throw new Error("Synthetic title failure");
				},
			} as SessionNamingService,
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "Say hello" },
		});
		const detail = await fixture.sessionStore.getSession("anonymous", created.id);

		await app.close();

		expect(response.statusCode).toBe(200);
		expect(detail?.displayName).toBe("Say hello");
		expect(detail?.name).toBeUndefined();
	});

	it("keeps the main request successful when title-generation scheduling fails", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		vi.spyOn(fixture.sessionStore, "getSessionNamingSnapshot").mockRejectedValue(new Error("snapshot lookup failed"));
		const app = createTestApp(fixture, {
			piAgentService: createFakeStreamingAgentService(fixture),
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: "Say hello" },
		});
		const events = parseSseEvents(response.body);

		await app.close();

		expect(response.statusCode).toBe(200);
		expect(events.map((event) => event.type)).toContain("session.done");
		expect(events.map((event) => event.type)).not.toContain("error");
	});

	it("truncates fallback session titles derived from the first user prompt", async () => {
		const fixture = createConfigFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const app = createTestApp(fixture, {
			piAgentService: createFakeStreamingAgentService(fixture),
		});
		const prompt = "Explain how the execution queue coordinates long running workspace tasks across multiple session requests";

		const response = await app.inject({
			method: "POST",
			url: `/api/sessions/${created.id}/messages`,
			payload: { content: prompt },
		});
		const detail = await fixture.sessionStore.getSession("anonymous", created.id);
		const sessions = await fixture.sessionStore.listSessions("anonymous");

		await app.close();

		expect(response.statusCode).toBe(200);
		expect(detail?.firstMessage).toBe(prompt);
		expect(detail?.displayName).toBe("Explain how the execution queue coordinates long running...");
		expect(sessions[0]?.displayName).toBe("Explain how the execution queue coordinates long running...");
	});

	it("returns 404 for a missing streaming session", async () => {
		const fixture = createConfigFixture();
		const app = createTestApp(fixture);

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
		const app = createTestApp(fixture);

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
		const app = createTestApp(fixture, {
			piAgentService: createThrowingAgentService(),
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
		const app = createTestApp(fixture, {
			piAgentService: queued.service,
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

	it("returns an empty canvas snapshot and persists the manifest", async () => {
		const fixture = createConfigFixture();
		const app = createTestApp(fixture);

		const response = await app.inject({ method: "GET", url: "/api/canvas" });
		const manifestPath = fixture.canvasStore.ensureInitialized(fixture.config.defaultUserId).manifestPath;
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			cards: [],
			diagnostics: {},
		});
		expect(existsSync(manifestPath)).toBe(true);
	});

	it("publishes a canvas card and serves its bundle", async () => {
		const fixture = createConfigFixture();
		const paths = fixture.canvasStore.ensureInitialized("anonymous");
		writeFileSync(
			join(paths.canvasCardsDir, "hello-card.tsx"),
			[
				"export default function HelloCard(props: any) {",
				"  return <section>{props.data?.label ?? 'Hello canvas'}</section>;",
				"}",
			].join("\n"),
			"utf-8",
		);
		fixture.canvasEventBus.subscribe("anonymous", "browser-a", (event) => {
			if (
				(event.type === "canvas.card.published" || event.type === "canvas.card.updated") &&
				event.card.componentPath === "canvas/cards/hello-card.tsx" &&
				event.card.status === "draft"
			) {
				void fixture.canvasRuntimeEventService.handleEvent("anonymous", event.card.id, {
					type: "ready",
					browserSessionId: "browser-a",
				});
			}
		});
		const app = createTestApp(fixture);

		const publishResponse = await app.inject({
			method: "POST",
			url: "/api/canvas/cards/publish",
			payload: {
				componentPath: "canvas/cards/hello-card.tsx",
				title: "Hello card",
				props: { label: "Hello from publish" },
			},
		});
		const publishResult = publishResponse.json();
		const bundleResponse = await app.inject({
			method: "GET",
			url: `/api/canvas/cards/${publishResult.card.id}/bundle.js`,
		});

		await app.close();

		expect(publishResponse.statusCode).toBe(200);
		expect(publishResult.ready).toBe(true);
		expect(publishResult.card.status).toBe("ready");
		expect(bundleResponse.statusCode).toBe(200);
		expect(bundleResponse.body).toContain("HelloCard");
	});

	it("serves the built frontend in production without intercepting API routes", async () => {
		const fixture = createConfigFixture();
		fixture.config.nodeEnv = "production";
		const webDistDir = join(fixture.config.projectRoot, "apps", "web", "dist");
		const assetDir = join(webDistDir, "assets");
		mkdirSync(assetDir, { recursive: true });
		writeFileSync(join(webDistDir, "index.html"), "<html><body><div id=\"root\">Pi Chat</div></body></html>", "utf-8");
		writeFileSync(join(assetDir, "app.js"), "console.log('pi-chat');", "utf-8");

		const app = createTestApp(fixture);

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
			createTestApp(fixture),
		).toThrow(/Missing frontend build output/);
	});
});
