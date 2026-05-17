import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentResourceSynchronizer } from "./agent-resource-synchronizer.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

function createFixture() {
	const root = join(tmpdir(), `pi-chat-agent-resource-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanupPaths.push(root);

	const templateDir = join(root, "templates", "agent-resources");
	const targetDir = join(root, "data", "system", "agent-resources");
	mkdirSync(join(templateDir, "skills", "backend-review", "scripts"), { recursive: true });
	writeFileSync(join(templateDir, "append-system-prompt.md"), "Initial prompt instructions", "utf-8");
	writeFileSync(
		join(templateDir, "skills", "backend-review", "SKILL.md"),
		[
			"---",
			"name: backend-review",
			"description: Review backend changes and surface implementation risks.",
			"---",
			"",
			"# Backend Review",
		].join("\n"),
		"utf-8",
	);
	writeFileSync(join(templateDir, "skills", "backend-review", "scripts", "check.sh"), "echo check", "utf-8");

	return { synchronizer: new AgentResourceSynchronizer(templateDir), targetDir, templateDir };
}

describe("AgentResourceSynchronizer", () => {
	it("copies template resources into an empty target directory", () => {
		const fixture = createFixture();

		fixture.synchronizer.syncInto(fixture.targetDir);

		expect(readFileSync(join(fixture.targetDir, "append-system-prompt.md"), "utf-8")).toBe(
			"Initial prompt instructions",
		);
		expect(existsSync(join(fixture.targetDir, "skills", "backend-review", "SKILL.md"))).toBe(true);
		expect(existsSync(join(fixture.targetDir, "skills", "backend-review", "scripts", "check.sh"))).toBe(true);
	});

	it("updates changed files and removes deleted resources on resync", () => {
		const fixture = createFixture();
		fixture.synchronizer.syncInto(fixture.targetDir);

		writeFileSync(join(fixture.templateDir, "append-system-prompt.md"), "Updated prompt instructions", "utf-8");
		const obsoleteSkillDir = join(fixture.templateDir, "skills", "backend-review");
		const replacementSkillDir = join(fixture.templateDir, "skills", "incident-response");
		mkdirSync(replacementSkillDir, { recursive: true });
		writeFileSync(
			join(replacementSkillDir, "SKILL.md"),
			[
				"---",
				"name: incident-response",
				"description: Coordinate backend incident response workflows.",
				"---",
				"",
				"# Incident Response",
			].join("\n"),
			"utf-8",
		);
		const { rmSync } = require("node:fs");
		rmSync(obsoleteSkillDir, { recursive: true, force: true });

		fixture.synchronizer.syncInto(fixture.targetDir);

		expect(readFileSync(join(fixture.targetDir, "append-system-prompt.md"), "utf-8")).toBe(
			"Updated prompt instructions",
		);
		expect(existsSync(join(fixture.targetDir, "skills", "backend-review"))).toBe(false);
		expect(existsSync(join(fixture.targetDir, "skills", "incident-response", "SKILL.md"))).toBe(true);
	});
});