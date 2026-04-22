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
import path = require('path');
import YAML = require('yaml');
import { getArbMessages, getL10nYamlContent, getParsedL10nYaml, locateL10nYaml } from './project';

/**
 * Pattern to find member access expressions:
 * `identifier.member`, `identifier?.member` or `identifier!.member`.
 */
const memberAccessPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)([?!])?\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Pattern to find direct AppLocalizations access:
 * `AppLocalizations.of(context)!.member` or `AppLocalizations.of(context)?.member`.
 */
const directAppLocalizationsAccessPattern = /\bAppLocalizations\.of\s*\(\s*context\s*\)\s*[?!]\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;

type MemberAccessCandidate = {
	identifier: string;
	member: string;
	offset: number;
	requiresHoverCheck: boolean;
};

type CodeLensLanguageMode = 'definedByYaml' | 'custom';
type L10nYamlOptions = {
	'arb-dir'?: string;
	'template-arb-file'?: string;
};
type LocalizedArbData = {
	path: string;
	filename: string;
	messages: Record<string, string>;
};

/**
 * CodeLens provider class.
 */
export class AppLocalizationsCodeLensProvider implements vscode.CodeLensProvider {
	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this.codeLensEmitter.event;

	/**
	 * Refreshes CodeLens when `arb-editor.enableAppLocalizationsCodeLens` setting is enabled
	 */
	constructor() {
		vscode.workspace.onDidChangeConfiguration(event => {
			if (
				!event.affectsConfiguration('arb-editor.enableAppLocalizationsCodeLens')
				&& !event.affectsConfiguration('arb-editor.appLocalizationsCodeLensLanguageMode')
				&& !event.affectsConfiguration('arb-editor.appLocalizationsCodeLensCustomLanguage')
				&& !event.affectsConfiguration('arb-editor.appLocalizationsCodeLensTemplate')
			) {
				return;
			}

			this.codeLensEmitter.fire();
		});
	}

	/**
	 * Provides code lenses for Dart files when the AppLocalizations feature is enabled.
	 */
	provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
		if (document.languageId !== 'dart') return [];

		const config = vscode.workspace.getConfiguration('arb-editor');
		const enabled = config.get<boolean>('enableAppLocalizationsCodeLens', true);
		if (!enabled) return [];

		return this.findAppLocalizations(document, token);
	}

	/**
	 * Finds member-access expressions and asks the Dart language server for hover/type
	 * information to determine whether the receiver is an AppLocalizations instance.
	 */
	private async findAppLocalizations(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<vscode.CodeLens[]> {
		const source = document.getText();
		const candidates = getMemberAccessCandidates(source);
		const config = vscode.workspace.getConfiguration('arb-editor');
		const template = config.get<string>('appLocalizationsCodeLensTemplate', '[${lang}] ${value}');
		const displayLanguage = resolveCodeLensDisplayLanguage(document);
		const localizedArbData = resolveLocalizedArbData(document, displayLanguage);
		const codeLenses: vscode.CodeLens[] = [];

		for (const candidate of candidates) {
			if (token.isCancellationRequested) break;

			const offset = candidate.offset;
			const position = document.positionAt(offset);

			if (!candidate.requiresHoverCheck) {
				const title = getCodeLensTitle(candidate.member, displayLanguage, template, localizedArbData);
				if (!title) continue;

				const lensPosition = document.positionAt(offset);
				const range = new vscode.Range(lensPosition, lensPosition);

				codeLenses.push(
					new vscode.CodeLens(range, {
						title,
						command: 'arb-editor.noopCodeLens'
					})
				);

				continue;
			}

			try {
				const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
					'vscode.executeHoverProvider',
					document.uri,
					position
				);

				if (hovers && hovers.length > 0 && isAppLocalizationsType(hovers[0])) {
					const title = getCodeLensTitle(candidate.member, displayLanguage, template, localizedArbData);
					if (!title) continue;

					const lensPosition = document.positionAt(offset);
					const range = new vscode.Range(lensPosition, lensPosition);

					codeLenses.push(
						new vscode.CodeLens(range, {
							title,
							command: 'arb-editor.noopCodeLens'
						})
					);
				}
			} catch {
				// Hover provider failed, skip this match
			}
		}

		return codeLenses;
	}
}

function getCodeLensTitle(
	member: string,
	language: string,
	template: string,
	localizedArbData: LocalizedArbData | undefined,
): string | undefined {
	const message = localizedArbData?.messages[member];
	if (!message) return undefined;

	const normalized = message.replace(/\s+/g, ' ').trim();
	const rendered = renderCodeLensTemplate(template, {
		value: normalized,
		path: localizedArbData.path,
		filename: localizedArbData.filename,
		lang: language,
	}).trim();

	return rendered || undefined;
}

export function renderCodeLensTemplate(
	template: string,
	variables: { value: string; path: string; filename: string; lang: string; },
): string {
	return template
		.replace(/\$\{value\}/g, variables.value)
		.replace(/\$\{path\}/g, variables.path)
		.replace(/\$\{filename\}/g, variables.filename)
		.replace(/\$\{lang\}/g, variables.lang);
}

function resolveLocalizedArbData(document: vscode.TextDocument, language: string): LocalizedArbData | undefined {
	const l10nYamlPath = locateL10nYaml(path.dirname(document.uri.fsPath));
	if (!l10nYamlPath) {
		return undefined;
	}

	const l10nOptions = getParsedL10nYaml<L10nYamlOptions>(l10nYamlPath);
	const arbPath = resolveArbPathForLanguage(l10nYamlPath, language, l10nOptions);
	const messages = getArbMessages(arbPath);
	if (!arbPath || !messages) {
		return undefined;
	}

	return {
		path: arbPath,
		filename: path.basename(arbPath),
		messages,
	};
}

function resolveArbPathForLanguage(
	l10nYamlPath: string,
	language: string,
	l10nOptions: L10nYamlOptions | undefined,
): string | undefined {
	const baseDir = path.dirname(l10nYamlPath);
	const arbDirOption = l10nOptions?.['arb-dir'] ?? 'lib/l10n';
	const templateArbFile = l10nOptions?.['template-arb-file'] ?? 'app_en.arb';
	const arbDir = path.isAbsolute(arbDirOption)
		? arbDirOption
		: path.join(baseDir, arbDirOption);

	const candidateFiles = buildArbFileCandidates(templateArbFile, language);
	for (const candidateFile of candidateFiles) {
		const arbPath = path.isAbsolute(candidateFile)
			? candidateFile
			: path.join(arbDir, candidateFile);
		const messages = getArbMessages(arbPath);
		if (messages) {
			return arbPath;
		}
	}

	return undefined;
}

function buildArbFileCandidates(templateArbFile: string, language: string): string[] {
	const candidates = new Set<string>();
	const normalizedLanguage = language.trim();
	if (normalizedLanguage) {
		candidates.add(templateArbFile.replace(/_([A-Za-z0-9_-]+)\.arb$/, `_${normalizedLanguage}.arb`));
		candidates.add(`app_${normalizedLanguage}.arb`);
		candidates.add(`${normalizedLanguage}.arb`);
	}
	candidates.add(templateArbFile);

	return [...candidates];
}

/**
 * Collects member-access candidates from source while skipping class/static style
 * receivers like `AppLocalizations.of`.
 */
export function getMemberAccessCandidates(source: string): MemberAccessCandidate[] {
	const sanitized = sanitizeDartSource(source);
	const candidates: MemberAccessCandidate[] = [];

	for (const match of sanitized.matchAll(directAppLocalizationsAccessPattern)) {
		const member = match[1];
		const offset = match.index;
		if (!member || offset === undefined) continue;

		candidates.push({
			identifier: 'AppLocalizations',
			member,
			offset,
			requiresHoverCheck: false,
		});
	}

	for (const match of sanitized.matchAll(memberAccessPattern)) {
		const identifier = match[1];
		const member = match[3];
		const offset = match.index;
		if (!identifier || !member || offset === undefined) continue;
		if (isLikelyTypeOrStaticReceiver(identifier)) continue;

		candidates.push({
			identifier,
			member,
			offset,
			requiresHoverCheck: true
		});
	}

	return candidates;
}

/**
 * Treats UpperCamelCase receivers as type/static access and excludes
 * them from instance candidates like `AppLocalizations.of`.
 */
function isLikelyTypeOrStaticReceiver(identifier: string): boolean {
	return /^[A-Z]/.test(identifier);
}

/**
 * Resolves the display language from settings and optional l10n.yaml data.
 */
export function resolveDisplayLanguage(options: {
	languageMode?: string;
	customLanguage?: string;
	l10nYamlContent?: string;
}): string {
	const mode = options.languageMode === 'custom' ? 'custom' : 'definedByYaml';
	const customLanguage = (options.customLanguage ?? '').trim();

	if (mode === 'custom' && customLanguage) {
		return customLanguage;
	}

	const yamlLanguage = extractLanguageFromL10nYamlContent(options.l10nYamlContent);
	if (yamlLanguage) {
		return yamlLanguage;
	}

	if (customLanguage) {
		return customLanguage;
	}

	return 'en';
}

/**
 * Extracts a locale code from l10n.yaml settings.
 */
export function extractLanguageFromL10nYamlContent(content?: string): string | undefined {
	if (!content) {
		return undefined;
	}

	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = YAML.parse(content) as Record<string, unknown>;
	} catch {
		return undefined;
	}

	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}

	const templateArbFile = typeof parsed['template-arb-file'] === 'string' ? parsed['template-arb-file'] : undefined;
	const preferredSupportedLocales = typeof parsed['preferred-supported-locales'] === 'string' ? parsed['preferred-supported-locales'] : undefined;
	const outputLocalizationFile = typeof parsed['output-localization-file'] === 'string' ? parsed['output-localization-file'] : undefined;

	const templateLanguage = extractLanguageFromFileName(templateArbFile, '.arb');
	if (templateLanguage) {
		return templateLanguage;
	}

	const preferredLanguage = extractFirstLocale(preferredSupportedLocales);
	if (preferredLanguage) {
		return preferredLanguage;
	}

	return extractLanguageFromFileName(outputLocalizationFile, '.dart');
}

function resolveCodeLensDisplayLanguage(document: vscode.TextDocument): string {
	const config = vscode.workspace.getConfiguration('arb-editor');
	const languageMode = config.get<CodeLensLanguageMode>('appLocalizationsCodeLensLanguageMode', 'definedByYaml');
	const customLanguage = config.get<string>('appLocalizationsCodeLensCustomLanguage', '');

	const l10nYamlPath = locateL10nYaml(path.dirname(document.uri.fsPath));
	const l10nYamlContent = getL10nYamlContent(l10nYamlPath);

	return resolveDisplayLanguage({
		languageMode,
		customLanguage,
		l10nYamlContent,
	});
}

function extractLanguageFromFileName(fileName: string | undefined, suffix: '.arb' | '.dart'): string | undefined {
	if (!fileName) return undefined;

	const normalized = fileName.trim();
	const matcher = suffix === '.arb'
		? /_([A-Za-z0-9_-]+)\.arb$/
		: /_([A-Za-z0-9_-]+)\.dart$/;

	const match = normalized.match(matcher);
	return match?.[1];
}

function extractFirstLocale(rawLocales: string | undefined): string | undefined {
	if (!rawLocales) return undefined;

	const match = rawLocales.match(/[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*/);
	return match?.[0];
}

/**
 * Returns true when hover text indicates the symbol type includes AppLocalizations.
 */
function isAppLocalizationsType(hover: vscode.Hover): boolean {
	const hoverText = hover.contents
		.map(c => (typeof c === 'string' ? c : c.value))
		.join(' ');

	return hoverText.includes("AppLocalizations");
}

/**
 * Produces a source-like string where comments and string contents are masked with
 * spaces (newlines preserved) to avoid false positives in literals/comments.
 */
function sanitizeDartSource(source: string): string {
	let result = '';
	let i = 0;
	let blockCommentDepth = 0;

	while (i < source.length) {
		if (blockCommentDepth > 0) {
			if (source[i] === '/' && source[i + 1] === '*') {
				result += '  ';
				i += 2;
				blockCommentDepth += 1;

				continue;
			}
			if (source[i] === '*' && source[i + 1] === '/') {
				result += '  ';
				i += 2;
				blockCommentDepth -= 1;

				continue;
			}
			result += source[i] === '\n' ? '\n' : ' ';
			i += 1;

			continue;
		}

		if (source[i] === '/' && source[i + 1] === '/') {
			result += '  ';
			i += 2;
			while (i < source.length && source[i] !== '\n') {
				result += ' ';
				i += 1;
			}

			continue;
		}

		if (source[i] === '/' && source[i + 1] === '*') {
			result += '  ';
			i += 2;
			blockCommentDepth = 1;

			continue;
		}

		const quote = detectStringStart(source, i);
		if (quote) {
			i = maskString(source, i, quote, resultAppender => result += resultAppender);

			continue;
		}

		result += source[i];
		i += 1;
	}

	return result;
}

/**
 * Detects whether a Dart string starts at the current index, including raw and
 * triple-quoted forms, and returns metadata needed to mask it.
 */
function detectStringStart(source: string, i: number): { raw: boolean; triple: boolean; quote: '\'' | '"'; prefixLength: number; } | undefined {
	const char = source[i];
	if (char !== '\'' && char !== '"' && char !== 'r' && char !== 'R') return undefined;

	if (char === '\'' || char === '"') {
		return {
			raw: false,
			triple: source[i + 1] === char && source[i + 2] === char,
			quote: char,
			prefixLength: 0,
		};
	}

	const quote = source[i + 1];
	if (quote !== '\'' && quote !== '"') return undefined;

	const previous = source[i - 1] ?? '';
	if (/[A-Za-z0-9_]/.test(previous)) return undefined;

	return {
		raw: true,
		triple: source[i + 2] === quote && source[i + 3] === quote,
		quote,
		prefixLength: 1,
	};
}

/**
 * Replaces a string literal region with spaces (preserving line breaks) and returns
 * the next index after the closing quote sequence.
 */
function maskString(
	source: string,
	start: number,
	stringType: { raw: boolean; triple: boolean; quote: '\'' | '"'; prefixLength: number; },
	append: (text: string) => void,
): number {
	let i = start;

	for (let j = 0; j < stringType.prefixLength; j += 1) {
		append(' ');

		i += 1;
	}

	if (stringType.triple) {
		append('   ');

		i += 3;
	} else {
		append(' ');

		i += 1;
	}

	while (i < source.length) {
		if (!stringType.raw && !stringType.triple && source[i] === '\\') {
			append(' ');
			i += 1;

			if (i < source.length) {
				append(source[i] === '\n' ? '\n' : ' ');
				i += 1;
			}

			continue;
		}

		if (stringType.triple) {
			if (source[i] === stringType.quote && source[i + 1] === stringType.quote && source[i + 2] === stringType.quote) {
				append('   ');
				return i + 3;
			}
		} else if (source[i] === stringType.quote) {
			append(' ');
			return i + 1;
		}

		append(source[i] === '\n' ? '\n' : ' ');
		i += 1;
	}

	return i;
}
