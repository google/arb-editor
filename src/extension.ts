/* eslint-disable @typescript-eslint/naming-convention */
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
import { CodeActions } from './codeactions';
import { Decorator } from './decorate';
import { Diagnostics } from './diagnose';
import { Literal, MessageList, Parser } from './messageParser';
import { locateL10nYaml } from './project';
import YAML = require('yaml');
import fs = require('fs');
const snippetsJson = require("../snippets/snippets.json");
const snippetsInlineJson = require("../snippets/snippets_inline.json");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const decorator = new Decorator();
	const diagnostics = new Diagnostics(context);
	const parser = new Parser();
	const quickfixes = new CodeActions();
	let commonMessageList: MessageList | undefined;

	// decorate when changing the active editor editor
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => handleFile(editor), null, context.subscriptions));

	// decorate when the document changes
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => handleFile(vscode.window.activeTextEditor, true), null, context.subscriptions));

	const filePattern = { language: 'json', pattern: `**/*.arb` };
	// add quickfixes for diagnostics
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			filePattern,
			quickfixes,
			{
				providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
			},
		),
	);

	// Make the snippets available in arb files
	const completions = getSnippets(snippetsJson);
	const completionsStringInline = getSnippets(snippetsInlineJson);
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			filePattern,
			{
				provideCompletionItems(document, position, token, context) {
					const messageTypeAtCursor = commonMessageList?.getMessageAt(document.offsetAt(position));
					if (messageTypeAtCursor instanceof Literal) {
						return completionsStringInline;
					} else {
						return completions;
					}

				}
			},
		),
	);

	// decorate the active editor now
	handleFile(vscode.window.activeTextEditor);

	function handleFile(editor: vscode.TextEditor | undefined, executeDelayed: boolean = false) {
		if (!editor || isNotArbFile(editor.document)) {
			return;
		}
		var l10nYamlPath = locateL10nYaml(editor.document.uri.fsPath);
		console.log(`${l10nYamlPath}`);
		var l10nOptions: L10nYaml | undefined;
		if (l10nYamlPath) {
			l10nOptions = parseYaml(l10nYamlPath);
		}

		if (executeDelayed && pendingDecorations) {
			clearTimeout(pendingDecorations);
		}
		if (editor) {
			if (executeDelayed) {
				pendingDecorations = setTimeout(() => commonMessageList = parseAndDecorate(), 250);
			} else {
				commonMessageList = parseAndDecorate();
			}
		}

		function parseAndDecorate(): MessageList {
			let [messageList, errors] = parser.parse(editor!.document.getText(), l10nOptions)!;
			decorator.decorate(editor!, messageList);
			diagnostics.diagnose(editor!, messageList, errors);
			quickfixes.update(messageList);
			return messageList;
		}
	}
}

function isNotArbFile(document: vscode.TextDocument): boolean {
	return document.languageId !== 'arb' && !path.basename(document.fileName).endsWith('.arb');
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

function parseYaml(uri: string): L10nYaml | undefined {
	if (!fs.existsSync(uri)) {
		return;
	}
	const yaml = fs.readFileSync(uri, "utf8");
	return YAML.parse(yaml) as L10nYaml;
}

export interface L10nYaml {
	'arb-dir'?: string | undefined;
	'output-dir'?: string | undefined;
	'template-arb-file'?: string | undefined;
	'output-localization-file'?: string | undefined;
	'untranslated-messages-file'?: string | undefined;
	'output-class'?: string | undefined;
	'preferred-supported-locales'?: string | undefined;
	'header'?: string | undefined;
	'header-file'?: string | undefined;
	'use-deferred-loading'?: boolean | undefined;
	'gen-inputs-and-outputs-list'?: string | undefined;
	'synthetic-package'?: string | undefined;
	'project-dir'?: string | undefined;
	'required-resource-attributes'?: boolean | undefined;
	'nullable-getter'?: boolean | undefined;
	'format'?: boolean | undefined;
	'use-escaping'?: string | undefined;
	'suppress-warnings'?: boolean | undefined;
}