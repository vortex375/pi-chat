import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "../../..");

export interface LoadEnvOptions {
	envFilePath?: string;
}

function loadDotenvFile(env: NodeJS.ProcessEnv, envFilePath: string): void {
	if (!existsSync(envFilePath)) {
		return;
	}

	const parsed = parseDotenv(readFileSync(envFilePath));
	for (const [key, value] of Object.entries(parsed)) {
		if (env[key] === undefined) {
			env[key] = value;
		}
	}
}

function parsePort(raw: string | undefined, fallback: number): number {
	if (!raw) {
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Invalid PORT value: ${raw}`);
	}

	return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) {
		return fallback;
	}

	if (raw === "true") {
		return true;
	}

	if (raw === "false") {
		return false;
	}

	throw new Error(`Invalid boolean value: ${raw}`);
}

export interface AppConfig {
	appVersion: string;
	host: string;
	port: number;
	nodeEnv: string;
	projectRoot: string;
	dataRoot: string;
	systemDataDir: string;
	agentResourceTemplateDir: string;
	agentResourceDir: string;
	usersRoot: string;
	workspaceTemplateDir: string;
	defaultUserId: string;
	piProvider: string;
	piModelId: string | undefined;
	sandboxRequired: boolean;
}

function validateRequiredEnv(config: AppConfig): void {
	const missing: string[] = [];

	if (!config.piProvider) {
		missing.push("PI_PROVIDER");
	}

	if (!config.piModelId) {
		missing.push("PI_MODEL_ID");
	}

	if (missing.length > 0) {
		throw new Error(`Missing required Pi configuration: ${missing.join(", ")}`);
	}

	if (!existsSync(config.workspaceTemplateDir)) {
		throw new Error(`Workspace template directory does not exist: ${config.workspaceTemplateDir}`);
	}

	if (!existsSync(config.agentResourceTemplateDir)) {
		throw new Error(`Agent resource template directory does not exist: ${config.agentResourceTemplateDir}`);
	}
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env, options: LoadEnvOptions = {}): AppConfig {
	if (env === process.env || options.envFilePath) {
		loadDotenvFile(env, options.envFilePath ?? join(projectRoot, ".env"));
	}

	const dataRoot = resolve(env.PI_CHAT_DATA_ROOT ?? join(projectRoot, "data"));

	const config: AppConfig = {
		appVersion: env.npm_package_version ?? "0.1.0",
		host: env.HOST ?? "0.0.0.0",
		port: parsePort(env.PORT, 3000),
		nodeEnv: env.NODE_ENV ?? "development",
		projectRoot,
		dataRoot,
		systemDataDir: resolve(join(dataRoot, "system")),
		agentResourceTemplateDir: resolve(join(projectRoot, "templates", "agent-resources")),
		agentResourceDir: resolve(join(dataRoot, "system", "agent-resources")),
		usersRoot: resolve(join(dataRoot, "users")),
		workspaceTemplateDir: resolve(env.PI_CHAT_TEMPLATE_ROOT ?? join(projectRoot, "templates", "workspace")),
		defaultUserId: env.PI_CHAT_DEFAULT_USER_ID ?? "anonymous",
		piProvider: env.PI_PROVIDER ?? "",
		piModelId: env.PI_MODEL_ID,
		sandboxRequired: parseBoolean(env.PI_SANDBOX_REQUIRED, true),
	};

	validateRequiredEnv(config);
	return config;
}

