import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Type } from "typebox";
import {
	PromptRequestSchema,
	RenameSessionRequestSchema,
	SessionDetailSchema,
	SessionSummarySchema,
	type ChatMessage,
	type HealthResponse,
	type RenameSessionRequest,
	type StreamEvent,
} from "@pi-chat/shared";
import type { AppConfig } from "./env.js";
import type { PiAgentService } from "./services/pi-agent-service.js";
import type { PiSessionStore } from "./services/pi-session-store.js";
import type { SessionExecutionQueue } from "./services/session-execution-queue.js";
import type { UserWorkspaceService } from "./services/user-workspace-service.js";

export interface CreateAppOptions {
	config: AppConfig;
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
