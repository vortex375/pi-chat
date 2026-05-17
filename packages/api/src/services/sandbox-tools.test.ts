import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGuardedReadTool,
	createGuardedWriteTool,
	createSandboxedBashOperations,
	resolveWorkspacePath,
} from "./sandbox-tools.js";

const cleanupPaths: string[] = [];
const hasBubblewrap = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(async () => {
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-chat-sandbox-test-"));
	cleanupPaths.push(root);

	const workspaceDir = join(root, "workspace");
	const outsideDir = join(root, "outside");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });
	writeFileSync(join(workspaceDir, "inside.txt"), "inside", "utf-8");
	writeFileSync(join(outsideDir, "secret.txt"), "secret", "utf-8");

	return {
		outsideDir,
		outsideFile: join(outsideDir, "secret.txt"),
		workspaceDir,
	};
}

describe("sandbox tools", () => {
	it("rejects paths outside the workspace after symlink resolution", () => {
		const fixture = createFixture();
		symlinkSync(fixture.outsideFile, join(fixture.workspaceDir, "secret-link.txt"));

		expect(() => resolveWorkspacePath("secret-link.txt", fixture.workspaceDir)).toThrow(
			"Access denied outside the workspace",
		);
	});

	it("blocks read access outside the workspace", async () => {
		const fixture = createFixture();
		const tool = createGuardedReadTool(fixture.workspaceDir);

		await expect(tool.execute("call-1", { path: fixture.outsideFile })).rejects.toThrow(
			"Access denied outside the workspace",
		);
	});

	it("blocks write access outside the workspace", async () => {
		const fixture = createFixture();
		const tool = createGuardedWriteTool(fixture.workspaceDir);

		await expect(tool.execute("call-2", { path: join(fixture.outsideDir, "new.txt"), content: "x" })).rejects.toThrow(
			"Access denied outside the workspace",
		);
	});

	it.skipIf(!hasBubblewrap)("runs bash inside the bubblewrap sandbox", async () => {
		const fixture = createFixture();
		const operations = createSandboxedBashOperations(fixture.workspaceDir);
		const output: string[] = [];

		const pwdResult = await operations.exec("pwd", fixture.workspaceDir, {
			onData: (chunk) => output.push(chunk.toString()),
		});

		expect(pwdResult.exitCode).toBe(0);
		expect(output.join("")).toContain(fixture.workspaceDir);

		const homeResult = await operations.exec("test -d /home", fixture.workspaceDir, {
			onData: () => {},
		});

		expect(homeResult.exitCode).toBe(1);

		const passwdResult = await operations.exec("test -r /etc/passwd", fixture.workspaceDir, {
			onData: () => {},
		});

		expect(passwdResult.exitCode).toBe(1);
	});
});