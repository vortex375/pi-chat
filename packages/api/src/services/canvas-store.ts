import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { CanvasCard, CanvasDiagnostic, CanvasDiagnostics, CanvasSnapshot } from "@pi-chat/shared";
import type { UserPaths, UserWorkspaceService } from "./user-workspace-service.js";
import { resolveWorkspacePath } from "./sandbox-tools.js";

interface CanvasManifestFile {
	version: 1;
	cards: CanvasCard[];
}

export interface CanvasWorkspacePaths extends UserPaths {
	canvasDir: string;
	canvasCardsDir: string;
	metadataDir: string;
	manifestPath: string;
	diagnosticsDir: string;
	bundlesDir: string;
}

function createEmptyManifest(): CanvasManifestFile {
	return {
		version: 1,
		cards: [],
	};
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
	const normalizedDirectory = directoryPath.endsWith(sep) ? directoryPath : `${directoryPath}${sep}`;
	return candidatePath === directoryPath || candidatePath.startsWith(normalizedDirectory);
}

export class CanvasStore {
	constructor(private readonly userWorkspaceService: UserWorkspaceService) {}

	ensureInitialized(userId: string): CanvasWorkspacePaths {
		const userPaths = this.userWorkspaceService.ensureUserReady(userId);
		const paths: CanvasWorkspacePaths = {
			...userPaths,
			canvasDir: join(userPaths.workspaceDir, "canvas"),
			canvasCardsDir: join(userPaths.workspaceDir, "canvas", "cards"),
			metadataDir: join(userPaths.workspaceDir, ".pi-chat"),
			manifestPath: join(userPaths.workspaceDir, ".pi-chat", "canvas-manifest.json"),
			diagnosticsDir: join(userPaths.workspaceDir, ".pi-chat", "canvas-diagnostics"),
			bundlesDir: join(userPaths.workspaceDir, ".pi-chat", "canvas-bundles"),
		};

		mkdirSync(paths.canvasDir, { recursive: true });
		mkdirSync(paths.canvasCardsDir, { recursive: true });
		mkdirSync(paths.metadataDir, { recursive: true });
		mkdirSync(paths.diagnosticsDir, { recursive: true });
		mkdirSync(paths.bundlesDir, { recursive: true });

		if (!existsSync(paths.manifestPath)) {
			this.writeManifest(paths, createEmptyManifest());
		}

		return paths;
	}

	async getSnapshot(userId: string): Promise<CanvasSnapshot> {
		const paths = this.ensureInitialized(userId);
		const manifest = this.readManifest(paths);

		return {
			cards: manifest.cards,
			diagnostics: this.readAllDiagnostics(paths),
			generatedAt: new Date().toISOString(),
		};
	}

	async listCards(userId: string): Promise<CanvasCard[]> {
		const snapshot = await this.getSnapshot(userId);
		return snapshot.cards;
	}

	async getCard(userId: string, cardId: string): Promise<CanvasCard | undefined> {
		const cards = await this.listCards(userId);
		return cards.find((card) => card.id === cardId);
	}

	async getCardByComponentPath(userId: string, componentPath: string): Promise<CanvasCard | undefined> {
		const cards = await this.listCards(userId);
		return cards.find((card) => card.componentPath === componentPath);
	}

	async upsertCard(userId: string, card: CanvasCard): Promise<CanvasCard> {
		const paths = this.ensureInitialized(userId);
		const manifest = this.readManifest(paths);
		const cards = manifest.cards.filter((existingCard) => existingCard.id !== card.id);
		cards.unshift(card);
		this.writeManifest(paths, {
			...manifest,
			cards,
		});

		return card;
	}

	async removeCard(userId: string, cardId: string): Promise<boolean> {
		const paths = this.ensureInitialized(userId);
		const manifest = this.readManifest(paths);
		const nextCards = manifest.cards.filter((card) => card.id !== cardId);

		if (nextCards.length === manifest.cards.length) {
			return false;
		}

		this.writeManifest(paths, {
			...manifest,
			cards: nextCards,
		});
		rmSync(this.getDiagnosticsPath(paths, cardId), { force: true });
		rmSync(this.getBundlePath(paths, cardId), { force: true });
		return true;
	}

	async readDiagnostics(userId: string, cardId?: string): Promise<CanvasDiagnostics> {
		const paths = this.ensureInitialized(userId);
		if (cardId) {
			return {
				[cardId]: this.readDiagnosticsFile(paths, cardId),
			};
		}

		return this.readAllDiagnostics(paths);
	}

	async writeDiagnostics(userId: string, cardId: string, diagnostics: CanvasDiagnostic[]): Promise<void> {
		const paths = this.ensureInitialized(userId);
		writeFileSync(this.getDiagnosticsPath(paths, cardId), JSON.stringify(diagnostics, null, 2), "utf-8");
	}

	async clearDiagnostics(userId: string, cardId: string): Promise<void> {
		const paths = this.ensureInitialized(userId);
		rmSync(this.getDiagnosticsPath(paths, cardId), { force: true });
	}

	resolveCardComponentPath(userId: string, componentPath: string, allowMissing = false): string {
		const paths = this.ensureInitialized(userId);
		const resolvedPath = resolveWorkspacePath(componentPath, paths.workspaceDir, allowMissing);
		const canvasCardsRoot = realpathSync(paths.canvasCardsDir);
		const normalizedCandidate = existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolve(resolvedPath);

		if (!isWithinDirectory(normalizedCandidate, canvasCardsRoot)) {
			throw new Error(`Canvas card path must stay within ${relative(paths.workspaceDir, paths.canvasCardsDir)}`);
		}

		return resolvedPath;
	}

	toWorkspaceRelativePath(userId: string, absolutePath: string): string {
		const paths = this.ensureInitialized(userId);
		return relative(paths.workspaceDir, absolutePath).split("\\").join("/");
	}

	getBundlePathForCard(userId: string, cardId: string): string {
		const paths = this.ensureInitialized(userId);
		return this.getBundlePath(paths, cardId);
	}

	private getDiagnosticsPath(paths: CanvasWorkspacePaths, cardId: string): string {
		return join(paths.diagnosticsDir, `${cardId}.json`);
	}

	private getBundlePath(paths: CanvasWorkspacePaths, cardId: string): string {
		return join(paths.bundlesDir, `${cardId}.js`);
	}

	private readManifest(paths: CanvasWorkspacePaths): CanvasManifestFile {
		try {
			const parsed = JSON.parse(readFileSync(paths.manifestPath, "utf-8")) as Partial<CanvasManifestFile>;
			if (!Array.isArray(parsed.cards)) {
				return createEmptyManifest();
			}

			return {
				version: 1,
				cards: parsed.cards,
			};
		} catch {
			return createEmptyManifest();
		}
	}

	private writeManifest(paths: CanvasWorkspacePaths, manifest: CanvasManifestFile): void {
		writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
	}

	private readAllDiagnostics(paths: CanvasWorkspacePaths): CanvasDiagnostics {
		const diagnostics: CanvasDiagnostics = {};
		for (const entry of readdirSync(paths.diagnosticsDir)) {
			if (!entry.endsWith(".json")) {
				continue;
			}

			const cardId = entry.slice(0, -".json".length);
			diagnostics[cardId] = this.readDiagnosticsFile(paths, cardId);
		}

		return diagnostics;
	}

	private readDiagnosticsFile(paths: CanvasWorkspacePaths, cardId: string): CanvasDiagnostic[] {
		const diagnosticsPath = this.getDiagnosticsPath(paths, cardId);
		if (!existsSync(diagnosticsPath)) {
			return [];
		}

		try {
			const parsed = JSON.parse(readFileSync(diagnosticsPath, "utf-8")) as unknown;
			return Array.isArray(parsed) ? (parsed as CanvasDiagnostic[]) : [];
		} catch {
			return [];
		}
	}
}
