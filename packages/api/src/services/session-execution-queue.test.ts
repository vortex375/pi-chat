import { describe, expect, it } from "vitest";
import { SessionExecutionQueue } from "./session-execution-queue.js";

describe("SessionExecutionQueue", () => {
	it("serializes work for the same session", async () => {
		const queue = new SessionExecutionQueue();
		const steps: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = queue.run("session-1", async () => {
			steps.push("first:start");
			await firstGate;
			steps.push("first:end");
		});

		const second = queue.run("session-1", async () => {
			steps.push("second:start");
			steps.push("second:end");
		});

		await Promise.resolve();
		expect(steps).toEqual(["first:start"]);

		releaseFirst();
		await Promise.all([first, second]);

		expect(steps).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different sessions to run in parallel", async () => {
		const queue = new SessionExecutionQueue();
		const steps: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = queue.run("session-a", async () => {
			steps.push("a:start");
			await firstGate;
			steps.push("a:end");
		});

		const second = queue.run("session-b", async () => {
			steps.push("b:start");
			steps.push("b:end");
		});

		await Promise.resolve();
		expect(steps).toEqual(["a:start", "b:start", "b:end"]);

		releaseFirst();
		await Promise.all([first, second]);
		expect(steps).toEqual(["a:start", "b:start", "b:end", "a:end"]);
	});

	it("continues queued work after a failure on the same session", async () => {
		const queue = new SessionExecutionQueue();
		const steps: string[] = [];

		const first = queue.run("session-1", async () => {
			steps.push("first:start");
			throw new Error("boom");
		});

		const second = queue.run("session-1", async () => {
			steps.push("second:start");
			steps.push("second:end");
		});

		await expect(first).rejects.toThrow("boom");
		await second;

		expect(steps).toEqual(["first:start", "second:start", "second:end"]);
	});
});