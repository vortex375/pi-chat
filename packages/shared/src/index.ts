import { Type, type Static } from "typebox";

export const HealthResponseSchema = Type.Object({
	status: Type.Literal("ok"),
	service: Type.Literal("pi-chat-api"),
	version: Type.String(),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const SessionSummarySchema = Type.Object({
	id: Type.String(),
	name: Type.Optional(Type.String()),
	displayName: Type.String(),
	hasCustomName: Type.Boolean(),
	firstMessage: Type.String(),
	modifiedAt: Type.String(),
});

export type SessionSummary = Static<typeof SessionSummarySchema>;

export const ChatMessageSchema = Type.Object({
	id: Type.String(),
	role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
	content: Type.String(),
	createdAt: Type.String(),
	status: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("streaming"), Type.Literal("error")]))
});

export type ChatMessage = Static<typeof ChatMessageSchema>;

export const SessionDetailSchema = Type.Object({
	id: Type.String(),
	name: Type.Optional(Type.String()),
	displayName: Type.String(),
	hasCustomName: Type.Boolean(),
	firstMessage: Type.String(),
	createdAt: Type.String(),
	modifiedAt: Type.String(),
	messages: Type.Array(ChatMessageSchema),
});

export type SessionDetail = Static<typeof SessionDetailSchema>;

export const RenameSessionRequestSchema = Type.Object({
	name: Type.String(),
});

export type RenameSessionRequest = Static<typeof RenameSessionRequestSchema>;

export const PromptRequestSchema = Type.Object({
	content: Type.String({ minLength: 1 }),
});

export type PromptRequest = Static<typeof PromptRequestSchema>;

export const StreamEventSchema = Type.Union([
	Type.Object({
		type: Type.Literal("session.started"),
		sessionId: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("message.user"),
		message: ChatMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("message.assistant.delta"),
		messageId: Type.String(),
		delta: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("tool.start"),
		toolName: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("tool.update"),
		toolName: Type.String(),
		content: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("tool.end"),
		toolName: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("message.assistant.done"),
		message: ChatMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("session.done"),
		sessionId: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("error"),
		message: Type.String(),
	}),
]);

export type StreamEvent = Static<typeof StreamEventSchema>;
