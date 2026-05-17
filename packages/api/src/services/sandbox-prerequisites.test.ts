import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSandboxPrerequisites } from "./sandbox-prerequisites.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	spawnSyncMock.mockReset();
	setPlatform(originalPlatform);
});

describe("validateSandboxPrerequisites", () => {
	it("does nothing when sandboxing is disabled", () => {
		expect(() => validateSandboxPrerequisites(false)).not.toThrow();
	});

	it("fails when the platform is not linux", () => {
		setPlatform("darwin");

		expect(() => validateSandboxPrerequisites(true)).toThrow(/Sandboxing requires Linux/);
	});

	it("fails when bubblewrap is unavailable", () => {
		setPlatform("linux");
		spawnSyncMock.mockReturnValue({ error: new Error("not found"), status: 1 });

		expect(() => validateSandboxPrerequisites(true)).toThrow(/bubblewrap/);
	});

	it("passes when bubblewrap is available", () => {
		setPlatform("linux");
		spawnSyncMock.mockReturnValue({ error: undefined, status: 0 });

		expect(() => validateSandboxPrerequisites(true)).not.toThrow();
	});
});