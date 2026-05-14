import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export class AgentResourceSynchronizer {
	constructor(private readonly templateDir: string) {}

	getTemplateDir(): string {
		return this.templateDir;
	}

	syncInto(targetDir: string): void {
		if (!existsSync(this.templateDir)) {
			throw new Error(`Agent resource template directory does not exist: ${this.templateDir}`);
		}

		this.syncDirectory(this.templateDir, targetDir);
	}

	private syncDirectory(sourceDir: string, targetDir: string): void {
		mkdirSync(targetDir, { recursive: true });

		const sourceEntries = readdirSync(sourceDir);
		const sourceEntryNames = new Set(sourceEntries);

		for (const targetEntry of readdirSync(targetDir)) {
			if (!sourceEntryNames.has(targetEntry)) {
				rmSync(join(targetDir, targetEntry), { recursive: true, force: true });
			}
		}

		for (const entry of sourceEntries) {
			const sourcePath = join(sourceDir, entry);
			const targetPath = join(targetDir, entry);
			const sourceStats = statSync(sourcePath);

			if (sourceStats.isDirectory()) {
				if (existsSync(targetPath) && !statSync(targetPath).isDirectory()) {
					rmSync(targetPath, { recursive: true, force: true });
				}
				this.syncDirectory(sourcePath, targetPath);
				continue;
			}

			if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
				rmSync(targetPath, { recursive: true, force: true });
			}

			cpSync(sourcePath, targetPath, { force: true });
		}
	}
}