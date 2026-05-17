import { mkdirSync } from "node:fs";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { AgentResourceSynchronizer } from "./services/agent-resource-synchronizer.js";
import { CanvasBuildService } from "./services/canvas-build-service.js";
import { CanvasEventBus } from "./services/canvas-event-bus.js";
import { CanvasRuntimeEventService } from "./services/canvas-runtime-event-service.js";
import { CanvasStore } from "./services/canvas-store.js";
import { PiAgentService } from "./services/pi-agent-service.js";
import { PiSessionStore } from "./services/pi-session-store.js";
import { SessionNamingService } from "./services/session-naming-service.js";
import { validateSandboxPrerequisites } from "./services/sandbox-prerequisites.js";
import { SessionExecutionQueue } from "./services/session-execution-queue.js";
import { WorkspaceTemplateProvisioner } from "./services/workspace-template-provisioner.js";
import { UserWorkspaceService } from "./services/user-workspace-service.js";

async function main(): Promise<void> {
	const config = loadEnv();
	mkdirSync(config.systemDataDir, { recursive: true });
	mkdirSync(config.usersRoot, { recursive: true });
	validateSandboxPrerequisites(config.sandboxRequired);

	const agentResourceSynchronizer = new AgentResourceSynchronizer(config.agentResourceTemplateDir);
	agentResourceSynchronizer.syncInto(config.agentResourceDir);

	const templateProvisioner = new WorkspaceTemplateProvisioner(config.workspaceTemplateDir);
	const userWorkspaceService = new UserWorkspaceService({
		defaultUserId: config.defaultUserId,
		templateProvisioner,
		usersRoot: config.usersRoot,
	});
	const canvasStore = new CanvasStore(userWorkspaceService);
	const canvasEventBus = new CanvasEventBus();
	const canvasRuntimeEventService = new CanvasRuntimeEventService(canvasStore, canvasEventBus);
	const canvasBuildService = new CanvasBuildService(canvasStore, canvasEventBus, canvasRuntimeEventService);
	const sessionStore = new PiSessionStore(userWorkspaceService);
	const sessionExecutionQueue = new SessionExecutionQueue();
	const piAgentService = new PiAgentService(
		config,
		userWorkspaceService,
		sessionStore,
		canvasStore,
		canvasEventBus,
		canvasBuildService,
	);
	const sessionNamingService = new SessionNamingService(piAgentService, sessionStore);

	await userWorkspaceService.ensureUserReady(config.defaultUserId);
	canvasStore.ensureInitialized(config.defaultUserId);

	const app = createApp({
		config,
		canvasBuildService,
		canvasEventBus,
		canvasRuntimeEventService,
		canvasStore,
		piAgentService,
		sessionStore,
		sessionNamingService,
		sessionExecutionQueue,
		userWorkspaceService,
		logger: true,
	});

	try {
		app.log.info(
			{
				dataRoot: config.dataRoot,
				systemDataDir: config.systemDataDir,
				agentResourceTemplateDir: config.agentResourceTemplateDir,
				agentResourceDir: config.agentResourceDir,
				workspaceTemplateDir: config.workspaceTemplateDir,
				defaultUserId: config.defaultUserId,
			},
			"pi-chat backend ready",
		);

		await app.listen({
			host: config.host,
			port: config.port,
		});
	} catch (error) {
		app.log.error(error);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error("Failed to bootstrap pi-chat", error);
	process.exitCode = 1;
});
