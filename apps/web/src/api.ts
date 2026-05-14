import type {
	PromptRequest,
	RenameSessionRequest,
	SessionDetail,
	SessionSummary,
	StreamEvent,
} from "@pi-chat/shared";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

function toUrl(path: string): string {
	return `${API_BASE_URL}${path}`;
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: string };
		if (body.message) {
			return body.message;
		}
	} catch {
		// Fall back to the HTTP status when the response is not JSON.
	}

	return `${response.status} ${response.statusText}`.trim();
}

async function request(path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	if (init?.body !== undefined && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}

	const response = await fetch(toUrl(path), {
		...init,
		headers,
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	return response;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await request(path, init);
	return (await response.json()) as T;
}

function parseStreamEvent(block: string): StreamEvent | undefined {
	const normalizedBlock = block.replace(/\r/g, "").trim();
	if (!normalizedBlock) {
		return undefined;
	}

	const data = normalizedBlock
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");

	if (!data) {
		return undefined;
	}

	return JSON.parse(data) as StreamEvent;
}

export function listSessions(): Promise<SessionSummary[]> {
	return requestJson<SessionSummary[]>("/api/sessions");
}

export function createSession(): Promise<SessionDetail> {
	return requestJson<SessionDetail>("/api/sessions", { method: "POST", body: JSON.stringify({}) });
}

export function getSession(sessionId: string): Promise<SessionDetail> {
	return requestJson<SessionDetail>(`/api/sessions/${sessionId}`);
}

export function renameSession(sessionId: string, name: string): Promise<SessionDetail> {
	const body: RenameSessionRequest = { name };
	return requestJson<SessionDetail>(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

export async function deleteSession(sessionId: string): Promise<void> {
	await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
}

export async function streamSessionMessage(
	sessionId: string,
	content: string,
	options: {
		onEvent: (event: StreamEvent) => void;
		signal?: AbortSignal;
	},
): Promise<void> {
	const body: PromptRequest = { content };
	const init: RequestInit = {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	};

	if (options.signal) {
		init.signal = options.signal;
	}

	const response = await fetch(toUrl(`/api/sessions/${sessionId}/messages`), init);

	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	if (!response.body) {
		throw new Error("Streaming response body is unavailable.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const normalized = buffer.replace(/\r/g, "");
		const blocks = normalized.split("\n\n");
		buffer = blocks.pop() ?? "";

		for (const block of blocks) {
			const event = parseStreamEvent(block);
			if (event) {
				options.onEvent(event);
			}
		}

		if (done) {
			break;
		}
	}

	const tailEvent = parseStreamEvent(buffer);
	if (tailEvent) {
		options.onEvent(tailEvent);
	}
}
