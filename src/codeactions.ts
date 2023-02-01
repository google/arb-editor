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
import { DiagnosticCode } from './diagnose';
import { Key, MessageList } from './messageParser';


export class CodeActions implements vscode.CodeActionProvider {
	messageList: MessageList | undefined;

	update(messageList: MessageList) {
		this.messageList = messageList;
	}

	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix
	];

	provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
		// for each diagnostic entry that has the matching `code`, create a code action command
		return context.diagnostics
			.filter(diagnostic => diagnostic.code === DiagnosticCode.missingMetadataForKey)
			.map(diagnostic => this.createMetadataForKey(document, diagnostic, range))
			.filter(codeAction => codeAction instanceof vscode.CodeAction);
	}

	private createMetadataForKey(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, range: vscode.Range | vscode.Selection): vscode.CodeAction {
		const message = this.messageList?.getMessageAt(document.offsetAt(range.start)) as Key;
		console.log(message.endOfMessage);

		const fix = new vscode.CodeAction(`Add metadata for key '${message.value}'`, vscode.CodeActionKind.QuickFix);
		fix.edit = new vscode.WorkspaceEdit();
		fix.edit.insert(document.uri, document.positionAt(message.endOfMessage ?? 0), `,\n${' '.repeat(this.messageList?.indentation ?? 0)}"@${message.value}" : {}`);
		return fix;
	}
}
