import type { AppConfig } from "./env.js";
import type { CanvasBuildService } from "./services/canvas-build-service.js";
import type { CanvasEventBus } from "./services/canvas-event-bus.js";
import type { CanvasRuntimeEventService } from "./services/canvas-runtime-event-service.js";
import type { CanvasStore } from "./services/canvas-store.js";
import type { PiAgentService } from "./services/pi-agent-service.js";
import type { PiSessionStore } from "./services/pi-session-store.js";
import type { SessionNamingService } from "./services/session-naming-service.js";
import type { SessionExecutionQueue } from "./services/session-execution-queue.js";
import type { UserWorkspaceService } from "./services/user-workspace-service.js";

declare module "fastify" {
	interface FastifyInstance {
		config: AppConfig;
		canvasBuildService: CanvasBuildService;
		canvasEventBus: CanvasEventBus;
		canvasRuntimeEventService: CanvasRuntimeEventService;
		canvasStore: CanvasStore;
		piAgentService: PiAgentService;
		sessionStore: PiSessionStore;
		sessionNamingService: SessionNamingService;
		sessionExecutionQueue: SessionExecutionQueue;
		userWorkspaceService: UserWorkspaceService;
	}
}
