import * as fs from "fs";
import * as path from "path";
import { Uri, workspace } from "vscode";
import YAML = require('yaml');

export const UPGRADE_TO_WORKSPACE_FOLDERS = "Mark Projects as Workspace Folders";

type L10nYamlCacheEntry = {
	mtimeMs: number;
	content: string;
	parsed: Record<string, unknown> | undefined;
};

const l10nYamlCache = new Map<string, L10nYamlCacheEntry>();

export function locateL10nYaml(folder: string): string | undefined {
	if (!folder || (!isWithinWorkspace(folder) && workspace.workspaceFolders?.length)) return undefined;

	let dir = folder;
	while (dir !== path.dirname(dir)) {
		if (hasL10nYaml(dir)) {
			return path.join(dir, "l10n.yaml");
		} else if (hasPubspec(dir) || hasPackageMapFile(dir)) {
			return undefined;
		}

		dir = path.dirname(dir);
	}

	return undefined;
}

export function getL10nYamlContent(l10nYamlPath: string | undefined): string | undefined {
	return getCachedL10nYaml(l10nYamlPath)?.content;
}

export function getParsedL10nYaml<T>(l10nYamlPath: string | undefined): T | undefined {
	return getCachedL10nYaml(l10nYamlPath)?.parsed as T | undefined;
}

function getCachedL10nYaml(l10nYamlPath: string | undefined): L10nYamlCacheEntry | undefined {
	if (!l10nYamlPath || !fs.existsSync(l10nYamlPath)) return undefined;

	const stat = fs.statSync(l10nYamlPath);
	const cached = l10nYamlCache.get(l10nYamlPath);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

	const content = fs.readFileSync(l10nYamlPath, "utf8");
	let parsed: Record<string, unknown> | undefined;
	try {
		const yaml = YAML.parse(content) as unknown;
		parsed = yaml && typeof yaml === "object"
			? yaml as Record<string, unknown>
			: {};
	} catch {
		parsed = undefined;
	}

	const entry: L10nYamlCacheEntry = {
		mtimeMs: stat.mtimeMs,
		content,
		parsed,
	};
	l10nYamlCache.set(l10nYamlPath, entry);

	return entry;
}

function hasPackageMapFile(folder: string): boolean {
	return fs.existsSync(path.join(folder, ".dart_tool", "package_config.json")) || fs.existsSync(path.join(folder, ".packages"));
}

function hasPubspec(folder: string): boolean {
	return fs.existsSync(path.join(folder, "pubspec.yaml"));
}

function hasL10nYaml(folder: string): boolean {
	return fs.existsSync(path.join(folder, "l10n.yaml"));
}

function isWithinWorkspace(file: string) {
	return !!workspace.getWorkspaceFolder(Uri.file(file));
}
