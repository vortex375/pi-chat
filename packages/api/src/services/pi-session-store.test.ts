import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionStore } from "./pi-session-store.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

const cleanupPaths: string[] = [];

function createFixture() {
	const root = join(tmpdir(), `pi-chat-session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanupPaths.push(root);

	const templateDir = join(root, "templates", "workspace");
	const usersRoot = join(root, "data", "users");
	mkdirSync(templateDir, { recursive: true });
	writeFileSync(join(templateDir, "README.md"), "template", "utf-8");

	const templateProvisioner = new WorkspaceTemplateProvisioner(templateDir);
	const userWorkspaceService = new UserWorkspaceService({
		usersRoot,
		defaultUserId: "anonymous",
		templateProvisioner,
	});
	const sessionStore = new PiSessionStore(userWorkspaceService);

	return { sessionStore, userWorkspaceService };
}

async function appendConversation(
	userWorkspaceService: UserWorkspaceService,
	sessionStore: PiSessionStore,
	sessionId: string,
	messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
	const sessionPath = await sessionStore.getSessionPath("anonymous", sessionId);
	if (!sessionPath) {
		throw new Error("Missing session path");
	}

	const paths = userWorkspaceService.ensureUserReady("anonymous");
	const sessionManager = SessionManager.open(sessionPath, paths.sessionsDir, paths.workspaceDir);
	for (const message of messages) {
		sessionManager.appendMessage(
			(message.role === "user"
				? { role: "user", content: message.content }
				: { role: "assistant", content: [{ type: "text", text: message.content }] }) as never,
		);
	}
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

describe("PiSessionStore", () => {
	it("returns the first completed exchange snapshot only for the first turn", async () => {
		const fixture = createFixture();
		const created = await fixture.sessionStore.createSession("anonymous");

		await appendConversation(fixture.userWorkspaceService, fixture.sessionStore, created.id, [
			{ role: "user", content: "Inspect the queue" },
			{ role: "assistant", content: "It serializes requests." },
		]);

		const snapshot = await fixture.sessionStore.getSessionNamingSnapshot("anonymous", created.id);

		expect(snapshot).toEqual({
			firstUserMessage: "Inspect the queue",
			firstAssistantMessage: "It serializes requests.",
		});
	});

	it("stops returning a naming snapshot after later turns exist", async () => {
		const fixture = createFixture();
		const created = await fixture.sessionStore.createSession("anonymous");

		await appendConversation(fixture.userWorkspaceService, fixture.sessionStore, created.id, [
			{ role: "user", content: "Inspect the queue" },
			{ role: "assistant", content: "It serializes requests." },
			{ role: "user", content: "What about follow-up work?" },
			{ role: "assistant", content: "That stays queued behind the current session." },
		]);

		const snapshot = await fixture.sessionStore.getSessionNamingSnapshot("anonymous", created.id);

		expect(snapshot).toBeUndefined();
	});

	it("keeps rename writes working after a generated title is stored", async () => {
		const fixture = createFixture();
		const created = await fixture.sessionStore.createSession("anonymous");

		expect(await fixture.sessionStore.setSessionTitle("anonymous", created.id, "Generated title")).toBe(true);
		const renamed = await fixture.sessionStore.renameSession("anonymous", created.id, "Manual title");

		expect(renamed?.name).toBe("Manual title");
		expect(renamed?.displayName).toBe("Manual title");
	});
});
