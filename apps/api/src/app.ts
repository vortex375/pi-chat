import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Type } from "typebox";
import {
	CanvasSnapshotSchema,
	CanvasPublishResultSchema,
	CanvasRuntimeEventRequestSchema,
	PromptRequestSchema,
	PublishCanvasCardRequestSchema,
	RenameSessionRequestSchema,
	SessionDetailSchema,
	SessionSummarySchema,
	type CanvasEvent,
	type ChatMessage,
	type HealthResponse,
	type RenameSessionRequest,
	type StreamEvent,
} from "@pi-chat/shared";
import type { AppConfig } from "./env.js";
import type { CanvasBuildService } from "./services/canvas-build-service.js";
import type { CanvasEventBus } from "./services/canvas-event-bus.js";
import type { CanvasRuntimeEventService } from "./services/canvas-runtime-event-service.js";
import type { CanvasStore } from "./services/canvas-store.js";
import type { PiAgentService } from "./services/pi-agent-service.js";
import type { PiSessionStore } from "./services/pi-session-store.js";
import type { SessionExecutionQueue } from "./services/session-execution-queue.js";
import type { UserWorkspaceService } from "./services/user-workspace-service.js";

export interface CreateAppOptions {
	config: AppConfig;
	canvasBuildService: CanvasBuildService;
	canvasEventBus: CanvasEventBus;
	canvasRuntimeEventService: CanvasRuntimeEventService;
	canvasStore: CanvasStore;
	piAgentService: PiAgentService;
	sessionStore: PiSessionStore;
	sessionExecutionQueue: SessionExecutionQueue;
	userWorkspaceService: UserWorkspaceService;
	logger?: boolean;
}

const NotFoundSchema = Type.Object({
	message: Type.String(),
});

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ")
		.trim();
}

function createChatMessage(role: "user" | "assistant", content: string): ChatMessage {
	return {
		id: randomUUID(),
		role,
		content,
		createdAt: new Date().toISOString(),
		status: "complete",
	};
}

export function createApp(options: CreateAppOptions) {
	const app = Fastify({ logger: options.logger ?? true });
	const shouldServeWeb = options.config.nodeEnv === "production";
	const webDistDir = join(options.config.projectRoot, "apps", "web", "dist");

	app.decorate("config", options.config);
	app.decorate("canvasBuildService", options.canvasBuildService);
	app.decorate("canvasEventBus", options.canvasEventBus);
	app.decorate("canvasRuntimeEventService", options.canvasRuntimeEventService);
	app.decorate("canvasStore", options.canvasStore);
	app.decorate("piAgentService", options.piAgentService);
	app.decorate("sessionStore", options.sessionStore);
	app.decorate("sessionExecutionQueue", options.sessionExecutionQueue);
	app.decorate("userWorkspaceService", options.userWorkspaceService);

	if (shouldServeWeb) {
		const webIndexPath = join(webDistDir, "index.html");
		if (!existsSync(webDistDir) || !existsSync(webIndexPath)) {
			throw new Error(`Missing frontend build output: ${webDistDir}`);
		}

		void app.register(fastifyStatic, {
			index: false,
			prefix: "/",
			root: webDistDir,
		});

		app.get("/", (_request, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
	}

	app.get("/api/health", async () => {
		const response: HealthResponse = {
			status: "ok",
			service: "pi-chat-api",
			version: options.config.appVersion,
		};

		return response;
	});

	app.get(
		"/api/canvas",
		{
			schema: {
				response: {
					200: CanvasSnapshotSchema,
				},
			},
		},
		async () => app.canvasStore.getSnapshot(app.config.defaultUserId),
	);

	app.get(
		"/api/canvas/events",
		{
			schema: {
				querystring: Type.Object({
					browserSessionId: Type.Optional(Type.String()),
				}),
			},
		},
		async (request, reply) => {
			const params = request.query as { browserSessionId?: string };
			const userId = app.config.defaultUserId;
			const snapshot = await app.canvasStore.getSnapshot(userId);

			reply.hijack();
			const response = reply.raw;
			let streamClosed = false;
			let unsubscribe = () => {};

			const closeStream = () => {
				if (streamClosed) {
					return;
				}

				streamClosed = true;
				unsubscribe();
				if (!response.writableEnded) {
					response.end();
				}
			};

			response.on("close", closeStream);
			response.on("error", (error) => {
				app.log.warn({ err: error }, "canvas event stream error");
				closeStream();
			});
			response.writeHead(200, {
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"content-type": "text/event-stream; charset=utf-8",
			});

			const writeEvent = (event: CanvasEvent) => {
				if (streamClosed || response.destroyed || response.writableEnded) {
					return;
				}

				try {
					response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				} catch {
					closeStream();
				}
			};

			unsubscribe = app.canvasEventBus.subscribe(userId, params.browserSessionId, writeEvent);
			writeEvent({
				type: "canvas.snapshot",
				snapshot,
			});
		},
	);

	app.post(
		"/api/canvas/cards/publish",
		{
			schema: {
				body: PublishCanvasCardRequestSchema,
				response: {
					200: CanvasPublishResultSchema,
				},
			},
		},
		async (request) => {
			return app.canvasBuildService.publishCard(app.config.defaultUserId, request.body as never);
		},
	);

	app.delete(
		"/api/canvas/cards/:cardId",
		{
			schema: {
				params: Type.Object({ cardId: Type.String() }),
				response: {
					204: Type.Null(),
					404: NotFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const params = request.params as { cardId: string };
			const removed = await app.canvasStore.removeCard(app.config.defaultUserId, params.cardId);
			if (!removed) {
				return reply.code(404).send({ message: "Canvas card not found" });
			}

			app.canvasEventBus.publish(app.config.defaultUserId, {
				type: "canvas.card.removed",
				cardId: params.cardId,
			});
			return reply.code(204).send();
		},
	);

	app.get(
		"/api/canvas/cards/:cardId/bundle.js",
		{
			schema: {
				params: Type.Object({ cardId: Type.String() }),
				response: {
					404: NotFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const params = request.params as { cardId: string };
			const card = await app.canvasStore.getCard(app.config.defaultUserId, params.cardId);
			if (!card?.bundleUrl) {
				return reply.code(404).send({ message: "Canvas bundle not found" });
			}

			const bundlePath = app.canvasStore.getBundlePathForCard(app.config.defaultUserId, params.cardId);
			if (!existsSync(bundlePath)) {
				return reply.code(404).send({ message: "Canvas bundle not found" });
			}

			return reply.type("application/javascript; charset=utf-8").send(readFileSync(bundlePath, "utf-8"));
		},
	);

	app.post(
		"/api/canvas/cards/:cardId/runtime-events",
		{
			schema: {
				params: Type.Object({ cardId: Type.String() }),
				body: CanvasRuntimeEventRequestSchema,
				response: {
					200: Type.Object({
						acknowledged: Type.Boolean(),
					}),
				},
			},
		},
		async (request) => {
			const params = request.params as { cardId: string };
			const result = await app.canvasRuntimeEventService.handleEvent(
				app.config.defaultUserId,
				params.cardId,
				request.body as never,
			);
			return {
				acknowledged: result.acknowledged,
			};
		},
	);

	app.get("/api/canvas/runtime/react.js", async (_request, reply) =>
		reply.type("application/javascript; charset=utf-8").send(
			[
				"const runtime = globalThis.__PI_CHAT_CANVAS_RUNTIME__;",
				"if (!runtime?.react) throw new Error('Pi Chat canvas React runtime is unavailable.');",
				"const React = runtime.react;",
				"export default React;",
				"export const Children = React.Children;",
				"export const Component = React.Component;",
				"export const Fragment = React.Fragment;",
				"export const Profiler = React.Profiler;",
				"export const PureComponent = React.PureComponent;",
				"export const StrictMode = React.StrictMode;",
				"export const Suspense = React.Suspense;",
				"export const cloneElement = React.cloneElement;",
				"export const createContext = React.createContext;",
				"export const createElement = React.createElement;",
				"export const createRef = React.createRef;",
				"export const forwardRef = React.forwardRef;",
				"export const isValidElement = React.isValidElement;",
				"export const lazy = React.lazy;",
				"export const memo = React.memo;",
				"export const startTransition = React.startTransition;",
				"export const use = React.use;",
				"export const useActionState = React.useActionState;",
				"export const useCallback = React.useCallback;",
				"export const useContext = React.useContext;",
				"export const useDebugValue = React.useDebugValue;",
				"export const useDeferredValue = React.useDeferredValue;",
				"export const useEffect = React.useEffect;",
				"export const useId = React.useId;",
				"export const useImperativeHandle = React.useImperativeHandle;",
				"export const useInsertionEffect = React.useInsertionEffect;",
				"export const useLayoutEffect = React.useLayoutEffect;",
				"export const useMemo = React.useMemo;",
				"export const useOptimistic = React.useOptimistic;",
				"export const useReducer = React.useReducer;",
				"export const useRef = React.useRef;",
				"export const useState = React.useState;",
				"export const useSyncExternalStore = React.useSyncExternalStore;",
				"export const useTransition = React.useTransition;",
			].join("\n"),
		),
	);

	app.get("/api/canvas/runtime/react-jsx-runtime.js", async (_request, reply) =>
		reply.type("application/javascript; charset=utf-8").send(
			[
				"const runtime = globalThis.__PI_CHAT_CANVAS_RUNTIME__;",
				"if (!runtime?.jsxRuntime) throw new Error('Pi Chat canvas JSX runtime is unavailable.');",
				"export const Fragment = runtime.jsxRuntime.Fragment;",
				"export const jsx = runtime.jsxRuntime.jsx;",
				"export const jsxs = runtime.jsxRuntime.jsxs;",
			].join("\n"),
		),
	);

	app.get("/api/canvas/runtime/react-jsx-dev-runtime.js", async (_request, reply) =>
		reply.type("application/javascript; charset=utf-8").send(
			[
				"const runtime = globalThis.__PI_CHAT_CANVAS_RUNTIME__;",
				"if (!runtime?.jsxRuntime) throw new Error('Pi Chat canvas JSX dev runtime is unavailable.');",
				"export const Fragment = runtime.jsxRuntime.Fragment;",
				"export const jsxDEV = runtime.jsxRuntime.jsxDEV;",
			].join("\n"),
		),
	);

	app.get(
		"/api/sessions",
		{
			schema: {
				response: {
					200: Type.Array(SessionSummarySchema),
				},
			},
		},
		async () => app.sessionStore.listSessions(app.config.defaultUserId),
	);

	app.post(
		"/api/sessions",
		{
			schema: {
				response: {
					201: SessionDetailSchema,
				},
			},
		},
		async (_request, reply) => {
			const session = await app.sessionStore.createSession(app.config.defaultUserId);
			return reply.code(201).send(session);
		},
	);

	app.get(
		"/api/sessions/:sessionId",
		{
			schema: {
				params: Type.Object({ sessionId: Type.String() }),
				response: {
					200: SessionDetailSchema,
					404: NotFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const params = request.params as { sessionId: string };
			const session = await app.sessionStore.getSession(app.config.defaultUserId, params.sessionId);

			if (!session) {
				return reply.code(404).send({ message: "Session not found" });
			}

			return session;
		},
	);

	app.patch(
		"/api/sessions/:sessionId",
		{
			schema: {
				params: Type.Object({ sessionId: Type.String() }),
				body: RenameSessionRequestSchema,
				response: {
					200: SessionDetailSchema,
					404: NotFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const params = request.params as { sessionId: string };
			const body = request.body as RenameSessionRequest;
			const session = await app.sessionStore.renameSession(app.config.defaultUserId, params.sessionId, body.name);

			if (!session) {
				return reply.code(404).send({ message: "Session not found" });
			}

			return session;
		},
	);

	app.delete(
		"/api/sessions/:sessionId",
		{
			schema: {
				params: Type.Object({ sessionId: Type.String() }),
				response: {
					204: Type.Null(),
					404: NotFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const params = request.params as { sessionId: string };
			const deleted = await app.sessionStore.deleteSession(app.config.defaultUserId, params.sessionId);

			if (!deleted) {
				return reply.code(404).send({ message: "Session not found" });
			}

			return reply.code(204).send();
		},
	);

	app.post(
		"/api/sessions/:sessionId/messages",
		{
			schema: {
				params: Type.Object({ sessionId: Type.String() }),
				body: PromptRequestSchema,
				response: {
					404: NotFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const params = request.params as { sessionId: string };
			const body = request.body as { content: string };
			const userId = app.config.defaultUserId;
			const existingPath = await app.sessionStore.getSessionPath(userId, params.sessionId);

			if (!existingPath) {
				return reply.code(404).send({ message: "Session not found" });
			}

			reply.hijack();
			const response = reply.raw;
			let streamClosed = false;
			response.on("close", () => {
				streamClosed = true;
			});
			response.on("error", (error) => {
				streamClosed = true;
				app.log.warn({ err: error, sessionId: params.sessionId }, "stream response error");
			});
			response.writeHead(200, {
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"content-type": "text/event-stream; charset=utf-8",
			});

			const writeEvent = (event: StreamEvent) => {
				if (streamClosed || response.destroyed || response.writableEnded) {
					return;
				}

				try {
					const accepted = response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
					if (!accepted) {
						app.log.debug({ sessionId: params.sessionId, eventType: event.type }, "stream backpressure signaled");
					}
				} catch {
					streamClosed = true;
				}
			};

			try {
				await app.sessionExecutionQueue.run(params.sessionId, async () => {
					const runtime = await app.piAgentService.createRequestSession(userId, params.sessionId);
				let assistantMessageId: string | undefined;
				const unsubscribe = runtime.session.subscribe((event: any) => {
					if (event.type === "message_start" && event.message.role === "user") {
						writeEvent({
							type: "message.user",
							message: createChatMessage("user", extractTextContent(event.message.content)),
						});
						return;
					}

					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
						assistantMessageId ??= randomUUID();
						writeEvent({
							type: "message.assistant.delta",
							messageId: assistantMessageId,
							delta: event.assistantMessageEvent.delta,
						});
						return;
					}

					if (event.type === "tool_execution_start") {
						writeEvent({ type: "tool.start", toolName: event.toolName });
						return;
					}

					if (event.type === "tool_execution_update") {
						writeEvent({
							type: "tool.update",
							toolName: event.toolName,
							content: extractTextContent(event.partialResult?.content ?? event.partialResult),
						});
						return;
					}

					if (event.type === "tool_execution_end") {
						writeEvent({ type: "tool.end", toolName: event.toolName });
						return;
					}

					if (event.type === "message_end" && event.message.role === "assistant") {
						assistantMessageId ??= randomUUID();
						writeEvent({
							type: "message.assistant.done",
							message: {
								id: assistantMessageId,
								role: "assistant",
								content: extractTextContent(event.message.content),
								createdAt: new Date().toISOString(),
								status: "complete",
							},
						});
					}
				});

					writeEvent({ type: "session.started", sessionId: params.sessionId });

					try {
						await runtime.session.prompt(body.content);
						writeEvent({ type: "session.done", sessionId: params.sessionId });
					} catch (error) {
						writeEvent({
							type: "error",
							message: error instanceof Error ? error.message : String(error),
						});
					} finally {
						unsubscribe();
						runtime.session.dispose();
					}
				});
			} catch (error) {
				writeEvent({
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}

			if (!response.writableEnded) {
				response.end();
			}
		},
	);

	if (shouldServeWeb) {
		app.setNotFoundHandler((request, reply) => {
			if (request.url.startsWith("/api/")) {
				return reply.code(404).send({ message: "Route not found" });
			}

			if (request.method !== "GET") {
				return reply.code(404).send({ message: "Route not found" });
			}

			if (extname(request.url)) {
				return reply.code(404).send({ message: "Asset not found" });
			}

			return reply.type("text/html; charset=utf-8").sendFile("index.html");
		});
	}

	return app;
}
