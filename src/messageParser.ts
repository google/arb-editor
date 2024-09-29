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
			onLiteralValue: (value: any, offset: number) => {
				if (inTemplateTag) {
					templatePath = value;
					inTemplateTag = false;
				} else if (nestingLevel === 1 && messageKey !== null) {
					try {
						var message = parseMessage(value, offset, false);
						messages.push(new MessageEntry(messageKey!, message));
					} catch (error: any) {
						//Very hacky solution to catch all errors here and store them, but better than not checking at all... The error has no special type, unfortunately.
						if (String(error).startsWith('Error: Unbalanced ')) {
							errors.push(new Literal(String(error), offset + 1, offset + value.length + 1));
						} else {
							throw error;
						}
					}
					messageKey.endOfMessage = offset + value.length + 2;
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


		function parseMessage(messageString: string, globalOffset: number, expectPlaceholder: boolean): Message {
			const vals = matchCurlyBrackets(messageString, l10nOptions);

			if (vals.length === 0) {
				if (expectPlaceholder) {
					return new Placeholder(messageString, globalOffset, globalOffset + messageString.length);
				} else {
					return new Literal(messageString, globalOffset, globalOffset + messageString.length);
				}
			}
			const submessages: Message[] = [];
			for (const part of vals) {
				const isSubmessage = part.name === 'content';
				const isString = part.name === 'outside';
				if (isSubmessage || isString) {
					if (isSubmessage && part.value.includes(',')) {
						submessages.push(parseComplexMessage(part));
					} else {
						submessages.push(parseMessage(part.value, globalOffset + part.start + 1, isSubmessage));
					}
				}
			}

			if (submessages.length > 1) {
				return new CombinedMessage(globalOffset, globalOffset + messageString.length, submessages);
			} else {
				return submessages[0];
			}

			/**
			* Decorate ICU Message of type `select`, `plural`, or `gender`
			*/
			function parseComplexMessage(part: XRegExp.MatchRecursiveValueNameMatch): ComplexMessage {
				const submessages = new Map<Literal, Message>();
				const firstComma = part.value.indexOf(',');
				var start = globalOffset + part.start + 1;
				var end = globalOffset + part.start + firstComma + 1;

				const argument = new Literal(part.value.substring(0, firstComma), start, end);

				start = firstComma + 1;
				const secondComma = part.value.indexOf(',', start);
				end = secondComma;
				({ start, end } = trim(part.value, start, end));
				const complexType = new Literal(part.value.substring(start, end), globalOffset + part.start + start + 1, globalOffset + part.start + end + 1);
				start = secondComma + 1;
				const bracketedValues = matchCurlyBrackets(part.value, l10nOptions);
				for (const innerPart of bracketedValues) {
					if (innerPart.name === 'content') {
						end = innerPart.start - 1;
						({ start, end } = trim(part.value, start, end));
						var submessagekey = new Literal(part.value.substring(start, end), globalOffset + part.start + start + 1, globalOffset + part.start + end + 1);
						var message = parseMessage(innerPart.value, globalOffset + part.start + innerPart.start, false);
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

function matchCurlyBrackets(v: string, l10nOptions?: L10nYaml): XRegExp.MatchRecursiveValueNameMatch[] {
	const unescaped = getUnescapedRegions(v, l10nOptions);
	var values: XRegExp.MatchRecursiveValueNameMatch[] = [];
	for (var region of unescaped) {
		const newLocal = XRegExp.matchRecursive(v.substring(region[0], region[1]), '\\{', '\\}', 'g', {
			valueNames: ['outside', 'leftBracket', 'content', 'rightBracket'],
			unbalanced: 'error'
		});
		values.push(...newLocal);
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

export function getUnescapedRegions(expression: string, l10nOptions?: L10nYaml): [number, number][] {
	const unEscapedRegions: [number, number][] = [];

	if (!(l10nOptions?.['use-escaping'] ?? true)) {
		return [[0, expression.length]];
	}

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
