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


module.exports = {
	activate
};

let pendingDecorations: NodeJS.Timeout | undefined;

import path = require('path');
import * as vscode from 'vscode';
import { Decorator as Decorator } from './decorate';
import { Diagnostics } from './diagnose';
import { Parser, StringMessage } from './messageParser';
const snippetsJson = require("../snippets/snippets.json");
const snippetsInlineJson = require("../snippets/snippets_inline.json");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const decorator = new Decorator();
	const diagnostics = new Diagnostics(context);
	const parser = new Parser();

	// decorate the active editor now
	const activeTextEditor = vscode.window.activeTextEditor;

	// Only trigger on arb files
	if (!activeTextEditor || !path.basename(activeTextEditor.document.fileName).endsWith('.arb')) {
		return;
	}

	let [messageList, errors] = parser.parse(activeTextEditor.document.getText())!;

	// decorate when changing the active editor editor
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor !== undefined) {
			decorator.decorate(editor, messageList);
			diagnostics.diagnose(editor, messageList, errors);
		}
	}, null, context.subscriptions));

	// decorate when the document changes
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
			if (pendingDecorations) {
				clearTimeout(pendingDecorations);
			}
			const activeTextEditor = vscode.window.activeTextEditor;
			if (activeTextEditor !== undefined) {
				pendingDecorations = setTimeout(() => {
					[messageList, errors] = parser.parse(activeTextEditor.document.getText())!;
					decorator.decorate(activeTextEditor, messageList);
					diagnostics.diagnose(activeTextEditor, messageList, errors);
				}, 500);
			}
		}
	}, null, context.subscriptions));

	// Make the snippets available in arb files
	const completions = getSnippets(snippetsJson);
	const completionsStringInline = getSnippets(snippetsInlineJson);
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
		{ language: 'json', pattern: `**/*.arb` },
		{
			provideCompletionItems(document, position, token, context) {
				const messageTypeAtCursor = messageList.getMessageAt(document.offsetAt(position));

				if (messageTypeAtCursor instanceof StringMessage) {
					return completionsStringInline;
				} else {
					return completions;
				}

			}
		},
	));

	if (activeTextEditor !== undefined) {
		decorator.decorate(activeTextEditor, messageList);
		diagnostics.diagnose(activeTextEditor, messageList, errors);
	}

	// At extension startup
}

function getSnippets(snippetsJson: any): vscode.CompletionList {
	const completions = new vscode.CompletionList();
	const snippets = snippetsJson as { [key: string]: { prefix: string; description: string; body: string[]; }; };
	for (const snippetType of Object.keys(snippets)) {
		const snippet = snippets[snippetType];

		const completionItem = new vscode.CompletionItem(snippet.prefix, vscode.CompletionItemKind.Snippet);
		completionItem.filterText = snippet.prefix;
		completionItem.insertText = new vscode.SnippetString(
			Array.isArray(snippet.body)
				? snippet.body.join("\n")
				: snippet.body
		);
		completionItem.detail = snippet.description;
		completions.items.push(completionItem);
	}
	return completions;
}

// This method is called when your extension is deactivated
export function deactivate() { }

