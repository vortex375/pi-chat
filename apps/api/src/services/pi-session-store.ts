import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	SessionManager,
	type SessionInfo,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ChatMessage, SessionDetail, SessionSummary } from "@pi-chat/shared";
import type { UserWorkspaceService } from "./user-workspace-service.js";

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

function toSessionSummary(info: SessionInfo): SessionSummary {
	const name = info.name?.trim() || undefined;
	const summary: SessionSummary = {
		id: info.id,
		displayName: name ?? info.firstMessage,
		hasCustomName: name !== undefined,
		firstMessage: info.firstMessage,
		modifiedAt: info.modified.toISOString(),
	};

	if (name !== undefined) {
		summary.name = name;
	}

	return summary;
}

function toChatMessage(entry: SessionMessageEntry): ChatMessage | undefined {
	const role = entry.message.role;
	if (role !== "user" && role !== "assistant") {
		return undefined;
	}

	const content = extractTextContent(entry.message.content);
	if (!content) {
		return undefined;
	}

	return {
		id: entry.id,
		role,
		content,
		createdAt: entry.timestamp,
		status: "complete",
	};
}

export class PiSessionStore {
	constructor(private readonly userWorkspaceService: UserWorkspaceService) {}

	async listSessions(userId: string): Promise<SessionSummary[]> {
		const paths = this.userWorkspaceService.ensureUserReady(userId);
		const sessions = await SessionManager.list(paths.workspaceDir, paths.sessionsDir);
		return sessions.map(toSessionSummary);
	}

	async createSession(userId: string): Promise<SessionDetail> {
		const paths = this.userWorkspaceService.ensureUserReady(userId);
		const sessionManager = SessionManager.create(paths.workspaceDir, paths.sessionsDir);
		this.persistSessionSnapshot(sessionManager);
		return this.toSessionDetail(sessionManager);
	}

	async getSession(userId: string, sessionId: string): Promise<SessionDetail | undefined> {
		const sessionManager = await this.openSession(userId, sessionId);
		if (!sessionManager) {
			return undefined;
		}

		return this.toSessionDetail(sessionManager);
	}

	async renameSession(userId: string, sessionId: string, name: string | undefined): Promise<SessionDetail | undefined> {
		const sessionManager = await this.openSession(userId, sessionId);
		if (!sessionManager) {
			return undefined;
		}

		sessionManager.appendSessionInfo(name?.trim() ?? "");
		this.persistSessionSnapshot(sessionManager);
		return this.toSessionDetail(sessionManager);
	}

	async getSessionPath(userId: string, sessionId: string): Promise<string | undefined> {
		const paths = this.userWorkspaceService.ensureUserReady(userId);
		const sessions = await SessionManager.list(paths.workspaceDir, paths.sessionsDir);
		return sessions.find((session) => session.id === sessionId)?.path;
	}

	private async openSession(userId: string, sessionId: string): Promise<SessionManager | undefined> {
		const paths = this.userWorkspaceService.ensureUserReady(userId);
		const sessions = await SessionManager.list(paths.workspaceDir, paths.sessionsDir);
		const match = sessions.find((session) => session.id === sessionId);

		if (!match) {
			return undefined;
		}

		return SessionManager.open(match.path, paths.sessionsDir, paths.workspaceDir);
	}

	private persistSessionSnapshot(sessionManager: SessionManager): void {
		const sessionFile = sessionManager.getSessionFile();
		const header = sessionManager.getHeader();

		if (!sessionFile || !header) {
			return;
		}

		mkdirSync(dirname(sessionFile), { recursive: true });
		const lines = [JSON.stringify(header), ...sessionManager.getEntries().map((entry) => JSON.stringify(entry))];
		writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
	}

	private toSessionDetail(sessionManager: SessionManager): SessionDetail {
		const branch = sessionManager.getBranch();
		const messages = branch
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map(toChatMessage)
			.filter((message): message is ChatMessage => message !== undefined);

		const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? "(no messages)";
		const name = sessionManager.getSessionName();
		const header = sessionManager.getHeader();
		const createdAt = header?.timestamp ?? new Date().toISOString();
		const lastMessageTime = messages[messages.length - 1]?.createdAt ?? createdAt;

		const detail: SessionDetail = {
			id: sessionManager.getSessionId(),
			displayName: name ?? firstUserMessage,
			hasCustomName: name !== undefined,
			firstMessage: firstUserMessage,
			createdAt,
			modifiedAt: lastMessageTime,
			messages,
		};

		if (name !== undefined) {
			detail.name = name;
		}

		return detail;
	}
}
