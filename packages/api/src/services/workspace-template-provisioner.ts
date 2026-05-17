import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";

export class WorkspaceTemplateProvisioner {
	constructor(private readonly templateDir: string) {}

	getTemplateDir(): string {
		return this.templateDir;
	}

	provisionInto(targetDir: string): void {
		mkdirSync(targetDir, { recursive: true });

		if (!existsSync(this.templateDir)) {
			throw new Error(`Workspace template directory does not exist: ${this.templateDir}`);
		}

		const entries = readdirSync(this.templateDir);
		for (const entry of entries) {
			cpSync(`${this.templateDir}/${entry}`, `${targetDir}/${entry}`, {
				recursive: true,
				errorOnExist: false,
				force: false,
			});
		}
	}
}
