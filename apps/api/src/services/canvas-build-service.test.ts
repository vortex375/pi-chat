import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasBuildService } from "./canvas-build-service.js";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasRuntimeEventService } from "./canvas-runtime-event-service.js";
import { CanvasStore } from "./canvas-store.js";
import { UserWorkspaceService } from "./user-workspace-service.js";
import { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

const cleanupPaths: string[] = [];

function createFixture() {
	const root = join(tmpdir(), `pi-chat-canvas-build-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	const canvasRuntimeEventService = new CanvasRuntimeEventService(canvasStore, canvasEventBus);

	return {
		canvasBuildService: new CanvasBuildService(canvasStore, canvasEventBus, canvasRuntimeEventService),
		canvasEventBus,
		canvasRuntimeEventService,
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

describe("CanvasBuildService", () => {
	it("publishes a valid canvas card and writes a browser bundle", async () => {
		const fixture = createFixture();
		const publishSpy = vi.fn((event: unknown) => {
			if (
				typeof event === "object" &&
				event !== null &&
				"type" in event &&
				(event.type === "canvas.card.published" || event.type === "canvas.card.updated") &&
				"card" in event &&
				typeof event.card === "object" &&
				event.card !== null &&
				"id" in event.card &&
				"status" in event.card &&
				event.card.status === "draft"
			) {
				void fixture.canvasRuntimeEventService.handleEvent("anonymous", String(event.card.id), {
					type: "ready",
					browserSessionId: "browser-a",
				});
			}
		});
		fixture.canvasEventBus.subscribe("anonymous", "browser-a", publishSpy);
		const paths = fixture.canvasStore.ensureInitialized("anonymous");
		writeFileSync(
			join(paths.canvasCardsDir, "hello-card.tsx"),
			[
				"import { useMemo } from 'react';",
				"",
				"export default function HelloCard(props: any) {",
				"  const label = useMemo(() => props.data?.label ?? 'Hello card', [props.data]);",
				"  return <div>{label}</div>;",
				"}",
			].join("\n"),
			"utf-8",
		);

		const result = await fixture.canvasBuildService.publishCard("anonymous", {
			componentPath: "canvas/cards/hello-card.tsx",
			title: "Hello card",
			props: { label: "Published" },
		});
		const bundlePath = fixture.canvasStore.getBundlePathForCard("anonymous", result.card.id);

		expect(result.ready).toBe(true);
		expect(result.card.status).toBe("ready");
		expect(result.diagnostics).toEqual([]);
		expect(existsSync(bundlePath)).toBe(true);
		expect(readFileSync(bundlePath, "utf-8")).toContain("/api/canvas/runtime/react");
		expect(publishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "canvas.card.published",
				card: expect.objectContaining({ id: result.card.id }),
			}),
		);
	});

	it("returns build diagnostics for unsupported imports", async () => {
		const fixture = createFixture();
		const paths = fixture.canvasStore.ensureInitialized("anonymous");
		writeFileSync(
			join(paths.canvasCardsDir, "broken-card.tsx"),
			[
				"import clsx from 'clsx';",
				"",
				"export default function BrokenCard() {",
				"  return <div>{clsx('broken')}</div>;",
				"}",
			].join("\n"),
			"utf-8",
		);

		const result = await fixture.canvasBuildService.publishCard("anonymous", {
			componentPath: "canvas/cards/broken-card.tsx",
			title: "Broken card",
		});

		expect(result.ready).toBe(false);
		expect(result.card.status).toBe("build_error");
		expect(result.diagnostics[0]?.message).toContain('Unsupported import "clsx"');
	});
});
