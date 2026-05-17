import type { CanvasCard, CanvasDiagnostic, CanvasRuntimeEventRequest } from "@pi-chat/shared";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasStore } from "./canvas-store.js";

interface RuntimeEventResult {
	acknowledged: boolean;
	card?: CanvasCard;
	diagnostics: CanvasDiagnostic[];
}

export class CanvasRuntimeEventService {
	constructor(
		private readonly canvasStore: CanvasStore,
		private readonly canvasEventBus: CanvasEventBus,
	) {}

	async handleEvent(userId: string, cardId: string, request: CanvasRuntimeEventRequest): Promise<RuntimeEventResult> {
		if (request.type === "ready") {
			return this.recordReady(userId, cardId, request.browserSessionId);
		}

		if (request.type === "runtime_error") {
			return this.recordRuntimeError(
				userId,
				cardId,
				request.message?.trim() || "Canvas card runtime failure",
				request.stack,
			);
		}

		if (request.type === "resize") {
			return this.recordResize(userId, cardId, request.height);
		}

		return {
			acknowledged: true,
			diagnostics: (await this.canvasStore.readDiagnostics(userId, cardId))[cardId] ?? [],
		};
	}

	async waitForReady(
		userId: string,
		options: {
			cardId: string;
			browserSessionId: string;
			publishedAt: string;
			timeoutMs: number;
		},
	): Promise<boolean> {
		return this.canvasEventBus.waitForCardReady(userId, {
			after: options.publishedAt,
			browserSessionId: options.browserSessionId,
			cardId: options.cardId,
			timeoutMs: options.timeoutMs,
		});
	}

	async markPublishTimeout(userId: string, cardId: string, message: string): Promise<RuntimeEventResult> {
		return this.recordRuntimeError(userId, cardId, message);
	}

	private async recordReady(
		userId: string,
		cardId: string,
		browserSessionId: string | undefined,
	): Promise<RuntimeEventResult> {
		const existingCard = await this.canvasStore.getCard(userId, cardId);
		if (!existingCard) {
			return { acknowledged: false, diagnostics: [] };
		}

		const now = new Date().toISOString();
		const currentDiagnostics = (await this.canvasStore.readDiagnostics(userId, cardId))[cardId] ?? [];
		const nextDiagnostics = currentDiagnostics.filter((diagnostic) => diagnostic.stage !== "runtime");
		await this.canvasStore.writeDiagnostics(userId, cardId, nextDiagnostics);

		const nextCard: CanvasCard = {
			...existingCard,
			status: "ready",
			updatedAt: now,
			lastReadyAt: now,
		};

		await this.canvasStore.upsertCard(userId, nextCard);
		this.canvasEventBus.notifyCardReady(userId, cardId, browserSessionId, now);
		this.canvasEventBus.publish(userId, {
			type: "canvas.card.updated",
			card: nextCard,
		});

		return {
			acknowledged: true,
			card: nextCard,
			diagnostics: nextDiagnostics,
		};
	}

	private async recordRuntimeError(
		userId: string,
		cardId: string,
		message: string,
		stack?: string,
	): Promise<RuntimeEventResult> {
		const existingCard = await this.canvasStore.getCard(userId, cardId);
		if (!existingCard) {
			return { acknowledged: false, diagnostics: [] };
		}

		const now = new Date().toISOString();
		const currentDiagnostics = (await this.canvasStore.readDiagnostics(userId, cardId))[cardId] ?? [];
		const nextDiagnostic: CanvasDiagnostic = {
			id: `${cardId}-runtime-${currentDiagnostics.filter((diagnostic) => diagnostic.stage === "runtime").length}`,
			stage: "runtime",
			severity: "error",
			message,
			...(stack ? { stack } : {}),
			createdAt: now,
		};
		const nextDiagnostics = [
			...currentDiagnostics.filter((diagnostic) => diagnostic.stage !== "runtime"),
			nextDiagnostic,
		];
		await this.canvasStore.writeDiagnostics(userId, cardId, nextDiagnostics);

		const nextCard: CanvasCard = {
			...existingCard,
			status: "runtime_error",
			updatedAt: now,
		};

		await this.canvasStore.upsertCard(userId, nextCard);
		this.canvasEventBus.publish(userId, {
			type: "canvas.card.updated",
			card: nextCard,
		});
		this.canvasEventBus.publish(userId, {
			type: "canvas.card.error",
			cardId,
			diagnostics: nextDiagnostics,
		});

		return {
			acknowledged: true,
			card: nextCard,
			diagnostics: nextDiagnostics,
		};
	}

	private async recordResize(
		userId: string,
		cardId: string,
		height: number | undefined,
	): Promise<RuntimeEventResult> {
		const existingCard = await this.canvasStore.getCard(userId, cardId);
		if (!existingCard) {
			return { acknowledged: false, diagnostics: [] };
		}

		if (height === undefined) {
			return {
				acknowledged: true,
				card: existingCard,
				diagnostics: (await this.canvasStore.readDiagnostics(userId, cardId))[cardId] ?? [],
			};
		}

		const nextCard: CanvasCard = {
			...existingCard,
			lastMeasuredHeight: height,
			updatedAt: new Date().toISOString(),
		};
		await this.canvasStore.upsertCard(userId, nextCard);
		this.canvasEventBus.publish(userId, {
			type: "canvas.card.updated",
			card: nextCard,
		});

		return {
			acknowledged: true,
			card: nextCard,
			diagnostics: (await this.canvasStore.readDiagnostics(userId, cardId))[cardId] ?? [],
		};
	}
}
