import { spawnSync } from "node:child_process";

export function validateSandboxPrerequisites(sandboxRequired: boolean): void {
	if (!sandboxRequired) {
		return;
	}

	if (process.platform !== "linux") {
		throw new Error(`Sandboxing requires Linux with bubblewrap support. Current platform: ${process.platform}`);
	}

	const result = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
	if (result.error || result.status !== 0) {
		throw new Error("Sandboxing is required, but bubblewrap (bwrap) is not available on PATH.");
	}
}
