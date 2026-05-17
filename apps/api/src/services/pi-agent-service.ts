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
import { CanvasBuildService } from "./canvas-build-service.js";
import { CanvasEventBus } from "./canvas-event-bus.js";
import { CanvasStore } from "./canvas-store.js";
import { createCanvasToolsExtension } from "./canvas-tools-extension.js";
import type { PiSessionStore } from "./pi-session-store.js";
import { createWorkspaceSandboxExtension } from "./sandbox-tools.js";
import type { UserWorkspaceService } from "./user-workspace-service.js";

export class PiAgentService {
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly settingsManager: SettingsManager;

	constructor(
		private readonly config: AppConfig,
		private readonly userWorkspaceService: UserWorkspaceService,
		private readonly sessionStore: PiSessionStore,
		private readonly canvasStore: CanvasStore,
		private readonly canvasEventBus: CanvasEventBus,
		private readonly canvasBuildService: CanvasBuildService,
	) {
		this.authStorage = AuthStorage.create(join(this.config.systemDataDir, "auth.json"));
		this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
		this.assertConfiguredModelAuth();

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

	private assertConfiguredModelAuth(): void {
		const model = this.getConfiguredModel();
		if (this.modelRegistry.hasConfiguredAuth(model)) {
			return;
		}

		throw new Error(
			`No authentication configured for provider "${this.config.piProvider}". ` +
				`Set the provider's SDK-native environment variable or add credentials to ${join(this.config.systemDataDir, "auth.json")}.`,
		);
	}

	getConfiguredModel() {
		const model = this.modelRegistry.find(this.config.piProvider, this.config.piModelId!);
		if (!model) {
			throw new Error(`Configured model not found: ${this.config.piProvider}/${this.config.piModelId}`);
		}

		return model;
	}

	async getConfiguredRequestAuth(): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
		const model = this.getConfiguredModel();
		const resolved = await this.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok) {
			throw new Error(
				`Failed to resolve request auth for configured model ${this.config.piProvider}/${this.config.piModelId}: ${resolved.error}`,
			);
		}

		const requestAuth: { apiKey?: string; headers?: Record<string, string> } = {};
		if (resolved.apiKey !== undefined) {
			requestAuth.apiKey = resolved.apiKey;
		}
		if (resolved.headers !== undefined) {
			requestAuth.headers = resolved.headers;
		}

		return requestAuth;
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
			extensionFactories: [
				createWorkspaceSandboxExtension(paths.workspaceDir),
				createCanvasToolsExtension({
					userId,
					canvasBuildService: this.canvasBuildService,
					canvasEventBus: this.canvasEventBus,
					canvasStore: this.canvasStore,
				}),
			],
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
			tools: [
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"canvas_set_visibility",
				"canvas_publish_card",
				"canvas_remove_card",
				"canvas_list_cards",
				"canvas_get_diagnostics",
			],
		});
	}
}

