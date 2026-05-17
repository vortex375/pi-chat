import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

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

describe("loadEnv", () => {
	it("loads required configuration", () => {
		const root = join(tmpdir(), `pi-chat-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);
		const templateDir = join(root, "templates", "workspace");
		mkdirSync(templateDir, { recursive: true });

		const config = loadEnv({
			PORT: "4321",
			PI_CHAT_DATA_ROOT: join(root, "data"),
			PI_CHAT_TEMPLATE_ROOT: templateDir,
			PI_PROVIDER: "openrouter",
			PI_MODEL_ID: "openai/gpt-oss-120b",
			PI_SANDBOX_REQUIRED: "false",
		});

		expect(config.port).toBe(4321);
		expect(config.workspaceTemplateDir).toBe(templateDir);
		expect(config.agentResourceTemplateDir).toBe(join(config.projectRoot, "templates", "agent-resources"));
		expect(config.agentResourceDir).toBe(join(root, "data", "system", "agent-resources"));
		expect(config.sandboxRequired).toBe(false);
	});

	it("loads configuration from a dotenv file", () => {
		const root = join(tmpdir(), `pi-chat-env-dotenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);
		const templateDir = join(root, "templates", "workspace");
		const envFilePath = join(root, ".env");
		mkdirSync(templateDir, { recursive: true });
		writeFileSync(
			envFilePath,
			[
				"PORT=4545",
				`PI_CHAT_DATA_ROOT=${join(root, "data")}`,
				`PI_CHAT_TEMPLATE_ROOT=${templateDir}`,
				"PI_PROVIDER=openrouter",
				"PI_MODEL_ID=openai/gpt-oss-120b",
				"PI_SANDBOX_REQUIRED=false",
			].join("\n"),
		);

		const config = loadEnv({}, { envFilePath });

		expect(config.port).toBe(4545);
		expect(config.workspaceTemplateDir).toBe(templateDir);
		expect(config.agentResourceTemplateDir).toBe(join(config.projectRoot, "templates", "agent-resources"));
		expect(config.agentResourceDir).toBe(join(root, "data", "system", "agent-resources"));
		expect(config.sandboxRequired).toBe(false);
	});

	it("fails when Pi configuration is incomplete", () => {
		expect(() => loadEnv({ PI_MODEL_ID: "openai/gpt-oss-120b" })).toThrow(/Missing required Pi configuration/);
	});

	it("fails when PI_MODEL_ID is missing", () => {
		const root = join(tmpdir(), `pi-chat-env-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);
		const templateDir = join(root, "templates", "workspace");
		mkdirSync(templateDir, { recursive: true });

		expect(() =>
			loadEnv({
				PI_CHAT_TEMPLATE_ROOT: templateDir,
				PI_PROVIDER: "openrouter",
			}),
		).toThrow(/Missing required Pi configuration: PI_MODEL_ID/);
	});

	it("fails on invalid port values", () => {
		const root = join(tmpdir(), `pi-chat-env-port-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);
		const templateDir = join(root, "templates", "workspace");
		mkdirSync(templateDir, { recursive: true });

		expect(() =>
			loadEnv({
				PORT: "-1",
				PI_CHAT_TEMPLATE_ROOT: templateDir,
				PI_PROVIDER: "openrouter",
				PI_MODEL_ID: "openai/gpt-oss-120b",
			}),
		).toThrow(/Invalid PORT value/);
	});

	it("requires PI_PROVIDER explicitly", () => {
		const root = join(tmpdir(), `pi-chat-env-provider-required-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);
		const templateDir = join(root, "templates", "workspace");
		mkdirSync(templateDir, { recursive: true });

		expect(() =>
			loadEnv({
				PI_CHAT_TEMPLATE_ROOT: templateDir,
				PI_MODEL_ID: "openai/gpt-oss-120b",
			}),
		).toThrow(/Missing required Pi configuration: PI_PROVIDER/);
	});

	it("fails when the workspace template path does not exist", () => {
		const root = join(tmpdir(), `pi-chat-env-template-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);

		expect(() =>
			loadEnv({
				PI_CHAT_TEMPLATE_ROOT: join(root, "missing-template"),
				PI_PROVIDER: "openrouter",
				PI_MODEL_ID: "openai/gpt-oss-120b",
			}),
		).toThrow(/Workspace template directory does not exist/);
	});

	it("fails on invalid sandbox boolean values", () => {
		const root = join(tmpdir(), `pi-chat-env-bool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(root);
		const templateDir = join(root, "templates", "workspace");
		mkdirSync(templateDir, { recursive: true });

		expect(() =>
			loadEnv({
				PI_CHAT_TEMPLATE_ROOT: templateDir,
				PI_PROVIDER: "openrouter",
				PI_MODEL_ID: "openai/gpt-oss-120b",
				PI_SANDBOX_REQUIRED: "maybe",
			}),
		).toThrow(/Invalid boolean value/);
	});
});

