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
		console.log(`Providing code actions for ${range.start} - ${range.end}`);
		const diagnostics = context.diagnostics;

		const newMetadataActions = diagnostics
			.filter(diagnostic => diagnostic.code === DiagnosticCode.missingMetadataForKey)
			.map(_ => this.createMetadataForKey(document, range));

		const undefinedPlaceholderActions = diagnostics
			.filter(diagnostic => diagnostic.code === DiagnosticCode.placeholderWithoutMetadata)
			.map(_ => this.createPlaceholder(document, range));
		console.log(`newMetadataActions ${newMetadataActions}`);
		console.log(`undefinedPlaceholderActions ${undefinedPlaceholderActions}`);
		return [...newMetadataActions, ...undefinedPlaceholderActions]
			.filter(codeAction => codeAction instanceof vscode.CodeAction)
			.map(codeAction => codeAction as vscode.CodeAction);
	}

	private createMetadataForKey(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction {
		const messageKey = this.messageList?.getMessageAt(document.offsetAt(range.start)) as Key | undefined;

		const fix = new vscode.CodeAction(`Add metadata for key '${messageKey?.value}'`, vscode.CodeActionKind.QuickFix);
		fix.edit = new vscode.WorkspaceEdit();
		fix.edit.insert(document.uri, document.positionAt(messageKey?.endOfMessage ?? 0), `,\n${this.messageList?.getIndent()}"@${messageKey?.value}": {}`);
		return fix;
	}

	private createPlaceholder(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction | undefined {
		const offset = document.offsetAt(range.start);
		const placeholder = this.messageList
			?.getMessageAt(offset)
			?.getPlaceholders()
			?.find((p) => p.whereIs(offset) !== null);
		if (!placeholder) {
			return;
		}
		let parent = placeholder.parent;
		while (!(parent instanceof MessageEntry)) {
			parent = parent?.parent;
		}
		const fix = new vscode.CodeAction(`Add metadata for placeholder '${placeholder.value}'`, vscode.CodeActionKind.QuickFix);
		fix.edit = new vscode.WorkspaceEdit();

		const parentKey = (parent as MessageEntry).key;
		const metadataBlock = this.messageList?.metadataEntries.find((entry) => entry.key.value === '@' + parentKey.value);
		if (metadataBlock) {
			const metadata = metadataBlock.message as Metadata;
			if (metadata.placeholders.length > 0) {
				const lastPlaceholderEnd = metadata.placeholders[metadata.placeholders.length - 1].objectEnd;
				fix.edit.insert(
					document.uri,
					document.positionAt(lastPlaceholderEnd!),
					`,\n${this.messageList!.getIndent(3)}"${placeholder.value}": {}`
				);
			} else if (metadata.lastPlaceholderEnd) {
				fix.edit.insert(
					document.uri,
					document.positionAt(metadata.lastPlaceholderEnd),
					`\n${this.messageList!.getIndent(3)}"${placeholder.value}": {}\n${this.messageList!.getIndent(2)}`
				);
			} else {
				const insertable = `\n${this.messageList!.getIndent(2)}"placeholders": {\n${this.messageList!.getIndent(3)}"${placeholder.value}": {}\n${this.messageList!.getIndent(2)}}\n${this.messageList!.getIndent()}`;
				fix.edit.insert(document.uri, document.positionAt(metadata.metadataEnd), insertable);
			}
			return fix;
		} else {
			// TODO(mosuem): In this case, there is no metadata block yet. This could be handled by first running the fix for that, and then retrying this.
		}
	}
}
