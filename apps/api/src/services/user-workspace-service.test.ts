import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionStore } from "./pi-session-store.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

function createServiceFixture() {
	const root = join(tmpdir(), `pi-chat-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanupPaths.push(root);

	const templateDir = join(root, "templates", "workspace");
	const usersRoot = join(root, "data", "users");
	mkdirSync(templateDir, { recursive: true });
	writeFileSync(join(templateDir, "README.md"), "template content", "utf-8");

	const templateProvisioner = new WorkspaceTemplateProvisioner(templateDir);
	const userWorkspaceService = new UserWorkspaceService({
		usersRoot,
		defaultUserId: "anonymous",
		templateProvisioner,
	});

	return {
		root,
		userWorkspaceService,
		sessionStore: new PiSessionStore(userWorkspaceService),
	};
}

describe("UserWorkspaceService", () => {
	it("creates user workspace and copies the template", () => {
		const fixture = createServiceFixture();
		const paths = fixture.userWorkspaceService.ensureUserReady("anonymous");

		expect(existsSync(paths.workspaceDir)).toBe(true);
		expect(existsSync(paths.sessionsDir)).toBe(true);
		expect(readFileSync(join(paths.workspaceDir, "README.md"), "utf-8")).toContain("template content");
	});
});

describe("PiSessionStore", () => {
	it("creates, lists, and renames sessions", async () => {
		const fixture = createServiceFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const listed = await fixture.sessionStore.listSessions("anonymous");
		const renamed = await fixture.sessionStore.renameSession("anonymous", created.id, "My session");

		expect(created.firstMessage).toBe("(no messages)");
		expect(listed).toHaveLength(1);
		expect(renamed?.name).toBe("My session");
		expect(renamed?.displayName).toBe("My session");
	});

	it("clears the explicit title when renamed to an empty value", async () => {
		const fixture = createServiceFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		await fixture.sessionStore.renameSession("anonymous", created.id, "Custom title");
		const cleared = await fixture.sessionStore.renameSession("anonymous", created.id, "   ");

		expect(cleared?.name).toBeUndefined();
		expect(cleared?.displayName).toBe("(no messages)");
	});

	it("maps persisted array-content messages into transcript DTOs", async () => {
		const fixture = createServiceFixture();
		const created = await fixture.sessionStore.createSession("anonymous");
		const sessionPath = await fixture.sessionStore.getSessionPath("anonymous", created.id);
		const paths = fixture.userWorkspaceService.ensureUserReady("anonymous");

		if (!sessionPath) {
			throw new Error("Expected persisted session path");
		}

		const sessionManager = SessionManager.open(sessionPath, paths.sessionsDir, paths.workspaceDir);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Hello from an array payload" }],
		} as never);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Array payload mapped back out" }],
		} as never);

		const detail = await fixture.sessionStore.getSession("anonymous", created.id);

		expect(detail?.messages).toHaveLength(2);
		expect(detail?.messages[0]?.content).toBe("Hello from an array payload");
		expect(detail?.messages[1]?.content).toBe("Array payload mapped back out");
	});
});