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
import { CombinedMessage, ComplexMessage, Literal, Message, MessageList, Metadata, Placeholder } from './messageParser';

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

export class Decorator {

	decorate(editor: vscode.TextEditor, messageList: MessageList): Map<vscode.TextEditorDecorationType, vscode.Range[]> {
		// Prefill decorations map to avoid having old decoration hanging around
		let decorationsMap = new Map<vscode.TextEditorDecorationType, vscode.Range[]>([
			[placeholderDecoration, []],
			[selectDecoration, []],
			[pluralDecoration, []],
		]);

		for (const entry of messageList?.messageEntries) {
			const hasMetadata = messageList.metadataEntries.filter((metadataEntry) => metadataEntry.key.value === ('@' + entry.key.value));
			let metadata: Metadata | null = null;
			if (hasMetadata.length > 0) {
				metadata = hasMetadata[0].message as Metadata;
			}
			decorateMessage(entry.message as Message, metadata);
			decorateMetadata(entry.message as Message, metadata);
		}


		decorationsMap.forEach((value: vscode.Range[], key: vscode.TextEditorDecorationType) => {
			editor.setDecorations(key, value);
		});

		function decorateMessage(message: Message, metadata: Metadata | null) {
			if (message instanceof CombinedMessage) {
				for (const submessage of message.parts) {
					decorateMessage(submessage, metadata);
				}
			} else if (message instanceof Placeholder) {
				decorateAt(message.start, message.end, placeholderDecoration);
			} else if (message instanceof ComplexMessage) {
				decorateAt(message.argument.start, message.argument.end, placeholderDecoration);
				let complexDecoration = selectDecoration;
				if (message.complexType.value.includes('plural')) {
					complexDecoration = pluralDecoration;
				}
				for (const [key, submessage] of message.messages.entries()) {
					decorateAt(key.start, key.end, complexDecoration);
					decorateMessage(submessage, metadata);
				}
			}
		}

		function decorateMetadata(message: Message, metadata: Metadata | null) {
			for (const placeholder of metadata?.placeholders ?? []) {
				decorateAt(placeholder.start, placeholder.end, placeholderDecoration);
			}
		}

		function decorateAt(start: number, end: number, decoration: vscode.TextEditorDecorationType): void {
			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			decorationsMap.get(decoration)!.push(range);
		}


		return decorationsMap;
	}
}
