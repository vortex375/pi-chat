import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PublishCanvasCardRequest } from "@pi-chat/shared";
import { CanvasBuildService } from "./canvas-build-service.js";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasStore } from "./canvas-store.js";

const VisibilityParamsSchema = Type.Object({
	visibility: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
});

const PublishParamsSchema = Type.Object({
	componentPath: Type.String(),
	title: Type.String(),
	props: Type.Optional(Type.Unknown()),
});

const RemoveParamsSchema = Type.Object({
	cardId: Type.String(),
});

const DiagnosticsParamsSchema = Type.Object({
	cardId: Type.Optional(Type.String()),
});

function diagnosticsText(message: string, diagnostics: { message: string; filePath?: string }[]): string {
	if (diagnostics.length === 0) {
		return message;
	}

	return `${message}\n${diagnostics.map((diagnostic) => `- ${diagnostic.filePath ? `${diagnostic.filePath}: ` : ""}${diagnostic.message}`).join("\n")}`;
}

export function createCanvasToolsExtension(options: {
	userId: string;
	canvasBuildService: CanvasBuildService;
	canvasEventBus: CanvasEventBus;
	canvasStore: CanvasStore;
}): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "canvas_set_visibility",
			label: "Canvas Visibility",
			description: "Open or close the workspace canvas in the active browser session.",
			parameters: VisibilityParamsSchema,
			async execute(_toolCallId, params) {
				const event = options.canvasEventBus.requestVisibility(options.userId, params.visibility);
				return {
					content: [
						{
							type: "text",
							text: `Requested canvas visibility: ${params.visibility}`,
						},
					],
					details: event,
				};
			},
		});

		pi.registerTool({
			name: "canvas_publish_card",
			label: "Publish Canvas Card",
			description: "Build and publish a React component from workspace/canvas/cards onto the workspace canvas.",
			parameters: PublishParamsSchema,
			async execute(_toolCallId, params) {
				const result = await options.canvasBuildService.publishCard(options.userId, params as PublishCanvasCardRequest);
				return {
					content: [
						{
							type: "text",
							text: diagnosticsText(
								result.ready
									? `Published canvas card "${result.card.title}" (${result.card.id}).`
									: `Published canvas card "${result.card.title}" with build diagnostics.`,
								result.diagnostics,
							),
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "canvas_remove_card",
			label: "Remove Canvas Card",
			description: "Remove a published card from the workspace canvas.",
			parameters: RemoveParamsSchema,
			async execute(_toolCallId, params) {
				const removed = await options.canvasStore.removeCard(options.userId, params.cardId);
				if (removed) {
					options.canvasEventBus.publish(options.userId, {
						type: "canvas.card.removed",
						cardId: params.cardId,
					});
				}

				return {
					content: [
						{
							type: "text",
							text: removed ? `Removed canvas card ${params.cardId}.` : `Canvas card ${params.cardId} was not found.`,
						},
					],
					details: { cardId: params.cardId, removed },
				};
			},
		});

		pi.registerTool({
			name: "canvas_list_cards",
			label: "List Canvas Cards",
			description: "List the current workspace canvas cards and their statuses.",
			parameters: Type.Object({}),
			async execute() {
				const cards = await options.canvasStore.listCards(options.userId);
				return {
					content: [
						{
							type: "text",
							text: cards.length === 0 ? "No canvas cards are published." : cards.map((card) => `${card.id} | ${card.status} | ${card.componentPath}`).join("\n"),
						},
					],
					details: { cards },
				};
			},
		});

		pi.registerTool({
			name: "canvas_get_diagnostics",
			label: "Canvas Diagnostics",
			description: "Read stored build or runtime diagnostics for one canvas card or the full canvas.",
			parameters: DiagnosticsParamsSchema,
			async execute(_toolCallId, params) {
				const diagnostics = await options.canvasStore.readDiagnostics(options.userId, params.cardId);
				return {
					content: [
						{
							type: "text",
							text:
								Object.keys(diagnostics).length === 0
									? "No stored canvas diagnostics."
									: JSON.stringify(diagnostics, null, 2),
						},
					],
					details: { diagnostics },
				};
			},
		});
	};
}
