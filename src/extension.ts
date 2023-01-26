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

import * as vscode from 'vscode';
import { DecoratorAndParser } from './parseAndDecorate';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const decoratorAndParser = new DecoratorAndParser(context);

	// decorate when changing the active editor editor
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor !== undefined) {
			return decoratorAndParser.parseAndDecorate(editor);
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
				pendingDecorations = setTimeout(() => decoratorAndParser.parseAndDecorate(activeTextEditor), 500);
			}
		}
	}, null, context.subscriptions));

	// decorate the active editor now
	const activeTextEditor = vscode.window.activeTextEditor;
	if (activeTextEditor !== undefined) {
		decoratorAndParser.parseAndDecorate(activeTextEditor);
	}


	// At extension startup
}

// This method is called when your extension is deactivated
export function deactivate() { }
