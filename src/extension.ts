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
import { visit } from 'jsonc-parser';

module.exports = {
	activate
};

let pendingFooJsonDecoration: NodeJS.Timeout | undefined;

import * as vscode from 'vscode';
import { ConfigurationTarget, workspace } from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// decorate when changing the active editor editor
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor !== undefined) {
			return updateFooJsonDecorations(editor);
		}
	}, null, context.subscriptions));

	// decorate when the document changes
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
			if (pendingFooJsonDecoration) {
				clearTimeout(pendingFooJsonDecoration);
			}
			const activeTextEditor = vscode.window.activeTextEditor;
			if (activeTextEditor !== undefined) {
				pendingFooJsonDecoration = setTimeout(() => updateFooJsonDecorations(activeTextEditor), 1000);
			}
		}
	}, null, context.subscriptions));

	// decorate the active editor now
	const activeTextEditor = vscode.window.activeTextEditor;
	if (activeTextEditor !== undefined) {
		updateFooJsonDecorations(activeTextEditor);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

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

const selectRegex = /^(\w+\s*,\s*select\s*,(?:\s*\w+\{.*\})*)$/g;
const pluralRegex = /^(\w+\s*,\s*plural\s*,(?:\s*\w+\{.*\})*)$/g;
function updateFooJsonDecorations(editor: vscode.TextEditor) {
	if (!editor || !path.basename(editor.document.fileName).endsWith('.arb')) {
		return;
	}
	let colorMap = new Map<string, vscode.Range[]>();
	visit(editor.document.getText(), {
		onLiteralValue: (value: string, offset: number) => {
			let openBrackets: number[] = [];
			for (let index = 0; index < value.length; index++) {
				const char = value.charAt(index);
				if (char === '{') {
					openBrackets.push(index);
				} else if (char === '}') {
					let start = openBrackets.pop() ?? 0;
					let end = index;
					const part = value.substring(start + 1, end);
					const level = openBrackets.length;
					const decoration = parse(part, level);
					if (decoration !== undefined) {
						const rangeStart = offset + start + 1;
						const rangeEnd = offset + end + 2;
						colorMap.set(decoration, [...(colorMap.get(decoration) ?? []), new vscode.Range(editor.document.positionAt(rangeStart), editor.document.positionAt(rangeEnd))]);
					}
				}
			}
		}
	});
	editor.setDecorations(pluralDecoration, colorMap.get('plural') ?? []);
	editor.setDecorations(selectDecoration, colorMap.get('select') ?? []);
	editor.setDecorations(argDecoration, colorMap.get('arg') ?? []);
}

function parse(value: string, level: number): string | undefined {
	if (selectRegex.exec(value) !== null) {
		return 'select';
	} else if (pluralRegex.exec(value) !== null) {
		return 'plural';
	} else {
		return 'arg';
	}
}