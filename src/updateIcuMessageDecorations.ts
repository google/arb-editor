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

export const diagnostics = vscode.languages.createDiagnosticCollection("arb");

const argDecoration = vscode.window.createTextEditorDecorationType({
	light: {
		color: '#ff6f00'
	},
	dark: {
		color: '#fff9c4'
	}
});
const selectDecoration = vscode.window.createTextEditorDecorationType({
	light: {
		color: '#6a1b9a'
	},
	dark: {
		color: '#ce93d8'
	}
});
const pluralDecoration = vscode.window.createTextEditorDecorationType({
	light: {
		color: '#0277bd'
	},
	dark: {
		color: '#b3e5fc'
	}
});

const selectRegex = /^(\w+\s*,\s*select\s*,(?:\s*\w+\{.*\})*)$/;
const pluralRegex = /^(\w+\s*,\s*plural\s*,(?:\s*\w+\{.*\})*)$/;
const argNameRegex = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;

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

export function updateIcuMessageDecorations(editor: vscode.TextEditor) {
	// Prefill color map to avoid having old decoration hanging around
	let colorMap = new Map<vscode.TextEditorDecorationType, vscode.Range[]>([
		[argDecoration, []],
		[selectDecoration, []],
		[pluralDecoration, []],
	]);
	// Clear diagnostics
	diagnostics.set(editor.document.uri, []);
	let diagnosticsList: vscode.Diagnostic[] = [];

	// Map of arguments for each
	let argMap = new Map<String, Literal[]>();

	// Only trigger on arb files
	if (!editor || !path.basename(editor.document.fileName).endsWith('.arb')) {
		return;
	}
	let nestingLevel = 0;
	let isInPlaceholders = -1;
	let isInMetadata = -1;
	let currentKey: string | null;
	let currentlyDefinedPlaceholders: string[] = [];
	visit(editor.document.getText(), {
		onLiteralValue: (value: string, offset: number) => {
			if (nestingLevel === 1) {
				try {
					colorPart(value, offset, colorMap, editor, true);
				} catch (error) {
					showErrorAt(offset + 1, offset + value.length + 1, String(error) + '. Try escaping the bracket using a single quote \' .', vscode.DiagnosticSeverity.Error);
				}
			}
		},
		onObjectBegin: (offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
			nestingLevel++;
		},
		onObjectProperty: (property: string, offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
			if (isInPlaceholders === nestingLevel - 1) {
				console.log('Checking if ' + property + ' for ' + currentKey + ': ' + argMap.get(currentKey!));
				if (!argMap.get(currentKey!)!.some((literal: Literal, index: number, array: Literal[]) => literal.value === property)) {
					showErrorAt(offset + 1, offset + property.length + 1, 'Placeholder is being declared, but not used in message.', vscode.DiagnosticSeverity.Warning);
				}
				currentlyDefinedPlaceholders.push(property);
				colorFromTo(offset + 1, offset + property.length + 1, argDecoration);
			}
			if (nestingLevel === 1) {
				if (property.startsWith('@')) {
					if (!property.startsWith('@@') && !argMap.has(property.substring(1))) {
						showErrorAt(offset + 1, offset + property.length + 1, 'Metadata for an undefined key.', vscode.DiagnosticSeverity.Error);
					}
					isInMetadata = nestingLevel;
				} else {
					currentKey = property;
					argMap.set(property, []);
				}
			}
			if (isInMetadata === nestingLevel - 1 && property === 'placeholders') {
				isInPlaceholders = nestingLevel;
			}
		},
		onObjectEnd: (offset: number, length: number, startLine: number, startCharacter: number) => {
			nestingLevel--;
			if (nestingLevel < isInPlaceholders) {
				isInPlaceholders = -1;
				for (const placeholder of argMap.get(currentKey!)!) {
					if(!currentlyDefinedPlaceholders.includes(placeholder.value)){
						showErrorAt(placeholder.start, placeholder.end, 'Placeholder not defined in the message metadata.', vscode.DiagnosticSeverity.Warning);
					}
				}
				currentlyDefinedPlaceholders = [];
			}
			if (nestingLevel < isInMetadata) {
				isInMetadata = -1;
			}
		},
	}, { disallowComments: true });
	diagnostics.set(editor.document.uri, diagnosticsList);
	colorMap.forEach((value: vscode.Range[], key: vscode.TextEditorDecorationType) => {
		editor.setDecorations(key, value);
	});

	function showErrorAt(start: number, end: number, errorMessage: string, severity: vscode.DiagnosticSeverity) {
		const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
		diagnosticsList.push(new vscode.Diagnostic(range, errorMessage, severity));
	}

	function colorPart(value: string, offset: number, colorMap: Map<vscode.TextEditorDecorationType, vscode.Range[]>, editor: vscode.TextEditor, isOuter: boolean) {
		const vals = matchCurlyBrackets(value);
		for (const part of vals) {
			let start = value.indexOf('{' + part + '}');
			if (selectRegex.exec(part) !== null) {
				start = colorComplex(selectDecoration, part, start);
			} else if (pluralRegex.exec(part) !== null) {
				start = colorComplex(pluralDecoration, part, start);
			} else {
				const partOffset = offset + start + 2;
				const partOffsetEnd = offset + start + part.length + 2;
				if (isOuter) {
					if (argNameRegex.exec(part) !== null) {
						console.log('Adding ' + part + ' to ' + currentKey);
						argMap.get(currentKey!)?.push(new Literal(part, partOffset, partOffsetEnd));
						colorFromTo(partOffset, partOffsetEnd, argDecoration);
					} else {
						showErrorAt(partOffset, partOffsetEnd, 'This is not a valid argument name.', vscode.DiagnosticSeverity.Error);
					}
				} else {
					colorPart(part, partOffset - 1, colorMap, editor, true);
				}
			}
		}

		function colorComplex(decoration: vscode.TextEditorDecorationType, part: string, innerOffset: number) {
			const firstComma = part.indexOf(',');
			const start = offset + innerOffset + 2;
			const end = offset + innerOffset + firstComma + 2;
			console.log(innerOffset + ': ' + part);
			argMap.get(currentKey!)!.push(new Literal(part.substring(0, firstComma), start, end));
			colorFromTo(start, end, argDecoration);
			const innerVals = matchCurlyBrackets(part);
			const secondComma = part.indexOf(',', firstComma + 1);
			innerOffset = innerOffset + secondComma + 1;
			for (const innerpart of innerVals) {
				const innerString = '{' + innerpart + '}';
				const indexOfInnerInOuter = value.indexOf(innerString, innerOffset);
				colorFromTo(offset + innerOffset + 2, offset + indexOfInnerInOuter + 1, decoration);
				innerOffset = indexOfInnerInOuter + innerString.length;

				colorPart(innerString, offset + indexOfInnerInOuter, colorMap, editor, false);
			}
			return innerOffset;
		}
	}

	function colorFromTo(start: number, end: number, decoration: vscode.TextEditorDecorationType) {
		const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
		colorMap.set(decoration, [...(colorMap.get(decoration) ?? []), range]);
	}

}
function matchCurlyBrackets(value: string) {
	return XRegExp.matchRecursive(value, '\\{', '\\}', 'g', {
		escapeChar: '\'',
		unbalanced: 'error'
	});
}

