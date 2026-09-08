// Copyright 2026 Google LLC

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

//     https://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import YAML = require('yaml');
import * as jsonc from 'jsonc-parser';
import { locateL10nYaml } from './project';
import { L10nYaml } from './extension';

/**
 * Regex matching member access expressions commonly used for Flutter localizations:
 * 1) Class static methods: `AppLocalizations.of(...)`, `S.of(...)`, `S.current`
 * 2) Variable/property chains: `l10n`, `_l10n`, `context.l10n`, `loc`, `localizations`, `strings`
 */
export const L10N_MEMBER_ACCESS_REGEX =
	/(?:(\b[A-Za-z0-9_]+\.(?:of\([^)]*\)|current))|(\b[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*))[?!]?\.([a-zA-Z0-9_]+)/g;

/**
 * Checks whether the receiver expression is likely a localization receiver.
 */
export function isLikelyLocalizationReceiver(
	receiver: string,
	outputClass: string = 'AppLocalizations',
): boolean {
	if (
		receiver === outputClass ||
		receiver.startsWith(outputClass + '.') ||
		receiver === 'S' ||
		receiver.startsWith('S.')
	) {
		return true;
	}

	const clean = receiver.replace(/^[?!.]+/, '').trim();
	return /(^|\.)(_?l10n|_?loc|_?localizations|_?strings)$/i.test(clean);
}

/**
 * Produces a source-like string where `//` single-line comments and `///` doc comments
 * are masked with spaces (preserving newlines) to avoid false positives in comments.
 */
export function sanitizeDartSource(source: string): string {
	return source.replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length));
}

export function parseYaml(uri: string): L10nYaml | undefined {
	try {
		const yaml = fs.readFileSync(uri, 'utf8');
		return YAML.parse(yaml) as L10nYaml;
	} catch {
		return undefined;
	}
}

export function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_{}[\]()#+\-.!~|>])/g, '\\$1');
}

export function resolveTemplateArbPath(projectRootOrYamlPath: string, options?: L10nYaml): string {
	const templateRoot = options?.['arb-dir'] ?? 'lib/l10n';
	const templateFile = options?.['template-arb-file'] ?? 'app_en.arb';

	const baseDir = /\.ya?ml$/i.test(projectRootOrYamlPath)
		? path.dirname(projectRootOrYamlPath)
		: projectRootOrYamlPath;

	return path.isAbsolute(templateFile)
		? templateFile
		: path.join(baseDir, templateRoot, templateFile);
}

export interface ArbMessageInfo {
	value: string;
	description?: string;
}

export interface ArbData {
	uri: vscode.Uri;
	filePath: string;
	locale: string;
	outputClass: string;
	messages: Map<string, ArbMessageInfo>;
}

interface ArbCacheEntry {
	mtimeMs: number;
	messages: Map<string, ArbMessageInfo>;
	locale: string;
}

const arbCache = new Map<string, ArbCacheEntry>();

export function invalidateArbCache(): void {
	arbCache.clear();
}

export function getArbData(arbPath: string, outputClass?: string): ArbData | undefined {
	try {
		const stat = fs.statSync(arbPath);
		const cached = arbCache.get(arbPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return {
				uri: vscode.Uri.file(arbPath),
				filePath: arbPath,
				locale: cached.locale,
				outputClass: outputClass || 'AppLocalizations',
				messages: cached.messages,
			};
		}

		const json = jsonc.parse(fs.readFileSync(arbPath, 'utf8'));
		if (!json || typeof json !== 'object') {
			return undefined;
		}

		const messages = new Map<string, ArbMessageInfo>();
		for (const [key, value] of Object.entries(json)) {
			if (typeof value === 'string' && !key.startsWith('@')) {
				messages.set(key, {
					value,
					description: json[`@${key}`]?.description,
				});
			}
		}

		const locale =
			json['@@locale'] ||
			path.basename(arbPath).match(/_([A-Za-z0-9_-]+)\.arb$/)?.[1] ||
			'';

		arbCache.set(arbPath, { mtimeMs: stat.mtimeMs, messages, locale });
		return {
			uri: vscode.Uri.file(arbPath),
			filePath: arbPath,
			locale,
			outputClass: outputClass || 'AppLocalizations',
			messages,
		};
	} catch {
		return undefined;
	}
}

export function locateProjectRoot(folder: string): string | undefined {
	if (!folder || (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder)) && vscode.workspace.workspaceFolders?.length)) {
		return undefined;
	}

	let dir = folder;
	while (dir !== path.dirname(dir)) {
		if (
			fs.existsSync(path.join(dir, 'pubspec.yaml')) ||
			fs.existsSync(path.join(dir, '.dart_tool', 'package_config.json'))
		) {
			return dir;
		}
		dir = path.dirname(dir);
	}

	return undefined;
}

export function resolveArbDataForDartFile(dartFilePath: string): ArbData | undefined {
	const dir = path.dirname(dartFilePath);
	const l10nYamlPath = locateL10nYaml(dir);
	if (l10nYamlPath) {
		const options = parseYaml(l10nYamlPath);
		const arbPath = resolveTemplateArbPath(l10nYamlPath, options);
		return getArbData(arbPath, options?.['output-class']);
	}

	// Flutter default fallback when no l10n.yaml exists
	const projectRoot = locateProjectRoot(dir);
	if (!projectRoot) {
		return undefined;
	}

	const defaultArbPath = resolveTemplateArbPath(projectRoot);
	return getArbData(defaultArbPath);
}

export function createInlayHint(
	position: vscode.Position,
	key: string,
	messageInfo: ArbMessageInfo,
	arbData: ArbData,
	maxLength: number,
): vscode.InlayHint {
	const normalized = messageInfo.value.replace(/\s+/g, ' ').trim();
	const codePoints = Array.from(normalized);
	const truncated =
		codePoints.length > maxLength
			? `${codePoints.slice(0, Math.max(0, maxLength - 3)).join('')}...`
			: normalized;

	const tooltip = new vscode.MarkdownString();
	tooltip.appendMarkdown(`**${escapeMarkdown(key)}**`);
	if (arbData.locale) {
		tooltip.appendMarkdown(` \`(${escapeMarkdown(arbData.locale)})\``);
	}
	if (messageInfo.description) {
		tooltip.appendMarkdown(`\n\n*${escapeMarkdown(messageInfo.description)}*`);
	}
	tooltip.appendMarkdown(`\n\n> ${escapeMarkdown(normalized)}`);

	const part = new vscode.InlayHintLabelPart(`: "${truncated}"`);
	part.command = {
		title: 'Open in ARB',
		command: 'arb-editor.openArbKey',
		arguments: [arbData.uri, key],
	};

	const hint = new vscode.InlayHint(
		position,
		[part],
		vscode.InlayHintKind.Parameter,
	);
	hint.paddingLeft = true;
	hint.tooltip = tooltip;

	return hint;
}

export class DartArbInlayHintsProvider implements vscode.InlayHintsProvider {
	private readonly _onDidChangeInlayHints = new vscode.EventEmitter<void>();
	public readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

	constructor(context: vscode.ExtensionContext) {
		const arbWatcher = vscode.workspace.createFileSystemWatcher('**/*.arb');
		const yamlWatcher = vscode.workspace.createFileSystemWatcher('**/l10n.yaml');
		const pubspecWatcher = vscode.workspace.createFileSystemWatcher('**/pubspec.yaml');

		const refresh = () => {
			invalidateArbCache();
			this._onDidChangeInlayHints.fire();
		};

		context.subscriptions.push(
			arbWatcher,
			arbWatcher.onDidChange(refresh),
			arbWatcher.onDidCreate(refresh),
			arbWatcher.onDidDelete(refresh),
			yamlWatcher,
			yamlWatcher.onDidChange(refresh),
			yamlWatcher.onDidCreate(refresh),
			yamlWatcher.onDidDelete(refresh),
			pubspecWatcher,
			pubspecWatcher.onDidChange(refresh),
			pubspecWatcher.onDidCreate(refresh),
			pubspecWatcher.onDidDelete(refresh),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (
					e.affectsConfiguration('arb-editor.enableInlayHints') ||
					e.affectsConfiguration('arb-editor.inlayHints')
				) {
					refresh();
				}
			}),
		);
	}

	provideInlayHints(
		document: vscode.TextDocument,
		range: vscode.Range,
		token: vscode.CancellationToken,
	): vscode.InlayHint[] {
		if (document.languageId !== 'dart') {
			return [];
		}

		const config = vscode.workspace.getConfiguration('arb-editor');
		if (!config.get<boolean>('enableInlayHints', true)) {
			return [];
		}

		const arbData = resolveArbDataForDartFile(document.uri.fsPath);
		if (!arbData || arbData.messages.size === 0) {
			return [];
		}

		const maxLength = config.get<number>('inlayHints.maxLength', 35);
		const text = document.getText(range);
		const rangeStartOffset = document.offsetAt(range.start);
		const sanitized = sanitizeDartSource(text);
		const hints: vscode.InlayHint[] = [];

		for (const match of sanitized.matchAll(L10N_MEMBER_ACCESS_REGEX)) {
			if (token.isCancellationRequested) {
				break;
			}

			const receiver = match[1] || match[2];
			const member = match[3];
			if (!receiver || !member) {
				continue;
			}

			const messageInfo = arbData.messages.get(member);
			if (!messageInfo) {
				continue;
			}

			if (!isLikelyLocalizationReceiver(receiver, arbData.outputClass)) {
				continue;
			}

			const memberEndOffset = rangeStartOffset + match.index! + match[0].length;
			const position = document.positionAt(memberEndOffset);

			hints.push(
				createInlayHint(position, member, messageInfo, arbData, maxLength),
			);
		}

		return hints;
	}
}
