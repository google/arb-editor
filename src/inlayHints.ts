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
 * Produces a source-like string where comments and string contents are masked with
 * spaces (newlines preserved) to avoid false positives in literals/comments.
 */
export function sanitizeDartSource(source: string): string {
	let result = '';
	let i = 0;
	let commentDepth = 0;

	while (i < source.length) {
		if (commentDepth > 0) {
			if (source[i] === '/' && source[i + 1] === '*') {
				result += '  ';
				i += 2;
				commentDepth++;
				continue;
			}
			if (source[i] === '*' && source[i + 1] === '/') {
				result += '  ';
				i += 2;
				commentDepth--;
				continue;
			}
			result += source[i] === '\n' ? '\n' : ' ';
			i++;
			continue;
		}

		if (source[i] === '/' && source[i + 1] === '/') {
			result += '  ';
			i += 2;
			while (i < source.length && source[i] !== '\n') {
				result += ' ';
				i++;
			}
			continue;
		}

		if (source[i] === '/' && source[i + 1] === '*') {
			result += '  ';
			i += 2;
			commentDepth = 1;
			continue;
		}

		const isRaw =
			(source[i] === 'r' || source[i] === 'R') &&
			(source[i + 1] === '\'' || source[i + 1] === '"');
		const quoteIndex = isRaw ? i + 1 : i;
		const quoteChar = source[quoteIndex];

		if (quoteChar === '\'' || quoteChar === '"') {
			const isTriple =
				source[quoteIndex + 1] === quoteChar &&
				source[quoteIndex + 2] === quoteChar;
			const quoteLen = isTriple ? 3 : 1;
			const prefixLen = isRaw ? 1 : 0;
			result += ' '.repeat(prefixLen + quoteLen);
			i = quoteIndex + quoteLen;

			while (i < source.length) {
				if (!isRaw && !isTriple && source[i] === '\\') {
					result += '  ';
					i += 2;
					continue;
				}
				if (isTriple) {
					if (
						source[i] === quoteChar &&
						source[i + 1] === quoteChar &&
						source[i + 2] === quoteChar
					) {
						result += '   ';
						i += 3;
						break;
					}
				} else if (source[i] === quoteChar) {
					result += ' ';
					i++;
					break;
				}
				result += source[i] === '\n' ? '\n' : ' ';
				i++;
			}
			continue;
		}

		result += source[i];
		i++;
	}

	return result;
}

export function parseYaml(uri: string): L10nYaml | undefined {
	if (!fs.existsSync(uri)) {
		return undefined;
	}
	const yaml = fs.readFileSync(uri, 'utf8');
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
	uri: vscode.Uri;
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
					c => c.children && c.children[0]?.value === 'description',
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
			uri: vscode.Uri.file(arbPath),
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

export function createInlayHint(
	position: vscode.Position,
	key: string,
	messageInfo: ArbMessageInfo,
	arbData: ArbData,
	maxLength: number,
): vscode.InlayHint {
	const normalized = messageInfo.value.replace(/\s+/g, ' ').trim();
	const truncated =
		normalized.length > maxLength
			? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
			: normalized;

	const tooltip = new vscode.MarkdownString();
	tooltip.appendMarkdown(`**${key}**`);
	if (arbData.locale) {
		tooltip.appendMarkdown(` \`(${arbData.locale})\``);
	}
	if (messageInfo.description) {
		tooltip.appendMarkdown(`\n\n*${messageInfo.description}*`);
	}
	tooltip.appendMarkdown(`\n\n> ${normalized}`);

	const part = new vscode.InlayHintLabelPart(`: "${truncated}"`);
	part.command = {
		title: 'Open in ARB',
		command: 'arb-editor.openArbKey',
		arguments: [arbData.uri, messageInfo.offset],
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
