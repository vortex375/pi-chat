import { completeSimple } from "@earendil-works/pi-ai";
import { getFallbackSessionTitle } from "@pi-chat/shared";
import type { PiAgentService } from "./pi-agent-service.js";
import type { PiSessionStore, SessionNamingSnapshot } from "./pi-session-store.js";

const SESSION_NAMING_SYSTEM_PROMPT = [
	"You generate short conversation titles for coding sessions.",
	"Return title text only.",
	"Use roughly 3 to 7 words.",
	"Describe the main task or topic.",
	"Do not include quotes, markdown, labels, or trailing punctuation unless required.",
	"Prefer specific task nouns over generic labels like Help or Question.",
].join(" ");

const SESSION_NAMING_MAX_TOKENS = 32;

function extractAssistantText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ")
		.trim();
}

export function buildSessionNamingPrompt(snapshot: SessionNamingSnapshot): string {
	return [
		"Create a concise title for this conversation.",
		"",
		`First user message: ${snapshot.firstUserMessage}`,
		`First assistant response: ${snapshot.firstAssistantMessage}`,
	].join("\n");
}

export function normalizeGeneratedSessionTitle(value: string | undefined): string | undefined {
	const trimmed = value?.replace(/\s+/g, " ").trim();
	if (!trimmed) {
		return undefined;
	}

	const withoutPrefix = trimmed.replace(/^(title|session title|conversation title)\s*[:\-]\s*/i, "").trim();
	const withoutQuotes = withoutPrefix.replace(/^["'`]+|["'`]+$/g, "").trim();
	const withoutBullet = withoutQuotes.replace(/^[-*]\s+/, "").trim();
	const normalized = withoutBullet.replace(/[.,:;!?]+$/g, "").trim();
	if (!normalized) {
		return undefined;
	}

	const safeTitle = getFallbackSessionTitle(normalized);
	return safeTitle === "(no messages)" ? undefined : safeTitle;
}

export class SessionNamingService {
	constructor(
		private readonly piAgentService: PiAgentService,
		private readonly sessionStore: PiSessionStore,
	) {}

	async generateTitle(userId: string, sessionId: string, snapshot: SessionNamingSnapshot): Promise<string | undefined> {
		const model = this.piAgentService.getConfiguredModel();
		const requestAuth = await this.piAgentService.getConfiguredRequestAuth();
		const completionOptions: {
			apiKey?: string;
			headers?: Record<string, string>;
			maxTokens: number;
			temperature: number;
		} = {
			maxTokens: SESSION_NAMING_MAX_TOKENS,
			temperature: 0,
		};

		if (requestAuth.apiKey !== undefined) {
			completionOptions.apiKey = requestAuth.apiKey;
		}
		if (requestAuth.headers !== undefined) {
			completionOptions.headers = requestAuth.headers;
		}

		const response = await completeSimple(
			model,
			{
				systemPrompt: SESSION_NAMING_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: buildSessionNamingPrompt(snapshot),
						timestamp: Date.now(),
					},
				],
			},
			completionOptions,
		);
		const title = normalizeGeneratedSessionTitle(extractAssistantText(response.content));
		if (!title) {
			return undefined;
		}

		const updated = await this.sessionStore.setSessionTitle(userId, sessionId, title);
		return updated ? title : undefined;
	}
}
