// Copyright 2022 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict';

import * as vscode from 'vscode';
import { JSONPath, visit } from 'jsonc-parser';
import XRegExp = require('xregexp');
import { locateL10nYaml } from './project';
import { L10nYaml } from './extension';
import { Diagnostics } from './diagnose';
import { Decorator } from './decorate';
import { CodeActions } from './codeactions';
import path = require('path');
import YAML = require('yaml');
import fs = require('fs');

export class Parser {

	parse(document: string, l10nOptions?: L10nYaml): [MessageList, Literal[]] {
		let templatePath: string | undefined;
		const messages: MessageEntry[] = [];
		const metadata: MessageEntry[] = [];

		let nestingLevel = 0;
		let inTemplateTag = false;
		let placeholderLevel: number | null = null;
		let metadataLevel: number | null = null;
		let metadataKey: Key | null = null;
		let messageKey: Key | null = null;
		let definedPlaceholders: PlaceholderMetadata[] = [];
		let errors: Literal[] = [];
		let indentation: number | null = null;
		let indentationCharacter: string | null = null;
		let totalPlaceholderEnd: number | null = null;
		visit(document, {
			onObjectBegin: (offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				nestingLevel++;
			},
			onObjectProperty: (property: string, offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				const key = new Key(property, offset + 1, offset + property.length + 1);
				if (placeholderLevel === nestingLevel - 1) {
					definedPlaceholders.push(new PlaceholderMetadata(property, offset + 1, offset + property.length + 1));
				}
				if (nestingLevel === 1) {
					indentation = startCharacter;
					indentationCharacter = document.substring(offset - 1, offset);
					const isMetadata = property.startsWith('@');
					if (isMetadata) {
						const isGlobalMetadata = property.startsWith('@@');
						if (isGlobalMetadata) {
							if (property === '@@x-template') {
								inTemplateTag = true;
							}
						} else {
							metadataKey = key;
							metadataLevel = nestingLevel;
						}
					} else {
						messageKey = key;
					}
				}
				if (metadataLevel === nestingLevel - 1 && property === 'placeholders') {
					placeholderLevel = nestingLevel;
				}
			},
			onLiteralValue: (value: any, offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				if (inTemplateTag) {
					templatePath = value;
					inTemplateTag = false;
				} else if (typeof value === 'string' && nestingLevel === 1 && messageKey !== null) {
					try {
						const rawValue = document.substring(offset + 1, offset + length - 1);
						const message = parseMessage(StringLiteral.build(rawValue, value), offset, false);
						messages.push(new MessageEntry(messageKey!, message));
					} catch (error: any) {
						//Very hacky solution to catch all errors here and store them, but better than not checking at all... The error has no special type, unfortunately.
						if (String(error).startsWith('Error: Unbalanced ')) {
							errors.push(new Literal(String(error), offset + 1, offset + length - 1));
						} else {
							throw error;
						}
					}
					messageKey.endOfMessage = offset + length;
				}
			},
			onObjectEnd: (offset: number, length: number, startLine: number, startCharacter: number) => {
				nestingLevel--;
				if (placeholderLevel !== null && nestingLevel === placeholderLevel + 1) {
					definedPlaceholders[definedPlaceholders.length - 1].objectEnd = offset + length;
				}
				if (placeholderLevel !== null && nestingLevel === placeholderLevel) {
					totalPlaceholderEnd = offset + length - 1;
				}
				if (metadataLevel !== null && nestingLevel <= metadataLevel) {
					metadataLevel = -1;
					metadata.push(new MessageEntry(metadataKey!, new Metadata([...definedPlaceholders], offset, totalPlaceholderEnd ?? undefined)));
					totalPlaceholderEnd = null;
					definedPlaceholders = [];
					metadataKey = null;
				}
			},
		}, { disallowComments: true });


		function parseMessage(messageString: StringLiteral, globalOffset: number, expectPlaceholder: boolean): Message {
			const vals = matchCurlyBrackets(messageString, l10nOptions);

			if (vals.length === 0) {
				if (expectPlaceholder) {
					return new Placeholder(messageString.parsed, globalOffset, globalOffset + messageString.raw.length);
				} else {
					return new Literal(messageString.parsed, globalOffset, globalOffset + messageString.raw.length);
				}
			}
			const submessages: Message[] = [];
			for (const part of vals) {
				const isSubmessage = part.name === 'content';
				const isString = part.name === 'outside';
				if (isSubmessage || isString) {
					if (isSubmessage && part.parsed.includes(',')) {
						submessages.push(parseComplexMessage(part));
					} else {
						submessages.push(parseMessage(part, globalOffset + part.rawStart + 1, isSubmessage));
					}
				}
			}

			if (submessages.length > 1) {
				return new CombinedMessage(globalOffset, globalOffset + messageString.raw.length, submessages);
			} else {
				return submessages[0];
			}

			/**
			* Decorate ICU Message of type `select`, `plural`, or `gender`
			*/
			function parseComplexMessage(part: MatchRecursiveValueNameMatchStringLiteral): ComplexMessage {
				const submessages = new Map<Literal, Message>();
				const firstComma = part.parsed.indexOf(',');

				const argument = new Literal(
					part.parsed.substring(0, firstComma),
					globalOffset + part.rawStart + 1,
					globalOffset + part.rawStart + part.positions[firstComma] + 1
				);

				let start = firstComma + 1;
				const secondComma = part.parsed.indexOf(',', start);
				let end = secondComma;
				({ start, end } = trim(part.parsed, start, end));
				const complexType = new Literal(
					part.parsed.substring(start, end),
					globalOffset + part.rawStart + part.positions[start] + 1,
					globalOffset + part.rawStart + part.positions[end] + 1
				);
				start = secondComma + 1;
				const bracketedValues = matchCurlyBrackets(part, l10nOptions);
				for (const innerPart of bracketedValues) {
					if (innerPart.name === 'content') {
						end = innerPart.start - 1;
						({ start, end } = trim(part.parsed, start, end));
						let submessagekey = new Literal(
							part.parsed.substring(start, end),
							globalOffset + part.rawStart + part.positions[start] + 1,
							globalOffset + part.rawStart + part.positions[end] + 1
						);
						let message = parseMessage(innerPart, globalOffset + part.rawStart + innerPart.rawStart, false);
						submessages.set(submessagekey, message);
						start = innerPart.end + 1;
					}
				}
				return new ComplexMessage(globalOffset + part.start, globalOffset + part.end, argument, complexType, submessages);
			}

			function trim(text: string, start: number, end: number) {
				while (text.charAt(start) === ' ') {
					start++;
				}
				while (text.charAt(end - 1) === ' ') {
					end--;
				}
				return { start, end };
			}
		}

		return [new MessageList(templatePath, indentation ?? 0, indentationCharacter ?? ' ', messages, metadata), errors];
	}


	private resolveTemplatePath({
		document,
		messageList,
		l10nYamlPath,
		l10nOptions,
	}: {
		document: vscode.TextDocument;
		messageList: MessageList;
	} & L10nYamlPathAndOptions): string | undefined {
		if (messageList.templatePath) {
			return path.isAbsolute(messageList.templatePath)
				? messageList.templatePath
				: path.join(path.dirname(document.uri.fsPath), messageList.templatePath);
		} else if (l10nOptions !== undefined) {
			const templateRootFromOptions = l10nOptions?.['arb-dir'] ?? 'lib/l10n';
			const templatePathFromOptions = l10nOptions?.['template-arb-file'] ?? 'app_en.arb';

			return path.isAbsolute(templatePathFromOptions)
				? templatePathFromOptions
				: path.join(path.dirname(l10nYamlPath), templateRootFromOptions, templatePathFromOptions);
		}
	}

	parseAndDecorate({
		editor,
		decorator,
		diagnostics,
		quickfixes,
	}: ParseAndDecorateOptions): ParseAndDecorateResult {
		let templateMessageList: MessageList | undefined;

		const l10nYamlPath = locateL10nYaml(editor.document.uri.fsPath);
		const l10nOptions = l10nYamlPath
			? parseYaml(l10nYamlPath)
			: undefined;
		const [messageList, errors] = this.parse(editor.document.getText(), l10nOptions)!;

		const templatePath = this.resolveTemplatePath({
			document: editor.document,
			messageList,
			l10nYamlPath: l10nYamlPath!,
			l10nOptions: l10nOptions,
		});

		if (templatePath && templatePath !== editor.document.uri.fsPath) {
			const template = fs.readFileSync(templatePath, "utf8");
			// TODO(mosuem): Allow chaining of template files.
			[templateMessageList,] = this.parse(template, l10nOptions)!;
		}

		const decorations = decorator.decorate(editor, messageList);
		const diags = diagnostics.diagnose(editor, messageList, errors, templateMessageList);
		quickfixes.update(messageList);
		return { messageList, decorations, diagnostics: diags };
	}
}

type L10nYamlPathAndOptions = {
	l10nYamlPath: string;
	l10nOptions: L10nYaml;
} | {
	l10nYamlPath: string | undefined;
	l10nOptions: undefined;
};
interface ParseAndDecorateResult {
	messageList: MessageList;
	decorations: Map<vscode.TextEditorDecorationType, vscode.Range[]>;
	diagnostics: vscode.Diagnostic[];
}
interface ParseAndDecorateOptions {
	editor: vscode.TextEditor;
	decorator: Decorator;
	diagnostics: Diagnostics;
	quickfixes: CodeActions;
}

function matchCurlyBrackets(v: StringLiteral, l10nOptions?: L10nYaml): MatchRecursiveValueNameMatchStringLiteral[] {
	const unescaped = l10nOptions?.['use-escaping'] ?? false
		? getUnescapedRegions(v.parsed) :
		[[0, v.parsed.length]];

	const values: MatchRecursiveValueNameMatchStringLiteral[] = [];
	for (var region of unescaped) {
		const subLiteral = v.sub(region[0], region[1]);
		const newLocal = XRegExp.matchRecursive(subLiteral.parsed, '\\{', '\\}', 'g', {
			valueNames: ['outside', 'leftBracket', 'content', 'rightBracket'],
			unbalanced: 'error'
		});
		values.push(...newLocal.map(l => subLiteral.convertMatch(l)));
	}
	return values;
}

function parseYaml(uri: string): L10nYaml | undefined {
	if (!fs.existsSync(uri)) {
		return;
	}
	const yaml = fs.readFileSync(uri, "utf8");
	return YAML.parse(yaml) as L10nYaml;
}

export function getUnescapedRegions(expression: string): [number, number][] {
	const unEscapedRegions: [number, number][] = [];

	var unEscapedRegionEdge: number | null;
	unEscapedRegionEdge = 0;
	for (let index = 0; index < expression.length; index++) {
		const char = expression[index];
		if (char === "\'") {
			if (index + 1 < expression.length && expression[index + 1] === "\'") {
				index++;
			} else if (unEscapedRegionEdge === null) {
				// We are just exiting an escaped region
				unEscapedRegionEdge = index + 1;
			} else {
				// We are just entering an escaped region
				if (unEscapedRegionEdge < index) {
					unEscapedRegions.push([unEscapedRegionEdge, index]);
				}
				unEscapedRegionEdge = null;
			}
		}
	}
	if (unEscapedRegionEdge !== null) {
		if (unEscapedRegionEdge < expression.length) {
			unEscapedRegions.push([unEscapedRegionEdge, expression.length]);
		}
	} else {
		// Disbling lint to have consistent behavior with `MatchRecursiveValueNameMatch`, which also throws a string.
		// eslint-disable-next-line no-throw-literal
		throw 'Error: Unbalanced escape quotes. To escape a single quote \', prefix it with another single quote.';
	}

	return unEscapedRegions;
}

export class MessageList {
	constructor(
		public templatePath: string | undefined,
		public indentationCount: number, // The number of indentation characters used for indenting, for example 2 spaces or 1 tab
		public indentationCharacter: string, // The indentation character used, most commonly either a space or a tab
		public messageEntries: MessageEntry[],
		public metadataEntries: MessageEntry[],
	) { }

	getPlaceholders(): Literal[] {
		return this.messageEntries.flatMap((messageEntry) => (messageEntry.message as Message).getPlaceholders());
	}

	getIndent(indentLevel?: number): string {
		return this.indentationCharacter.repeat((this.indentationCount ?? 0) * (indentLevel ?? 1));
	}

	getMessageAt(offset: number): Message | null {
		return [...this.messageEntries, ...this.metadataEntries]
			.flatMap((entry) => [entry.key, entry.message])
			.map((message) => message.whereIs(offset))
			.find((whereIs) => whereIs !== null) ?? null;
	}
}

export class MessageEntry {
	constructor(
		public key: Key,
		public message: Message | Metadata,
	) {
		message.parent = this;
	}
}

export class Metadata {
	constructor(
		public placeholders: PlaceholderMetadata[],
		public metadataEnd: number,
		public lastPlaceholderEnd?: number,
		public parent?: MessageEntry,
	) { }

	whereIs(offset: number): Message | null {
		return this.placeholders
			.map((placeholder) => placeholder.whereIs(offset))
			.find((whereIs) => whereIs !== null) ?? null;
	}
}

export abstract class Message {
	constructor(
		public start: number,
		public end: number,
		public parent?: Message | MessageEntry,
	) { }

	abstract getPlaceholders(): Literal[];

	abstract whereIs(offset: number): Message | null;
}

export class Literal extends Message {
	constructor(
		public value: string,
		public start: number,
		public end: number,
		parent?: Message | MessageEntry,
	) {
		super(start, end, parent);
	}

	public toString = (): string => {
		return `Literal(${this.value},${this.start},${this.end})`;
	};

	whereIs(offset: number): Message | null {
		if (this.start <= offset && offset <= this.end) {
			return this;
		} else {
			return null;
		}
	}

	getPlaceholders(): Literal[] {
		return [];
	}
}

export class Key extends Literal {
	getPlaceholders(): Literal[] {
		throw new Error('Method not implemented.');
	}
	endOfMessage?: number;

	constructor(
		value: string,
		start: number,
		end: number,
		parent?: Message | MessageEntry,
	) {
		super(value, start, end, parent);
	}
}

export class CombinedMessage extends Message {
	constructor(
		start: number,
		end: number,
		public parts: Message[],
		parent?: Message | MessageEntry,
	) {
		super(start, end, parent);
		for (const part of parts) {
			part.parent = this;
		}
	}

	getPlaceholders(): Literal[] {
		return this.parts.flatMap((value) => value.getPlaceholders());
	}

	whereIs(offset: number): Message | null {
		if (this.start <= offset && offset <= this.end) {
			return this.parts
				.map((part) => part.whereIs(offset))
				.find((whereIs) => whereIs !== null) ?? this;
		}
		return null;
	}
}

export class ComplexMessage extends Message {
	constructor(
		start: number,
		end: number,
		public argument: Literal,
		public complexType: Literal,
		public messages: Map<Literal, Message>,
		parent?: Message | MessageEntry,
	) {
		super(start, end, parent);
		argument.parent = this;
		complexType.parent = this;
		for (const [_, message] of messages) {
			message.parent = this;
		}
	}

	getPlaceholders(): Literal[] {
		return [this.argument, ...Array.from(this.messages.values()).flatMap((value) => value.getPlaceholders())];
	}

	whereIs(offset: number): Message | null {
		if (this.start <= offset && offset <= this.end) {
			return Array.from(this.messages.entries())
				.flatMap(([literal, message]) => [literal, message])
				.map((part) => part.whereIs(offset))
				.find((whereIs) => whereIs !== null) ?? null;
		}
		return null;
	}
}

export class Placeholder extends Literal {
	constructor(
		value: string,
		start: number,
		end: number,
		parent?: Message | MessageEntry,
	) {
		super(value, start, end, parent);
	}

	getPlaceholders(): Literal[] {
		return [this];
	}

	whereIs(offset: number): Message | null {
		if (this.start <= offset && offset <= this.end) {
			return this;
		} else {
			return null;
		}
	}
}
export class PlaceholderMetadata extends Message {
	constructor(
		public value: string,
		public start: number,
		public end: number,
		parent?: Message | MessageEntry,
	) {
		super(start, end, parent);
	}

	objectEnd: number | undefined;

	public toString = (): string => {
		return `Literal(${this.value},${this.start},${this.end})`;
	};

	whereIs(offset: number): Message | null {
		if (this.start <= offset && offset <= this.end) {
			return this;
		} else {
			return null;
		}
	}

	getPlaceholders(): Literal[] {
		return [];
	}
}

class StringLiteral {
	constructor(
		public raw: string,
		public parsed: string,
		public positions: number[],
	) {
	}

	static build(raw: string, parsed: string): StringLiteral {
		const positions: number[] = [];
		let pos = 0;
		for (let i = 0; i < raw.length; i++) {
			let len = 1;
			if (raw.charAt(i) === '\\') {
				if (++i < raw.length) {
					if (raw.substring(i, i + 5).match(/^u[A-Fa-f0-9]{4}/)) {
						len = 6;
						i += 4;
					}
					else {
						len = 2;
					}
				}
			}
			positions.push(pos);
			pos += len;
		}
		positions.push(pos);
		return new StringLiteral(raw, parsed, positions);
	}

	private slicePositions(start: number, end: number): number[] {
		const offset = this.positions[start];
		return this.positions.slice(start, end + 1).map(v => v - offset);
	}

	public convertMatch(match: XRegExp.MatchRecursiveValueNameMatch): MatchRecursiveValueNameMatchStringLiteral {
		const rawStart = this.positions[match.start];
		const rawEnd = this.positions[match.end];
		return new MatchRecursiveValueNameMatchStringLiteral(
			match.name,
			match.start,
			match.end,
			rawStart,
			rawEnd,
			this.raw.substring(rawStart, rawEnd),
			match.value,
			this.slicePositions(match.start, match.end),
		);
	}

	public sub(start: number, end: number): StringLiteral {
		const rawStart = this.positions[start];
		const rawEnd = this.positions[end];
		return new StringLiteral(
			this.raw.substring(rawStart, rawEnd),
			this.parsed.substring(start, end),
			this.slicePositions(start, end),
		);
	}
}

class MatchRecursiveValueNameMatchStringLiteral extends StringLiteral {
	constructor(
		public name: string,
		public start: number,
		public end: number,
		public rawStart: number,
		public rawEnd: number,
		raw: string,
		parsed: string,
		positions: number[],
	) {
		super(raw, parsed, positions);
	}
}
