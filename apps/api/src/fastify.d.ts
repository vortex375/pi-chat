import type { AppConfig } from "./env.js";
import type { PiAgentService } from "./services/pi-agent-service.js";
import type { PiSessionStore } from "./services/pi-session-store.js";
import type { SessionExecutionQueue } from "./services/session-execution-queue.js";
import type { UserWorkspaceService } from "./services/user-workspace-service.js";

declare module "fastify" {
	interface FastifyInstance {
		config: AppConfig;
		piAgentService: PiAgentService;
		sessionStore: PiSessionStore;
		sessionExecutionQueue: SessionExecutionQueue;
		userWorkspaceService: UserWorkspaceService;
	}
}
