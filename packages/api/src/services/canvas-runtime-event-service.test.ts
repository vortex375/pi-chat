import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasRuntimeEventService } from "./canvas-runtime-event-service.js";
import { CanvasStore } from "./canvas-store.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

const cleanupPaths: string[] = [];

function createFixture() {
	const root = join(tmpdir(), `pi-chat-canvas-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	const canvasStore = new CanvasStore(userWorkspaceService);
	const canvasEventBus = new CanvasEventBus();

	return {
		canvasEventBus,
		canvasRuntimeEventService: new CanvasRuntimeEventService(canvasStore, canvasEventBus),
		canvasStore,
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

describe("CanvasRuntimeEventService", () => {
	it("records ready events and resolves publish waiters", async () => {
		const fixture = createFixture();
		const now = new Date("2026-05-14T12:00:00.000Z").toISOString();
		await fixture.canvasStore.upsertCard("anonymous", {
			id: "card-1",
			title: "Ready card",
			componentPath: "canvas/cards/ready-card.tsx",
			status: "draft",
			createdAt: now,
			updatedAt: now,
			lastPublishedAt: now,
			bundleUrl: "/api/canvas/cards/card-1/bundle.js",
		});

		const waitForReady = fixture.canvasRuntimeEventService.waitForReady("anonymous", {
			cardId: "card-1",
			browserSessionId: "browser-a",
			publishedAt: now,
			timeoutMs: 5000,
		});
		const eventResult = await fixture.canvasRuntimeEventService.handleEvent("anonymous", "card-1", {
			type: "ready",
			browserSessionId: "browser-a",
		});
		const resolved = await waitForReady;
		const storedCard = await fixture.canvasStore.getCard("anonymous", "card-1");

		expect(resolved).toBe(true);
		expect(eventResult.acknowledged).toBe(true);
		expect(storedCard?.status).toBe("ready");
		expect(storedCard?.lastReadyAt).toBeDefined();
	});

	it("does not republish already ready cards when a browser reloads them", async () => {
		const fixture = createFixture();
		const now = new Date("2026-05-14T12:00:00.000Z").toISOString();
		await fixture.canvasStore.upsertCard("anonymous", {
			id: "card-ready",
			title: "Ready card",
			componentPath: "canvas/cards/ready-card.tsx",
			status: "ready",
			createdAt: now,
			updatedAt: now,
			lastPublishedAt: now,
			lastReadyAt: now,
			bundleUrl: "/api/canvas/cards/card-ready/bundle.js",
		});

		const publishSpy = vi.spyOn(fixture.canvasEventBus, "publish");
		const result = await fixture.canvasRuntimeEventService.handleEvent("anonymous", "card-ready", {
			type: "ready",
			browserSessionId: "browser-a",
		});
		const storedCard = await fixture.canvasStore.getCard("anonymous", "card-ready");

		expect(result.acknowledged).toBe(true);
		expect(result.card).toEqual(storedCard);
		expect(storedCard?.lastReadyAt).toBe(now);
		expect(publishSpy).not.toHaveBeenCalled();
	});

	it("persists runtime diagnostics and updates card status", async () => {
		const fixture = createFixture();
		const now = new Date("2026-05-14T12:00:00.000Z").toISOString();
		await fixture.canvasStore.upsertCard("anonymous", {
			id: "card-2",
			title: "Broken card",
			componentPath: "canvas/cards/broken-card.tsx",
			status: "ready",
			createdAt: now,
			updatedAt: now,
			lastPublishedAt: now,
			lastReadyAt: now,
			bundleUrl: "/api/canvas/cards/card-2/bundle.js",
		});

		const result = await fixture.canvasRuntimeEventService.handleEvent("anonymous", "card-2", {
			type: "runtime_error",
			message: "Boom",
			stack: "stack trace",
			browserSessionId: "browser-a",
		});
		const diagnostics = await fixture.canvasStore.readDiagnostics("anonymous", "card-2");
		const storedCard = await fixture.canvasStore.getCard("anonymous", "card-2");

		expect(result.acknowledged).toBe(true);
		expect(storedCard?.status).toBe("runtime_error");
		expect(diagnostics["card-2"]?.[0]?.message).toBe("Boom");
		expect(diagnostics["card-2"]?.[0]?.stack).toBe("stack trace");
	});

	it("persists resize events onto the canvas card metadata", async () => {
		const fixture = createFixture();
		const now = new Date("2026-05-14T12:00:00.000Z").toISOString();
		await fixture.canvasStore.upsertCard("anonymous", {
			id: "card-3",
			title: "Resizable card",
			componentPath: "canvas/cards/resizable-card.tsx",
			status: "ready",
			createdAt: now,
			updatedAt: now,
			lastPublishedAt: now,
			lastReadyAt: now,
			bundleUrl: "/api/canvas/cards/card-3/bundle.js",
		});

		const result = await fixture.canvasRuntimeEventService.handleEvent("anonymous", "card-3", {
			type: "resize",
			height: 320,
			browserSessionId: "browser-a",
		});
		const storedCard = await fixture.canvasStore.getCard("anonymous", "card-3");

		expect(result.acknowledged).toBe(true);
		expect(storedCard?.lastMeasuredHeight).toBe(320);
	});
});
