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
export function updateIcuMessageDecorations(editor: vscode.TextEditor) {
	let colorMap = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
	if (!editor || !path.basename(editor.document.fileName).endsWith('.arb')) {
		return;
	}
	let currentLevel = 0;
	let isInPlaceholders = -1;
	let isInMetadata = -1;
	visit(editor.document.getText(), {
		onLiteralValue: (value: string, offset: number) => {
			colorPart(value, offset, colorMap, editor, true);
		},
		onObjectBegin: (offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
			currentLevel++;
		},
		onObjectProperty: (property: string, offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
			if (isInPlaceholders === currentLevel - 1) {
				const rangeStart = offset + 1;
				const rangeEnd = offset + property.length + 1;
				const range = new vscode.Range(editor.document.positionAt(rangeStart), editor.document.positionAt(rangeEnd));
				colorMap.set(argDecoration, [...(colorMap.get(argDecoration) ?? []), range]);
			}
			if (property.startsWith('@')) {
				isInMetadata = currentLevel;
			}
			if (isInMetadata === currentLevel - 1 && property === 'placeholders') {
				isInPlaceholders = currentLevel;
			}
		},
		onObjectEnd: (offset: number, length: number, startLine: number, startCharacter: number) => {
			currentLevel--;
			if (currentLevel < isInPlaceholders) {
				isInPlaceholders = -1;
			}
			if (currentLevel < isInMetadata) {
				isInMetadata = -1;
			}
		},
	}, { disallowComments: true });
	colorMap.forEach((value: vscode.Range[], key: vscode.TextEditorDecorationType) => {
		editor.setDecorations(key, value ?? []);
	});
}
function colorPart(value: string, offset: number, colorMap: Map<vscode.TextEditorDecorationType, vscode.Range[]>, editor: vscode.TextEditor, isOuter: boolean) {
	const vals = XRegExp.matchRecursive(value, '\\{', '\\}', 'g', {
		escapeChar: '\''
	});
	for (const part of vals) {
		let start = value.indexOf('{' + part + '}');
		if (selectRegex.exec(part) !== null) {
			start = colorComplex(selectDecoration, part, start);
		} else if (pluralRegex.exec(part) !== null) {
			start = colorComplex(pluralDecoration, part, start);
		} else {
			if (isOuter) {
				if (argNameRegex.exec(part) !== null) {
					colorFromTo(offset, start, start + part.length, argDecoration);
				}
			} else {
				colorPart(part, offset + start + 1, colorMap, editor, true);
			}
		}
	}

	function colorComplex(decoration: vscode.TextEditorDecorationType, part: string, start: number) {
		const firstComma = part.indexOf(',');
		colorFromTo(offset, start, start + firstComma, argDecoration);
		const innerVals = XRegExp.matchRecursive(part, '\\{', '\\}', 'g');
		const secondComma = part.indexOf(',', firstComma + 1);
		start = start + secondComma + 1;
		for (const innerpart of innerVals) {
			const innerString = '{' + innerpart + '}';
			const indexOfInnerInOuter = value.indexOf(innerString, start);
			colorFromTo(offset, start, indexOfInnerInOuter - 1, decoration);
			start = indexOfInnerInOuter + innerString.length;

			colorPart(innerString, offset + indexOfInnerInOuter, colorMap, editor, false);
		}
		return start;
	}

	function colorFromTo(offset: number, start: number, end: number, decoration: vscode.TextEditorDecorationType) {
		const rangeStart = offset + start + 2;
		const rangeEnd = offset + end + 2;
		const range = new vscode.Range(editor.document.positionAt(rangeStart), editor.document.positionAt(rangeEnd));
		colorMap.set(decoration, [...(colorMap.get(decoration) ?? []), range]);
	}
}
