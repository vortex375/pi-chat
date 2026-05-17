import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasStore } from "./canvas-store.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

const cleanupPaths: string[] = [];

function createFixture() {
	const root = join(tmpdir(), `pi-chat-canvas-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanupPaths.push(root);

	const templateDir = join(root, "templates", "workspace");
	const usersRoot = join(root, "data", "users");
	mkdirSync(templateDir, { recursive: true });
	writeFileSync(join(templateDir, "README.md"), "template content", "utf-8");

	const userWorkspaceService = new UserWorkspaceService({
		usersRoot,
		defaultUserId: "anonymous",
		templateProvisioner: new WorkspaceTemplateProvisioner(templateDir),
	});

	return {
		root,
		canvasStore: new CanvasStore(userWorkspaceService),
		userWorkspaceService,
	};
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

describe("CanvasStore", () => {
	it("creates the canvas directories and empty manifest on first access", () => {
		const fixture = createFixture();
		const paths = fixture.canvasStore.ensureInitialized("anonymous");

		expect(existsSync(paths.canvasCardsDir)).toBe(true);
		expect(existsSync(paths.diagnosticsDir)).toBe(true);
		expect(existsSync(paths.manifestPath)).toBe(true);
	});

	it("writes and reads diagnostics by card id", async () => {
		const fixture = createFixture();

		await fixture.canvasStore.writeDiagnostics("anonymous", "weather-card", [
			{
				id: "diag-1",
				stage: "build",
				severity: "error",
				message: "Unexpected token",
				createdAt: new Date("2026-05-14T12:00:00.000Z").toISOString(),
			},
		]);

		const diagnostics = await fixture.canvasStore.readDiagnostics("anonymous", "weather-card");
		expect(diagnostics["weather-card"]).toHaveLength(1);
		expect(diagnostics["weather-card"]?.[0]?.message).toBe("Unexpected token");
	});

	it("restricts component paths to workspace/canvas/cards", () => {
		const fixture = createFixture();
		const userPaths = fixture.userWorkspaceService.ensureUserReady("anonymous");
		writeFileSync(join(userPaths.workspaceDir, "outside.tsx"), "export default function Outside() { return null; }", "utf-8");

		expect(() =>
			fixture.canvasStore.resolveCardComponentPath("anonymous", "outside.tsx"),
		).toThrow(/Canvas card path must stay within canvas\/cards/);
	});
});
