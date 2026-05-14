import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "../../..");
const SUPPORTED_PI_PROVIDERS = ["openrouter"] as const;

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
	usersRoot: string;
	workspaceTemplateDir: string;
	defaultUserId: string;
	piProvider: string;
	piModelId: string | undefined;
	piOpenAiBaseUrl: string | undefined;
	piOpenAiApiKey: string | undefined;
	sandboxRequired: boolean;
}

function validateRequiredEnv(config: AppConfig): void {
	const missing: string[] = [];

	if (!config.piModelId) {
		missing.push("PI_MODEL_ID");
	}

	if (!config.piOpenAiBaseUrl) {
		missing.push("PI_OPENAI_BASE_URL");
	}

	if (!config.piOpenAiApiKey) {
		missing.push("PI_OPENAI_API_KEY");
	}

	if (missing.length > 0) {
		throw new Error(`Missing required Pi configuration: ${missing.join(", ")}`);
	}

	if (!SUPPORTED_PI_PROVIDERS.includes(config.piProvider as (typeof SUPPORTED_PI_PROVIDERS)[number])) {
		throw new Error(
			`Unsupported PI_PROVIDER value: ${config.piProvider}. Supported values: ${SUPPORTED_PI_PROVIDERS.join(", ")}`,
		);
	}

	const openAiBaseUrl = config.piOpenAiBaseUrl;
	try {
		new URL(openAiBaseUrl!);
	} catch {
		throw new Error(`Invalid PI_OPENAI_BASE_URL value: ${openAiBaseUrl}`);
	}

	if (!existsSync(config.workspaceTemplateDir)) {
		throw new Error(`Workspace template directory does not exist: ${config.workspaceTemplateDir}`);
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
		usersRoot: resolve(join(dataRoot, "users")),
		workspaceTemplateDir: resolve(env.PI_CHAT_TEMPLATE_ROOT ?? join(projectRoot, "templates", "workspace")),
		defaultUserId: env.PI_CHAT_DEFAULT_USER_ID ?? "anonymous",
		piProvider: env.PI_PROVIDER ?? "openrouter",
		piModelId: env.PI_MODEL_ID,
		piOpenAiBaseUrl: env.PI_OPENAI_BASE_URL,
		piOpenAiApiKey: env.PI_OPENAI_API_KEY,
		sandboxRequired: parseBoolean(env.PI_SANDBOX_REQUIRED, true),
	};

	validateRequiredEnv(config);
	return config;
}

