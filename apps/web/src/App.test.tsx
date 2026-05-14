import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage, SessionDetail, SessionSummary, StreamEvent } from "@pi-chat/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as api from "./api";

vi.mock("./api", () => ({
	createSession: vi.fn(),
	getSession: vi.fn(),
	listSessions: vi.fn(),
	renameSession: vi.fn(),
	streamSessionMessage: vi.fn(),
}));

const mockedApi = vi.mocked(api);

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createMessage(id: string, role: "user" | "assistant", content: string, status?: ChatMessage["status"]): ChatMessage {
	const message: ChatMessage = {
		id,
		role,
		content,
		createdAt: new Date("2026-05-14T12:00:00.000Z").toISOString(),
	};

	if (status !== undefined) {
		message.status = status;
	}

	return message;
}

function createSessionDetail(input: {
	id: string;
	displayName: string;
	firstMessage: string;
	messages: ChatMessage[];
	name?: string;
	hasCustomName?: boolean;
}): SessionDetail {
	const detail: SessionDetail = {
		id: input.id,
		displayName: input.displayName,
		hasCustomName: input.hasCustomName ?? input.name !== undefined,
		firstMessage: input.firstMessage,
		createdAt: new Date("2026-05-14T12:00:00.000Z").toISOString(),
		modifiedAt: new Date("2026-05-14T12:30:00.000Z").toISOString(),
		messages: input.messages,
	};

	if (input.name !== undefined) {
		detail.name = input.name;
	}

	return detail;
}

function toSummary(detail: SessionDetail): SessionSummary {
	const summary: SessionSummary = {
		id: detail.id,
		displayName: detail.displayName,
		hasCustomName: detail.hasCustomName,
		firstMessage: detail.firstMessage,
		modifiedAt: detail.modifiedAt,
	};

	if (detail.name !== undefined) {
		summary.name = detail.name;
	}

	return summary;
}

function requireSessionDetail(sessions: Record<string, SessionDetail>, sessionId: string): SessionDetail {
	const detail = sessions[sessionId];
	if (!detail) {
		throw new Error(`Missing session fixture: ${sessionId}`);
	}
	return detail;
}

describe("App", () => {
	let sessionDetails: Record<string, SessionDetail>;
	let sessionList: SessionSummary[];

	beforeEach(() => {
		const sessionOne = createSessionDetail({
			id: "session-1",
			displayName: "Repository overview",
			firstMessage: "Summarize the repository",
			messages: [
				createMessage("m1", "user", "Summarize the repository"),
				createMessage("m2", "assistant", "It contains an API, a web app, and shared contracts."),
			],
		});
		const sessionTwo = createSessionDetail({
			id: "session-2",
			displayName: "Sandbox review",
			name: "Sandbox review",
			firstMessage: "Check the sandbox rules",
			hasCustomName: true,
			messages: [
				createMessage("m3", "user", "Check the sandbox rules"),
				createMessage("m4", "assistant", "The workspace guard blocks absolute paths outside the root."),
			],
		});

		sessionDetails = {
			[sessionOne.id]: sessionOne,
			[sessionTwo.id]: sessionTwo,
		};
		sessionList = [toSummary(sessionTwo), toSummary(sessionOne)];

		mockedApi.listSessions.mockImplementation(async () => clone(sessionList));
		mockedApi.getSession.mockImplementation(async (sessionId: string) => {
			return clone(requireSessionDetail(sessionDetails, sessionId));
		});
		mockedApi.createSession.mockImplementation(async () => {
			const detail = createSessionDetail({
				id: "session-3",
				displayName: EMPTY_NAME,
				firstMessage: EMPTY_NAME,
				messages: [],
			});
			sessionDetails[detail.id] = detail;
			sessionList = [toSummary(detail), ...sessionList];
			return clone(detail);
		});
		mockedApi.renameSession.mockImplementation(async (sessionId: string, name: string) => {
			const current = requireSessionDetail(sessionDetails, sessionId);
			const trimmed = name.trim();
			const nextInput: Parameters<typeof createSessionDetail>[0] = {
				id: current.id,
				displayName: trimmed || current.firstMessage,
				firstMessage: current.firstMessage,
				messages: current.messages,
				hasCustomName: trimmed.length > 0,
			};

			if (trimmed.length > 0) {
				nextInput.name = trimmed;
			}

			const next = createSessionDetail(nextInput);
			sessionDetails[sessionId] = next;
			sessionList = sessionList.map((session) => (session.id === sessionId ? toSummary(next) : session));
			return clone(next);
		});
		mockedApi.streamSessionMessage.mockImplementation(async () => {});
	});

	async function renderApp(): Promise<void> {
		render(<App />);
		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "Sandbox review" })).toBeInTheDocument();
		});
	}

	it("renders the session list from the server", async () => {
		await renderApp();

		expect(screen.getByRole("button", { name: /Repository overview/i })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Sandbox review" })).toBeInTheDocument();
	});

	it("selecting a session loads its transcript", async () => {
		const user = userEvent.setup();
		await renderApp();

		await user.click(screen.getByRole("button", { name: /Repository overview/i }));

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "Repository overview" })).toBeInTheDocument();
		});
		expect(screen.getByText("It contains an API, a web app, and shared contracts.")).toBeInTheDocument();
	});

	it("editing a session title updates the header and sidebar", async () => {
		const user = userEvent.setup();
		await renderApp();

		await user.click(screen.getByRole("button", { name: "Rename" }));
		const input = screen.getByPlaceholderText("Session title");
		await user.clear(input);
		await user.type(input, "Runtime audit");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "Runtime audit" })).toBeInTheDocument();
		});
		expect(screen.getAllByText("Runtime audit").length).toBeGreaterThan(1);
	});

	it("composer submits a message and shows optimistic UI", async () => {
		const user = userEvent.setup();
		let resolveStream!: () => void;
		mockedApi.streamSessionMessage.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveStream = resolve;
				}),
		);

		await renderApp();
		const composer = screen.getByPlaceholderText(/Send a prompt into the workspace/i);
		await user.type(composer, "Inspect the queue");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(mockedApi.streamSessionMessage).toHaveBeenCalledWith(
			"session-2",
			"Inspect the queue",
			expect.objectContaining({ onEvent: expect.any(Function) }),
		);
		expect(screen.getByText("Inspect the queue")).toBeInTheDocument();
		expect(screen.getByText("Thinking...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Repository overview/i })).toBeDisabled();

		await act(async () => {
			resolveStream();
		});
	});

	it("keeps the error state when a stream emits an error", async () => {
		const user = userEvent.setup();
		let emit!: (event: StreamEvent) => void;
		let finishStream!: () => void;
		mockedApi.streamSessionMessage.mockImplementation(
			async (_sessionId, _content, options) =>
				new Promise<void>((resolve) => {
					emit = options.onEvent;
					finishStream = resolve;
				}),
		);

		await renderApp();
		const composer = screen.getByPlaceholderText(/Send a prompt into the workspace/i);
		await user.type(composer, "Trigger the failure path");
		await user.click(screen.getByRole("button", { name: "Send" }));

		await act(async () => {
			emit({ type: "error", message: "Synthetic stream failure" });
			finishStream();
		});

		await waitFor(() => {
			expect(screen.getAllByText("Synthetic stream failure").length).toBeGreaterThan(1);
		});
		expect(screen.getByText("error")).toBeInTheDocument();
		expect(screen.queryByText("Response saved.")).not.toBeInTheDocument();
	});

	it("streaming assistant updates the active bubble progressively", async () => {
		const user = userEvent.setup();
		let emit!: (event: StreamEvent) => void;
		let finishStream!: () => void;
		let persistedFinal = false;
		mockedApi.streamSessionMessage.mockImplementation(
			async (_sessionId, _content, options) =>
				new Promise<void>((resolve) => {
					emit = options.onEvent;
					finishStream = resolve;
				}),
		);
		mockedApi.getSession.mockImplementation(async (sessionId: string) => {
			if (persistedFinal && sessionId === "session-2") {
				const finalDetail = createSessionDetail({
					id: "session-2",
					displayName: "Sandbox review",
					name: "Sandbox review",
					firstMessage: "Check the sandbox rules",
					hasCustomName: true,
					messages: [
						createMessage("m3", "user", "Check the sandbox rules"),
						createMessage("m4", "assistant", "The workspace guard blocks absolute paths outside the root."),
						createMessage("m5", "user", "Explain the execution queue"),
						createMessage("m6", "assistant", "It serializes work per session while allowing parallel work across sessions."),
					],
				});
				sessionDetails[sessionId] = finalDetail;
				sessionList = sessionList.map((session) => (session.id === sessionId ? toSummary(finalDetail) : session));
				return clone(finalDetail);
			}

			return clone(requireSessionDetail(sessionDetails, sessionId));
		});

		await renderApp();
		const composer = screen.getByPlaceholderText(/Send a prompt into the workspace/i);
		await user.type(composer, "Explain the execution queue");
		await user.click(screen.getByRole("button", { name: "Send" }));

		await act(async () => {
			emit({ type: "message.assistant.delta", messageId: "assistant-stream", delta: "It serializes work " });
		});
		await waitFor(() => {
			expect(screen.getByText((content) => content.startsWith("It serializes work"))).toBeInTheDocument();
		});

		await act(async () => {
			emit({ type: "message.assistant.delta", messageId: "assistant-stream", delta: "per session." });
		});
		await waitFor(() => {
			expect(screen.getByText("It serializes work per session.")).toBeInTheDocument();
		});

		persistedFinal = true;
		await act(async () => {
			emit({
				type: "message.assistant.done",
				message: createMessage(
					"m6",
					"assistant",
					"It serializes work per session while allowing parallel work across sessions.",
					"complete",
				),
			});
			emit({ type: "session.done", sessionId: "session-2" });
			finishStream();
		});

		await waitFor(() => {
			expect(
				screen.getByText("It serializes work per session while allowing parallel work across sessions."),
			).toBeInTheDocument();
		});
	});

	it("renders assistant bubble content as markdown", async () => {
		const markdownSession = createSessionDetail({
			id: "session-markdown",
			displayName: "Markdown rendering",
			firstMessage: "Show markdown",
			messages: [
				createMessage("md-1", "user", "Show markdown"),
				createMessage(
					"md-2",
					"assistant",
					"Use **bold** text, `inline code`, and a list:\n\n- first item\n- second item\n\n```ts\nconst value = 1;\n```",
				),
			],
		});

		sessionDetails = { [markdownSession.id]: markdownSession };
		sessionList = [toSummary(markdownSession)];
		mockedApi.listSessions.mockResolvedValue(clone(sessionList));
		mockedApi.getSession.mockImplementation(async (sessionId: string) => clone(requireSessionDetail(sessionDetails, sessionId)));

		render(<App />);
		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "Markdown rendering" })).toBeInTheDocument();
		});

		expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
		expect(screen.getByText("inline code", { selector: "code" })).toBeInTheDocument();
		expect(screen.getByRole("list")).toBeInTheDocument();
		expect(screen.getByText("const value = 1;", { selector: "code" })).toBeInTheDocument();
	});
});

const EMPTY_NAME = "(no messages)";
