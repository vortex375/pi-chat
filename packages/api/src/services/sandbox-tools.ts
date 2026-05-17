import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type BashOperations,
} from "@earendil-works/pi-coding-agent";

type ToolInput<TTool extends { execute: (...args: any[]) => any }> = Parameters<TTool["execute"]>[1];

function logSandboxDenial(kind: string, requestedPath: string, workspaceDir: string): void {
	console.warn(`[pi-chat][sandbox-denial] kind=${kind} path=${requestedPath} workspace=${workspaceDir}`);
}

function isWithinRoot(candidate: string, root: string): boolean {
	if (candidate === root) {
		return true;
	}

	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return candidate.startsWith(prefix);
}

function findExistingAncestor(targetPath: string): string {
	let current = resolve(targetPath);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return current;
}

export function resolveWorkspacePath(requestedPath: string, workspaceDir: string, allowMissing = false): string {
	const workspaceRoot = realpathSync(workspaceDir);
	const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspaceDir, requestedPath);

	if (existsSync(candidate)) {
		const realCandidate = realpathSync(candidate);
		if (!isWithinRoot(realCandidate, workspaceRoot)) {
			logSandboxDenial("path", requestedPath, workspaceDir);
			throw new Error(`Access denied outside the workspace: ${requestedPath}`);
		}
		return candidate;
	}

	if (!allowMissing) {
		logSandboxDenial("path", requestedPath, workspaceDir);
		throw new Error(`Path not found: ${requestedPath}`);
	}

	const ancestor = findExistingAncestor(dirname(candidate));
	const realAncestor = realpathSync(ancestor);
	if (!isWithinRoot(realAncestor, workspaceRoot)) {
		logSandboxDenial("path", requestedPath, workspaceDir);
		throw new Error(`Access denied outside the workspace: ${requestedPath}`);
	}

	return candidate;
}

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	return {
		HOME: "/tmp",
		LANG: env?.LANG ?? "C.UTF-8",
		LC_ALL: env?.LC_ALL ?? env?.LANG ?? "C.UTF-8",
		PATH: env?.PATH ?? "/usr/bin:/bin",
		SHELL: "/bin/bash",
		TERM: env?.TERM ?? "xterm-256color",
		TMPDIR: "/tmp",
		USER: "anonymous",
		LOGNAME: "anonymous",
	};
}

function shellPath(): string {
	for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return "/bin/sh";
}

function pushRoBind(args: string[], path: string): void {
	if (existsSync(path)) {
		args.push("--ro-bind", path, path);
	}
}

function pushRwBind(args: string[], path: string): void {
	if (existsSync(path)) {
		args.push("--bind", path, path);
	}
}

function pushDir(args: string[], path: string): void {
	args.push("--dir", path);
}

function pushRoBindTo(args: string[], sourcePath: string, targetPath: string): void {
	if (existsSync(sourcePath)) {
		args.push("--ro-bind", sourcePath, targetPath);
	}
}

export function createSandboxedBashOperations(workspaceDir: string): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			const sandboxCwd = resolveWorkspacePath(cwd, workspaceDir);
			const args: string[] = ["--die-with-parent", "--unshare-all", "--share-net", "--new-session"];
			for (const path of ["/usr", "/bin", "/lib", "/lib64", "/sbin"]) {
				pushRoBind(args, path);
			}
			args.push("--tmpfs", "/etc");
			pushDir(args, "/etc/ssl");
			pushDir(args, "/etc/pki");
			pushDir(args, "/etc/pki/tls");
			pushRoBindTo(args, "/etc/resolv.conf", "/etc/resolv.conf");
			pushRoBindTo(args, "/etc/hosts", "/etc/hosts");
			pushRoBindTo(args, "/etc/host.conf", "/etc/host.conf");
			pushRoBindTo(args, "/etc/nsswitch.conf", "/etc/nsswitch.conf");
			pushRoBindTo(args, "/etc/localtime", "/etc/localtime");
			pushRoBindTo(args, "/etc/ssl/certs", "/etc/ssl/certs");
			pushRoBindTo(args, "/etc/ca-certificates", "/etc/ca-certificates");
			pushRoBindTo(args, "/etc/pki/tls/certs", "/etc/pki/tls/certs");
			pushRwBind(args, "/tmp");
			args.push("--proc", "/proc", "--dev", "/dev");
			pushRwBind(args, workspaceDir);
			args.push("--chdir", sandboxCwd, "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--");
			args.push(shellPath(), "-lc", command);

			return new Promise((resolvePromise, reject) => {
				const child = spawn("bwrap", args, {
					cwd: sandboxCwd,
					detached: true,
					env: sanitizeEnv(env),
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("error", (error) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				});
				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
						return;
					}
					resolvePromise({ exitCode: code });
				});
			});
		},
	};
}

export function createGuardedReadTool(workspaceDir: string) {
	const tool = createReadTool(workspaceDir);
	type ReadToolInput = ToolInput<typeof tool>;
	return {
		...tool,
		async execute(toolCallId: string, params: ReadToolInput, signal?: AbortSignal, onUpdate?: any) {
			resolveWorkspacePath(params.path, workspaceDir);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function createGuardedWriteTool(workspaceDir: string) {
	const tool = createWriteTool(workspaceDir);
	type WriteToolInput = ToolInput<typeof tool>;
	return {
		...tool,
		async execute(toolCallId: string, params: WriteToolInput, signal?: AbortSignal, onUpdate?: any) {
			resolveWorkspacePath(params.path, workspaceDir, true);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function createGuardedEditTool(workspaceDir: string) {
	const tool = createEditTool(workspaceDir);
	type EditToolInput = ToolInput<typeof tool>;
	return {
		...tool,
		async execute(toolCallId: string, params: EditToolInput, signal?: AbortSignal, onUpdate?: any) {
			resolveWorkspacePath(params.path, workspaceDir, true);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function createGuardedGrepTool(workspaceDir: string) {
	const tool = createGrepTool(workspaceDir);
	type GrepToolInput = ToolInput<typeof tool>;
	return {
		...tool,
		async execute(toolCallId: string, params: GrepToolInput, signal?: AbortSignal, onUpdate?: any) {
			if (params.path) {
				resolveWorkspacePath(params.path, workspaceDir);
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function createGuardedFindTool(workspaceDir: string) {
	const tool = createFindTool(workspaceDir);
	type FindToolInput = ToolInput<typeof tool>;
	return {
		...tool,
		async execute(toolCallId: string, params: FindToolInput, signal?: AbortSignal, onUpdate?: any) {
			if (params.path) {
				resolveWorkspacePath(params.path, workspaceDir);
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function createGuardedLsTool(workspaceDir: string) {
	const tool = createLsTool(workspaceDir);
	type LsToolInput = ToolInput<typeof tool>;
	return {
		...tool,
		async execute(toolCallId: string, params: LsToolInput, signal?: AbortSignal, onUpdate?: any) {
			if (params.path) {
				resolveWorkspacePath(params.path, workspaceDir);
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function createWorkspaceSandboxExtension(workspaceDir: string): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createGuardedReadTool(workspaceDir));
		pi.registerTool(createGuardedWriteTool(workspaceDir));
		pi.registerTool(createGuardedEditTool(workspaceDir));
		pi.registerTool(createGuardedGrepTool(workspaceDir));
		pi.registerTool(createGuardedFindTool(workspaceDir));
		pi.registerTool(createGuardedLsTool(workspaceDir));
		pi.registerTool(createBashTool(workspaceDir, { operations: createSandboxedBashOperations(workspaceDir) }));
	};
}
