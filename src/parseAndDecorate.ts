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
import path = require('path');
import { JSONPath, visit } from 'jsonc-parser';
import * as vscode from 'vscode';
import XRegExp = require('xregexp');

export const placeholderDecoration = vscode.window.createTextEditorDecorationType({
	light: {
		color: '#ff6f00'
	},
	dark: {
		color: '#fff9c4'
	}
});
export const selectDecoration = vscode.window.createTextEditorDecorationType({
	light: {
		color: '#6a1b9a'
	},
	dark: {
		color: '#ce93d8'
	}
});
export const pluralDecoration = vscode.window.createTextEditorDecorationType({
	light: {
		color: '#0277bd'
	},
	dark: {
		color: '#b3e5fc'
	}
});

const selectRegex = /^([^\{\}]+\s*,\s*(?:select|gender)\s*,\s*(?:[^\{\}]*\w+\{.*\})*)$/;
const pluralRegex = /^[^\{\}]+\s*,\s*plural\s*,\s*(?:offset:\d+)?\s*(?:[^\{\} ]*?\s*\{.*\})$/;
const placeholderNameRegex = /^[a-zA-Z][a-zA-Z_$0-9]*$/; //Must be able to translate to a (non-private) Dart variable
const keyNameRegex = /^[a-zA-Z][a-zA-Z_0-9]*$/; //Must be able to translate to a (non-private) Dart method

class Literal {
	constructor(
		public value: string,
		public start: number,
		public end: number
	) { }

	public toString = (): string => {
		return `Literal(${this.value},${this.start},${this.end})`;
	};
}
export class DecoratorAndParser {
	diagnostics = vscode.languages.createDiagnosticCollection("arb");

	constructor(context?: vscode.ExtensionContext) {
		context?.subscriptions.push(this.diagnostics);
	}

	parseAndDecorate(editor: vscode.TextEditor): { diagnostics: vscode.Diagnostic[]; decorations: Map<vscode.TextEditorDecorationType, vscode.Range[]>; } | null {
		// Prefill decorations map to avoid having old decoration hanging around
		let decorationsMap = new Map<vscode.TextEditorDecorationType, vscode.Range[]>([
			[placeholderDecoration, []],
			[selectDecoration, []],
			[pluralDecoration, []],
		]);
		let diagnosticsList: vscode.Diagnostic[] = [];

		// Map of arguments for each message key
		let placeHoldersForKey = new Map<String, Literal[]>();

		// Only trigger on arb files
		if (!editor || !path.basename(editor.document.fileName).endsWith('.arb')) {
			return null;
		}
		let nestingLevel = 0;
		let placeholderLevel: number | null;
		let metadataLevel: number | null;
		let messageKey: string | null;
		let definedPlaceholders: string[] = [];
		visit(editor.document.getText(), {
			onLiteralValue: (value: string, offset: number) => {
				if (nestingLevel === 1) {
					try {
						decorateMessage(value, offset, decorationsMap, editor, true);
					} catch (error: any) {
						if (String(error).startsWith('Error: Unbalanced ')) {//Very hacky, but better than not checking at all... The error has no special type, unfortunately.
							showErrorAt(offset + 1, offset + value.length + 1, 'Unbalanced curly bracket found. Try escaping the bracket using a single quote \' .', vscode.DiagnosticSeverity.Error);
						} else {
							throw error;
						}
					}
				}
			},
			onObjectBegin: (offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				nestingLevel++;
			},
			onObjectProperty: (property: string, offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				if (placeholderLevel === nestingLevel - 1) {
					if (!placeHoldersForKey.get(messageKey!)!.some((literal: Literal, index: number, array: Literal[]) => literal.value === property)) {
						showErrorAt(offset + 1, offset + property.length + 1, `Placeholder "${property}" is being declared, but not used in message.`, vscode.DiagnosticSeverity.Warning);
					}
					definedPlaceholders.push(property);
					decorateAt(offset + 1, offset + property.length + 1, placeholderDecoration);
				}
				if (nestingLevel === 1) {
					const isMetadata = property.startsWith('@');
					const propertyOffsetEnd = offset + property.length + 1;
					const propertyOffsetStart = offset + 1;
					if (isMetadata) {
						const isGlobalMetadata = property.startsWith('@@');
						const messageKeyExists = placeHoldersForKey.has(property.substring(1));
						if (!isGlobalMetadata && !messageKeyExists) {
							showErrorAt(propertyOffsetStart, propertyOffsetEnd, `Metadata for an undefined key. Add a message key with the name "${property.substring(1)}".`, vscode.DiagnosticSeverity.Error);
						}
						metadataLevel = nestingLevel;
					} else {
						if (keyNameRegex.exec(property) !== null) {
							messageKey = property;
							placeHoldersForKey.set(messageKey, []);
						} else {
							showErrorAt(propertyOffsetStart, propertyOffsetEnd, `Key "${property}" is not a valid message key.`, vscode.DiagnosticSeverity.Error);
						}
					}
				}
				if (metadataLevel === nestingLevel - 1 && property === 'placeholders') {
					placeholderLevel = nestingLevel;
				}
			},
			onObjectEnd: (offset: number, length: number, startLine: number, startCharacter: number) => {
				nestingLevel--;
				if (placeholderLevel !== null && nestingLevel < placeholderLevel) {
					placeholderLevel = null;
					for (const placeholder of placeHoldersForKey.get(messageKey!)!) {
						if (!definedPlaceholders.includes(placeholder.value)) {
							showErrorAt(placeholder.start, placeholder.end, `Placeholder "${placeholder.value}" not defined in the message metadata.`, vscode.DiagnosticSeverity.Warning);
						}
					}
					definedPlaceholders = [];
				}
				if (metadataLevel !== null && nestingLevel < metadataLevel) {
					metadataLevel = -1;
				}
			},
		}, { disallowComments: true });


		this.diagnostics.set(editor.document.uri, diagnosticsList);
		decorationsMap.forEach((value: vscode.Range[], key: vscode.TextEditorDecorationType) => {
			editor.setDecorations(key, value);
		});

		function decorateMessage(messageString: string, globalOffset: number, colorMap: Map<vscode.TextEditorDecorationType, vscode.Range[]>, editor: vscode.TextEditor, isOuter: boolean): void {
			const vals = matchCurlyBrackets(messageString);
			for (const part of vals) {
				let localOffset = messageString.indexOf('{' + part + '}');
				if (selectRegex.exec(part) !== null) {
					decorateComplexMessage(selectDecoration, part, localOffset);
				} else if (pluralRegex.exec(part) !== null) {
					decorateComplexMessage(pluralDecoration, part, localOffset);
				} else {
					const partOffset = globalOffset + localOffset + 2;
					const partOffsetEnd = globalOffset + localOffset + part.length + 2;
					if (isOuter) {
						validateAndAddPlaceholder(part, partOffset, partOffsetEnd);
					} else {
						decorateMessage(part, partOffset - 1, colorMap, editor, true);
					}
				}
			}

			/**
			* Decorate ICU Message of type `select`, `plural`, or `gender`
			*/
			function decorateComplexMessage(decoration: vscode.TextEditorDecorationType, complexString: string, localOffset: number): void {
				const firstComma = complexString.indexOf(',');
				const start = globalOffset + localOffset + 2;
				const end = globalOffset + localOffset + firstComma + 2;
				validateAndAddPlaceholder(complexString.substring(0, firstComma), start, end);
				const bracketedValues = matchCurlyBrackets(complexString);
				const secondComma = complexString.indexOf(',', firstComma + 1);
				localOffset = localOffset + secondComma + 1;
				for (const part of bracketedValues) {
					const partWithBrackets = '{' + part + '}';
					const indexOfPartInMessage = messageString.indexOf(partWithBrackets, localOffset);
					decorateAt(globalOffset + localOffset + 2, globalOffset + indexOfPartInMessage + 1, decoration);
					localOffset = indexOfPartInMessage + partWithBrackets.length;

					decorateMessage(partWithBrackets, globalOffset + indexOfPartInMessage, colorMap, editor, false);
				}
			}
		}

		function validateAndAddPlaceholder(part: string, partOffset: number, partOffsetEnd: number) {
			if (placeholderNameRegex.exec(part) !== null) {
				placeHoldersForKey.get(messageKey!)!.push(new Literal(part, partOffset, partOffsetEnd));
				decorateAt(partOffset, partOffsetEnd, placeholderDecoration);
			} else {
				showErrorAt(partOffset, partOffsetEnd, `"${part}" is not a valid placeholder name.`, vscode.DiagnosticSeverity.Error);
			}
		}

		function decorateAt(start: number, end: number, decoration: vscode.TextEditorDecorationType): void {
			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			decorationsMap.get(decoration)!.push(range);
		}

		function showErrorAt(start: number, end: number, errorMessage: string, severity: vscode.DiagnosticSeverity) {
			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			diagnosticsList.push(new vscode.Diagnostic(range, errorMessage, severity));
		}

		return { diagnostics: diagnosticsList, decorations: decorationsMap };
	}
}
function matchCurlyBrackets(value: string) {
	return XRegExp.matchRecursive(value, '\\{', '\\}', 'g', {
		escapeChar: '\'',
		unbalanced: 'error'
	});
}