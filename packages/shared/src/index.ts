import { Type, type Static } from "typebox";

const SESSION_TITLE_MAX_WORDS = 8;
const SESSION_TITLE_MAX_LENGTH = 56;

function trimSessionTitleToLength(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	const candidate = value.slice(0, maxLength + 1).trimEnd();
	const boundary = candidate.lastIndexOf(" ");
	const truncated = boundary >= Math.floor(maxLength * 0.6) ? candidate.slice(0, boundary) : value.slice(0, maxLength).trimEnd();
	return `${truncated}...`;
}

export function getFallbackSessionTitle(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "(no messages)";
	}

	const words = normalized.split(" ");
	const limitedByWords = words.length > SESSION_TITLE_MAX_WORDS;
	const wordLimitedTitle = limitedByWords ? words.slice(0, SESSION_TITLE_MAX_WORDS).join(" ") : normalized;

	if (wordLimitedTitle.length > SESSION_TITLE_MAX_LENGTH) {
		return trimSessionTitleToLength(wordLimitedTitle, SESSION_TITLE_MAX_LENGTH);
	}

	if (limitedByWords) {
		return `${wordLimitedTitle}...`;
	}

	return wordLimitedTitle;
}

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

export const CanvasCardStatusSchema = Type.Union([
	Type.Literal("draft"),
	Type.Literal("ready"),
	Type.Literal("build_error"),
	Type.Literal("runtime_error"),
]);

export type CanvasCardStatus = Static<typeof CanvasCardStatusSchema>;

export const CanvasDiagnosticSchema = Type.Object({
	id: Type.String(),
	stage: Type.Union([Type.Literal("build"), Type.Literal("runtime")]),
	severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
	message: Type.String(),
	filePath: Type.Optional(Type.String()),
	line: Type.Optional(Type.Number()),
	column: Type.Optional(Type.Number()),
	stack: Type.Optional(Type.String()),
	createdAt: Type.String(),
});

export type CanvasDiagnostic = Static<typeof CanvasDiagnosticSchema>;

export const CanvasDiagnosticsSchema = Type.Record(Type.String(), Type.Array(CanvasDiagnosticSchema));

export type CanvasDiagnostics = Static<typeof CanvasDiagnosticsSchema>;

export const CanvasCardSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	componentPath: Type.String(),
	status: CanvasCardStatusSchema,
	props: Type.Optional(Type.Unknown()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	lastPublishedAt: Type.Optional(Type.String()),
	lastReadyAt: Type.Optional(Type.String()),
	lastMeasuredHeight: Type.Optional(Type.Number()),
	bundleUrl: Type.Optional(Type.String()),
});

export type CanvasCard = Static<typeof CanvasCardSchema>;

export const CanvasSnapshotSchema = Type.Object({
	cards: Type.Array(CanvasCardSchema),
	diagnostics: CanvasDiagnosticsSchema,
	generatedAt: Type.String(),
});

export type CanvasSnapshot = Static<typeof CanvasSnapshotSchema>;

export const CanvasVisibilityRequestSchema = Type.Object({
	visibility: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
	browserSessionId: Type.Optional(Type.String()),
	requestedAt: Type.String(),
});

export type CanvasVisibilityRequest = Static<typeof CanvasVisibilityRequestSchema>;

export const PublishCanvasCardRequestSchema = Type.Object({
	componentPath: Type.String(),
	title: Type.String(),
	props: Type.Optional(Type.Unknown()),
});

export type PublishCanvasCardRequest = Static<typeof PublishCanvasCardRequestSchema>;

export const CanvasPublishResultSchema = Type.Object({
	card: CanvasCardSchema,
	diagnostics: Type.Array(CanvasDiagnosticSchema),
	ready: Type.Boolean(),
});

export type CanvasPublishResult = Static<typeof CanvasPublishResultSchema>;

export const CanvasRuntimeEventRequestSchema = Type.Object({
	type: Type.Union([Type.Literal("ready"), Type.Literal("resize"), Type.Literal("runtime_error")]),
	height: Type.Optional(Type.Number()),
	message: Type.Optional(Type.String()),
	stack: Type.Optional(Type.String()),
	browserSessionId: Type.Optional(Type.String()),
});

export type CanvasRuntimeEventRequest = Static<typeof CanvasRuntimeEventRequestSchema>;

export const CanvasEventSchema = Type.Union([
	Type.Object({
		type: Type.Literal("canvas.snapshot"),
		snapshot: CanvasSnapshotSchema,
	}),
	Type.Object({
		type: Type.Literal("canvas.card.published"),
		card: CanvasCardSchema,
	}),
	Type.Object({
		type: Type.Literal("canvas.card.removed"),
		cardId: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("canvas.card.updated"),
		card: CanvasCardSchema,
	}),
	Type.Object({
		type: Type.Literal("canvas.card.error"),
		cardId: Type.String(),
		diagnostics: Type.Array(CanvasDiagnosticSchema),
	}),
	Type.Object({
		type: Type.Literal("canvas.visibility.requested"),
		request: CanvasVisibilityRequestSchema,
	}),
]);

export type CanvasEvent = Static<typeof CanvasEventSchema>;
