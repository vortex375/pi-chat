import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { build, type Message } from "esbuild";
import type { CanvasCard, CanvasDiagnostic, CanvasPublishResult, PublishCanvasCardRequest } from "@pi-chat/shared";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasRuntimeEventService } from "./canvas-runtime-event-service.js";
import { CanvasStore } from "./canvas-store.js";

const REACT_RUNTIME_IMPORTS = new Map<string, string>([
	["react", "/api/canvas/runtime/react.js"],
	["react/jsx-runtime", "/api/canvas/runtime/react-jsx-runtime.js"],
	["react/jsx-dev-runtime", "/api/canvas/runtime/react-jsx-dev-runtime.js"],
]);

function createCardId(componentPath: string): string {
	const digest = createHash("sha256").update(componentPath).digest("hex").slice(0, 12);
	const slugBase = basename(componentPath, extname(componentPath))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	return `${slugBase || "canvas-card"}-${digest}`;
}

function defaultCardTitle(componentPath: string): string {
	const base = basename(componentPath, extname(componentPath)).replace(/[-_]+/g, " ").trim();
	return base ? base[0]!.toUpperCase() + base.slice(1) : "Canvas card";
}

function isWithinDirectory(candidatePath: string, rootPath: string): boolean {
	return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

export class CanvasBuildService {
	constructor(
		private readonly canvasStore: CanvasStore,
		private readonly canvasEventBus: CanvasEventBus,
		private readonly canvasRuntimeEventService: CanvasRuntimeEventService,
	) {}

	async publishCard(userId: string, request: PublishCanvasCardRequest): Promise<CanvasPublishResult> {
		const normalizedInputPath = request.componentPath.trim();
		const sourcePath = this.canvasStore.resolveCardComponentPath(userId, normalizedInputPath, true);
		const relativeComponentPath = this.canvasStore.toWorkspaceRelativePath(userId, sourcePath);
		const cardId = createCardId(relativeComponentPath);
		const existingCard = await this.canvasStore.getCard(userId, cardId);
		const now = new Date().toISOString();
		const buildDiagnostics = await this.buildBundle(userId, cardId, sourcePath, relativeComponentPath);
		const title = request.title.trim() || existingCard?.title || defaultCardTitle(relativeComponentPath);

		const baseCard: CanvasCard = {
			id: cardId,
			title,
			componentPath: relativeComponentPath,
			status: buildDiagnostics.length === 0 ? "draft" : "build_error",
			createdAt: existingCard?.createdAt ?? now,
			updatedAt: now,
			lastPublishedAt: now,
			...(request.props !== undefined ? { props: request.props } : existingCard?.props !== undefined ? { props: existingCard.props } : {}),
			...(buildDiagnostics.length === 0
				? { bundleUrl: `/api/canvas/cards/${cardId}/bundle.js?updatedAt=${encodeURIComponent(now)}` }
				: {}),
			...(existingCard?.lastMeasuredHeight !== undefined
				? { lastMeasuredHeight: existingCard.lastMeasuredHeight }
				: {}),
			...(existingCard?.lastReadyAt ? { lastReadyAt: existingCard.lastReadyAt } : {}),
		};

		await this.canvasStore.upsertCard(userId, baseCard);
		await this.canvasStore.writeDiagnostics(userId, cardId, buildDiagnostics);

		this.canvasEventBus.publish(userId, {
			type: existingCard ? "canvas.card.updated" : "canvas.card.published",
			card: baseCard,
		});

		if (buildDiagnostics.length > 0) {
			this.canvasEventBus.publish(userId, {
				type: "canvas.card.error",
				cardId,
				diagnostics: buildDiagnostics,
			});
			return {
				card: baseCard,
				diagnostics: buildDiagnostics,
				ready: false,
			};
		}

		const browserSessionId = this.canvasEventBus.getLastBrowserSessionId(userId);
		if (!browserSessionId) {
			const timeoutResult = await this.canvasRuntimeEventService.markPublishTimeout(
				userId,
				cardId,
				"No active browser session is connected to confirm that the canvas card rendered successfully.",
			);
			return {
				card: timeoutResult.card ?? baseCard,
				diagnostics: timeoutResult.diagnostics,
				ready: false,
			};
		}

		const ready = await this.canvasRuntimeEventService.waitForReady(userId, {
			cardId,
			browserSessionId,
			publishedAt: now,
			timeoutMs: 5000,
		});

		if (!ready) {
			const timeoutResult = await this.canvasRuntimeEventService.markPublishTimeout(
				userId,
				cardId,
				"Canvas card publish timed out while waiting for the browser to report a ready signal.",
			);
			return {
				card: timeoutResult.card ?? baseCard,
				diagnostics: timeoutResult.diagnostics,
				ready: false,
			};
		}

		const readyCard = (await this.canvasStore.getCard(userId, cardId)) ?? baseCard;
		const diagnostics = (await this.canvasStore.readDiagnostics(userId, cardId))[cardId] ?? [];
		return {
			card: readyCard,
			diagnostics,
			ready: true,
		};
	}

	private async buildBundle(
		userId: string,
		cardId: string,
		sourcePath: string,
		relativeComponentPath: string,
	): Promise<CanvasDiagnostic[]> {
		const bundlePath = this.canvasStore.getBundlePathForCard(userId, cardId);
		const sourceExists = existsSync(sourcePath);
		if (!sourceExists) {
			rmSync(bundlePath, { force: true });
			return [
				{
					id: `${cardId}-missing-source`,
					stage: "build",
					severity: "error",
					message: `Canvas card source was not found: ${relativeComponentPath}`,
					filePath: relativeComponentPath,
					createdAt: new Date().toISOString(),
				},
			];
		}

		const canvasCardsRoot = resolve(this.canvasStore.ensureInitialized(userId).canvasCardsDir);

		try {
			await build({
				bundle: true,
				entryPoints: [sourcePath],
				format: "esm",
				logLevel: "silent",
				outfile: bundlePath,
				platform: "browser",
				sourcemap: "inline",
				target: ["es2022"],
				write: true,
				plugins: [
					{
						name: "canvas-import-guard",
						setup: (buildApi) => {
							buildApi.onResolve({ filter: /.*/ }, (args) => {
								if (args.kind === "entry-point") {
									return undefined;
								}

								if (REACT_RUNTIME_IMPORTS.has(args.path)) {
									return {
										path: REACT_RUNTIME_IMPORTS.get(args.path)!,
										external: true,
									};
								}

								if (args.path.startsWith(".")) {
									const candidate = resolve(args.resolveDir, args.path);
									if (!isWithinDirectory(candidate, canvasCardsRoot)) {
										return {
											errors: [
												{
													text: `Relative imports must stay within workspace/canvas/cards: ${args.path}`,
												},
											],
										};
									}

									return undefined;
								}

								return {
									errors: [
										{
											text: `Unsupported import "${args.path}". Only react and relative imports are allowed.`,
										},
									],
								};
							});
						},
					},
				],
			});

			return [];
		} catch (error) {
			rmSync(bundlePath, { force: true });
			return this.toDiagnostics(userId, cardId, (error as { errors?: Message[] }).errors ?? [], relativeComponentPath, error);
		}
	}

	private toDiagnostics(
		userId: string,
		cardId: string,
		messages: Message[],
		fallbackFilePath: string,
		error: unknown,
	): CanvasDiagnostic[] {
		if (messages.length === 0) {
			return [
				{
					id: `${cardId}-build-0`,
					stage: "build",
					severity: "error",
					message: error instanceof Error ? error.message : String(error),
					filePath: fallbackFilePath,
					createdAt: new Date().toISOString(),
				},
			];
		}

		return messages.map((message, index) => {
			const filePath = message.location?.file
				? this.toRelativeFilePath(userId, message.location.file)
				: fallbackFilePath;

			return {
				id: `${cardId}-build-${index}`,
				stage: "build",
				severity: "error",
				message: message.text,
				filePath,
				...(message.location?.line ? { line: message.location.line } : {}),
				...(message.location?.column !== undefined ? { column: message.location.column + 1 } : {}),
				createdAt: new Date().toISOString(),
			};
		});
	}

	private toRelativeFilePath(userId: string, absolutePath: string): string {
		try {
			return this.canvasStore.toWorkspaceRelativePath(userId, absolutePath);
		} catch {
			return absolutePath;
		}
	}
}
