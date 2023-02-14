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
import { Key, MessageEntry, MessageList, Metadata, Placeholder } from './messageParser';


export class CodeActions implements vscode.CodeActionProvider {
	messageList: MessageList | undefined;

	update(messageList: MessageList) {
		this.messageList = messageList;
	}

	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix
	];

	provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
		const diagnostics = context.diagnostics;

		const newMetadataActions = diagnostics
			.filter(diagnostic => diagnostic.code === DiagnosticCode.missingMetadataForKey)
			.map(diagnostic => this.createMetadataForKey(document, diagnostic, range));

		const undefinedPlaceholderActions = diagnostics
			.filter(diagnostic => diagnostic.code === DiagnosticCode.placeholderWithoutMetadata)
			.map(diagnostic => this.createPlaceholder(document, diagnostic, range));

		return [...newMetadataActions, ...undefinedPlaceholderActions]
			.filter(codeAction => codeAction instanceof vscode.CodeAction)
			.map(codeAction => codeAction as vscode.CodeAction);
	}

	private createMetadataForKey(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, range: vscode.Range | vscode.Selection): vscode.CodeAction {
		const messageKey = this.messageList?.getMessageAt(document.offsetAt(range.start)) as Key | undefined;

		const fix = new vscode.CodeAction(`Add metadata for key '${messageKey?.value}'`, vscode.CodeActionKind.QuickFix);
		fix.edit = new vscode.WorkspaceEdit();
		fix.edit.insert(document.uri, document.positionAt(messageKey?.endOfMessage ?? 0), `,\n${this.messageList?.getIndent()}"@${messageKey?.value}" : {}`);
		return fix;
	}

	private createPlaceholder(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, range: vscode.Range | vscode.Selection): vscode.CodeAction | undefined {
		const placeholder = this.messageList?.getMessageAt(document.offsetAt(range.start)) as Placeholder | undefined;
		var parent = placeholder?.parent;
		while (!(parent instanceof MessageEntry)) {
			parent = parent?.parent;
		}
		const fix = new vscode.CodeAction(`Add metadata for placeholder '${placeholder?.value}'`, vscode.CodeActionKind.QuickFix);
		fix.edit = new vscode.WorkspaceEdit();

		const parentKey = (parent as MessageEntry).key;
		const metadatas = this.messageList?.metadataEntries.filter((entry) => entry.key.value === '@' + parentKey.value);
		if (metadatas) {
			const metadataForMessage = metadatas[0];

			const metadata = metadataForMessage.message as Metadata;
			if (metadata.placeholders.length > 0) {
				const lastPlaceholderEnd = metadata.placeholders[metadata.placeholders.length - 1].objectEnd;
				fix.edit.insert(document.uri, document.positionAt(lastPlaceholderEnd!), `,\n${this.messageList!.getIndent(2)}"${placeholder?.value}": {}`);
			} else if (metadata.lastPlaceholderEnd) {
				fix.edit.insert(document.uri, document.positionAt(metadata.lastPlaceholderEnd), `\n${this.messageList!.getIndent(2)}"${placeholder?.value}": {}\n${this.messageList!.getIndent(1)}`);
			} else {
				const insertable = `\n${this.messageList!.getIndent(1)}"placeholders": {\n${this.messageList!.getIndent(2)}"${placeholder?.value}": {}\n${this.messageList!.getIndent(1)}}\n${this.messageList!.getIndent()}`;
				fix.edit.insert(document.uri, document.positionAt(metadata.metadataEnd), insertable);
			}
			return fix;
		} else {
			// fix.edit.insert(document.uri, document.positionAt(parentKey?.endOfMessage ?? 0), `,\n${' '.repeat(this.messageList?.this.messageList!.getIndent() ?? 0)}"@${parentKey?.value}" : {}`);
		}
	}
}
