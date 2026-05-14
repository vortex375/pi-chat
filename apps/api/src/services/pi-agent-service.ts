import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../env.js";
import type { PiSessionStore } from "./pi-session-store.js";
import { createWorkspaceSandboxExtension } from "./sandbox-tools.js";
import type { UserWorkspaceService } from "./user-workspace-service.js";

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

function getProviderCompat(provider: string) {
	if (provider === "openrouter") {
		return {
			thinkingFormat: "openrouter" as const,
			supportsReasoningEffort: true,
		};
	}

	return {
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
	};
}

export class PiAgentService {
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly settingsManager: SettingsManager;

	constructor(
		private readonly config: AppConfig,
		private readonly userWorkspaceService: UserWorkspaceService,
		private readonly sessionStore: PiSessionStore,
	) {
		const providerApiKey = this.config.piOpenAiApiKey!;
		const providerBaseUrl = this.config.piOpenAiBaseUrl!;

		this.authStorage = AuthStorage.create(join(this.config.systemDataDir, "auth.json"));
		this.authStorage.setRuntimeApiKey(this.config.piProvider, providerApiKey);

		this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
		this.modelRegistry.registerProvider(this.config.piProvider, {
			api: "openai-completions",
			apiKey: providerApiKey,
			authHeader: true,
			baseUrl: providerBaseUrl,
			models: [
				{
					id: this.config.piModelId!,
					name: this.config.piModelId!,
					reasoning: true,
					input: ["text"],
					cost: ZERO_COST,
					contextWindow: 256000,
					maxTokens: 32768,
					compat: getProviderCompat(this.config.piProvider),
				},
			],
		});

		const settings: {
			defaultProvider: string;
			defaultModel?: string;
			compaction: { enabled: true; reserveTokens: number; keepRecentTokens: number };
			retry: { enabled: true; maxRetries: number; baseDelayMs: number };
		} = {
			defaultProvider: this.config.piProvider,
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
		};

		if (this.config.piModelId) {
			settings.defaultModel = this.config.piModelId;
		}

		this.settingsManager = SettingsManager.inMemory(settings);
		this.getConfiguredModel();
	}

	getConfiguredModel() {
		const model = this.modelRegistry.find(this.config.piProvider, this.config.piModelId!);
		if (!model) {
			throw new Error(`Configured model not found: ${this.config.piProvider}/${this.config.piModelId}`);
		}

		return model;
	}

	private getAgentAppendSystemPromptPaths(): string[] {
		const appendSystemPromptPath = join(this.config.agentResourceDir, "append-system-prompt.md");
		return existsSync(appendSystemPromptPath) ? [appendSystemPromptPath] : [];
	}

	private getAgentSkillPaths(): string[] {
		const skillsDir = join(this.config.agentResourceDir, "skills");
		return existsSync(skillsDir) ? [skillsDir] : [];
	}

	async createRequestSession(userId: string, sessionId: string): Promise<CreateAgentSessionResult> {
		const sessionPath = await this.sessionStore.getSessionPath(userId, sessionId);
		if (!sessionPath) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		const paths = this.userWorkspaceService.ensureUserReady(userId);
		const resourceLoader = new DefaultResourceLoader({
			agentDir: this.config.systemDataDir,
			additionalSkillPaths: this.getAgentSkillPaths(),
			appendSystemPrompt: this.getAgentAppendSystemPromptPaths(),
			cwd: paths.workspaceDir,
			extensionFactories: [createWorkspaceSandboxExtension(paths.workspaceDir)],
			noContextFiles: true,
			noExtensions: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			settingsManager: this.settingsManager,
			systemPrompt: "You are Pi Chat's backend assistant. Keep responses concise and focus on the current workspace.",
		});
		await resourceLoader.reload();

		return createAgentSession({
			agentDir: this.config.systemDataDir,
			authStorage: this.authStorage,
			cwd: paths.workspaceDir,
			model: this.getConfiguredModel(),
			modelRegistry: this.modelRegistry,
			resourceLoader,
			sessionManager: SessionManager.open(sessionPath, paths.sessionsDir, paths.workspaceDir),
			settingsManager: this.settingsManager,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		});
	}
}


