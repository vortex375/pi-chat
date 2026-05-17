import { describe, expect, it, vi } from "vitest";
import { CanvasEventBus } from "./canvas-event-bus.js";

describe("CanvasEventBus", () => {
	it("delivers broadcast events to all subscribers for a user", () => {
		const bus = new CanvasEventBus();
		const first = vi.fn();
		const second = vi.fn();

		bus.subscribe("anonymous", "browser-a", first);
		bus.subscribe("anonymous", "browser-b", second);
		bus.publish("anonymous", {
			type: "canvas.snapshot",
			snapshot: {
				cards: [],
				diagnostics: {},
				generatedAt: new Date("2026-05-14T12:00:00.000Z").toISOString(),
			},
		});

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("targets visibility requests to the matching browser session when one is provided", () => {
		const bus = new CanvasEventBus();
		const first = vi.fn();
		const second = vi.fn();

		bus.subscribe("anonymous", "browser-a", first);
		bus.subscribe("anonymous", "browser-b", second);
		bus.requestVisibility("anonymous", "open", "browser-b");

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		expect(second.mock.calls[0]?.[0]).toMatchObject({
			type: "canvas.visibility.requested",
			request: {
				visibility: "open",
				browserSessionId: "browser-b",
			},
		});
	});
});
