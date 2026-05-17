import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceTemplateProvisioner } from "./workspace-template-provisioner.js";

export interface UserPaths {
	userId: string;
	userRoot: string;
	workspaceDir: string;
	sessionsDir: string;
}

export interface UserWorkspaceServiceOptions {
	usersRoot: string;
	defaultUserId: string;
	templateProvisioner: WorkspaceTemplateProvisioner;
}

export class UserWorkspaceService {
	constructor(private readonly options: UserWorkspaceServiceOptions) {}

	getDefaultUserId(): string {
		return this.options.defaultUserId;
	}

	resolveUserPaths(userId: string): UserPaths {
		const safeUserId = userId.trim() || this.options.defaultUserId;
		const userRoot = resolve(this.options.usersRoot, safeUserId);

		return {
			userId: safeUserId,
			userRoot,
			workspaceDir: resolve(userRoot, "workspace"),
			sessionsDir: resolve(userRoot, "sessions"),
		};
	}

	ensureUserReady(userId: string): UserPaths {
		const paths = this.resolveUserPaths(userId);

		mkdirSync(paths.userRoot, { recursive: true });
		mkdirSync(paths.sessionsDir, { recursive: true });
		this.ensureWorkspaceInitialized(paths.workspaceDir);

		return paths;
	}

	private ensureWorkspaceInitialized(workspaceDir: string): void {
		const workspaceExists = existsSync(workspaceDir);
		if (!workspaceExists) {
			mkdirSync(workspaceDir, { recursive: true });
			this.options.templateProvisioner.provisionInto(workspaceDir);
			return;
		}

		const entries = readdirSync(workspaceDir);
		if (entries.length === 0) {
			this.options.templateProvisioner.provisionInto(workspaceDir);
		}
	}
}
