import * as fs from "fs";
import * as path from "path";
import { Uri, workspace } from "vscode";
import YAML = require('yaml');
import * as jsonc from 'jsonc-parser';
import { L10nYaml } from './extension';

export const UPGRADE_TO_WORKSPACE_FOLDERS = "Mark Projects as Workspace Folders";

export function locateL10nYaml(folder: string): string | undefined {
	if (!folder || (!isWithinWorkspace(folder) && workspace.workspaceFolders?.length)) {
		return undefined;
	}

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

export function parseYaml(uri: string): L10nYaml | undefined {
	if (!fs.existsSync(uri)) {
		return undefined;
	}
	const yaml = fs.readFileSync(uri, "utf8");
	return YAML.parse(yaml) as L10nYaml;
}

export function resolveTemplateArbPath(l10nYamlPath: string, options?: L10nYaml): string | undefined {
	const templateRoot = options?.['arb-dir'] ?? 'lib/l10n';
	const templateFile = options?.['template-arb-file'] ?? 'app_en.arb';

	return path.isAbsolute(templateFile)
		? templateFile
		: path.join(path.dirname(l10nYamlPath), templateRoot, templateFile);
}

export interface ArbMessageInfo {
	value: string;
	offset: number;
	description?: string;
}

export interface ArbData {
	uri: Uri;
	filePath: string;
	locale: string;
	outputClass: string;
	messages: Map<string, ArbMessageInfo>;
}

interface ArbCacheEntry {
	mtimeMs: number;
	data: ArbData;
}

const arbCache = new Map<string, ArbCacheEntry>();

export function invalidateArbCache(): void {
	arbCache.clear();
}

export function getArbData(arbPath: string, outputClass?: string): ArbData | undefined {
	if (!fs.existsSync(arbPath)) {
		return undefined;
	}

	const stat = fs.statSync(arbPath);
	const cached = arbCache.get(arbPath);
	if (cached && cached.mtimeMs === stat.mtimeMs) {
		return cached.data;
	}

	try {
		const content = fs.readFileSync(arbPath, 'utf8');
		const tree = jsonc.parseTree(content);
		if (!tree || !tree.children) {
			return undefined;
		}

		let locale = '';
		const messages = new Map<string, ArbMessageInfo>();

		for (const prop of tree.children) {
			if (!prop.children || prop.children.length < 2) {
				continue;
			}
			const key = prop.children[0].value;
			if (typeof key !== 'string') {
				continue;
			}

			if (key === '@@locale') {
				locale = String(prop.children[1].value ?? '');
			} else if (key.startsWith('@')) {
				const mainKey = key.slice(1);
				const descNode = prop.children[1]?.children?.find(
					c => c.children && c.children[0]?.value === 'description'
				);
				const description = descNode?.children && descNode.children[1]?.value;
				const existing = messages.get(mainKey);
				if (existing && typeof description === 'string') {
					existing.description = description;
				}
			} else if (typeof prop.children[1].value === 'string') {
				messages.set(key, {
					value: prop.children[1].value,
					offset: prop.children[0].offset,
				});
			}
		}

		if (!locale) {
			const match = path.basename(arbPath).match(/_([A-Za-z0-9_-]+)\.arb$/);
			locale = match ? match[1] : '';
		}

		const data: ArbData = {
			uri: Uri.file(arbPath),
			filePath: arbPath,
			locale,
			outputClass: outputClass || 'AppLocalizations',
			messages,
		};

		arbCache.set(arbPath, { mtimeMs: stat.mtimeMs, data });
		return data;
	} catch {
		return undefined;
	}
}

export function resolveArbDataForDartFile(dartFilePath: string): ArbData | undefined {
	const l10nYamlPath = locateL10nYaml(path.dirname(dartFilePath));
	if (!l10nYamlPath) {
		return undefined;
	}

	const options = parseYaml(l10nYamlPath);
	const arbPath = resolveTemplateArbPath(l10nYamlPath, options);
	if (!arbPath) {
		return undefined;
	}

	return getArbData(arbPath, options?.['output-class']);
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
