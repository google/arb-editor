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
import { CombinedMessage, ComplexMessage, Literal, Message, Metadata, Parser, Placeholder } from './messageParser';

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

const selectRegex = /^([^\{\}]+\s*,\s*(?:select|gender)\s*,\s*(?:[^\{\}]*\{.*\})*)$/;
const pluralRegex = /^[^\{\}]+\s*,\s*plural\s*,\s*(?:offset:\d+)?\s*(?:[^\{\} ]*?\s*\{.*\})$/;
const placeholderNameRegex = /^[a-zA-Z][a-zA-Z_$0-9]*$/; //Must be able to translate to a (non-private) Dart variable
const keyNameRegex = /^[a-zA-Z][a-zA-Z_0-9]*$/; //Must be able to translate to a (non-private) Dart method

export class DecoratorAndParser {
	diagnostics = vscode.languages.createDiagnosticCollection("arb");

	constructor(context?: vscode.ExtensionContext) {
		context?.subscriptions.push(this.diagnostics);
	}

	parseAndDecorate(editor: vscode.TextEditor): { diagnostics: vscode.Diagnostic[]; decorations: Map<vscode.TextEditorDecorationType, vscode.Range[]>; } | null {
		// Prefill decorations map to avoid having old decoration hanging around
		let decorationsMap = new Map<vscode.TextEditorDecorationType, vscode.Range[]>([
			[placeholderDecoration, []],
			[selectDecoration, []],
			[pluralDecoration, []],
		]);
		let diagnosticsList: vscode.Diagnostic[] = [];

		// Only trigger on arb files
		if (!editor || !path.basename(editor.document.fileName).endsWith('.arb')) {
			return null;
		}

		const [messageList, errors] = new Parser().parse(editor.document.getText())!;

		for (const error of errors) {
			showErrorAt(error.start, error.end, error.value, vscode.DiagnosticSeverity.Error);
		}

		for (const [key, message] of messageList?.messages) {
			const hasMetadata = Array.from(messageList.metadata.keys()).filter((literal) => literal.value === ('@' + key.value));
			let metadata: Metadata | null = null;
			if (hasMetadata.length > 0) {
				metadata = messageList.metadata.get(hasMetadata[0])!;
			}

			decorateKey(key, metadata, messageList.isReference);
			decorateMessage(message, metadata);
			decorateMetadata(message, metadata);
		}

		for (const [key, metadata] of messageList?.metadata) {
			const hasMessage = Array.from(messageList.messages.keys()).filter((literal) => '@' + literal.value === key.value);
			if (hasMessage.length === 0) {
				showErrorAt(key.start, key.end, `Metadata for an undefined key. Add a message key with the name "${key.value.substring(1)}".`, vscode.DiagnosticSeverity.Error);
			}
		}

		this.diagnostics.set(editor.document.uri, diagnosticsList);
		decorationsMap.forEach((value: vscode.Range[], key: vscode.TextEditorDecorationType) => {
			editor.setDecorations(key, value);
		});

		function decorateKey(key: Literal, metadata: Metadata | null, isReference: boolean) {
			if (keyNameRegex.exec(key.value) === null) {
				showErrorAt(key.start, key.end, `Key "${key.value}" is not a valid message key. The key must start with a letter and contain only letters, numbers, or underscores.`, vscode.DiagnosticSeverity.Error);
			} else {
				if (metadata === null && isReference) {
					showErrorAt(key.start, key.end, `The message with key "${key.value}" does not have metadata defined.`, vscode.DiagnosticSeverity.Information);
				}
			}
		}

		function decorateMessage(message: Message, metadata: Metadata | null) {
			if (message instanceof CombinedMessage) {
				for (const submessage of message.parts) {
					decorateMessage(submessage, metadata);
				}
			} else if (message instanceof Placeholder) {
				decorateAt(message.start, message.end, placeholderDecoration);
				if (placeholderNameRegex.exec(message.placeholder.value) !== null) {
					if (!metadata?.placeholders.some((p) => p.value === message.placeholder.value)) {
						showErrorAt(message.placeholder.start, message.placeholder.end, `Placeholder "${message.placeholder.value}" not defined in the message metadata.`, vscode.DiagnosticSeverity.Warning);
					}
				} else {
					showErrorAt(message.placeholder.start, message.placeholder.end, `"${message.placeholder.value}" is not a valid placeholder name. The key must start with a letter and contain only letters, numbers, underscores.`, vscode.DiagnosticSeverity.Error);
				}
			} else if (message instanceof ComplexMessage) {
				decorateAt(message.argument.start, message.argument.end, placeholderDecoration);
				if (placeholderNameRegex.exec(message.argument.value) === null) {
					showErrorAt(message.argument.start, message.argument.end, `"${message.argument.value}" is not a valid placeholder name. The key must start with a letter and contain only letters, numbers, underscores.`, vscode.DiagnosticSeverity.Error);
				}

				if (!Array.from(message.messages.keys()).some((p) => p.value.trim() === 'other')) {
					showErrorAt(message.start + 1, message.end + 1, `The ICU message format requires a 'other' argument.`, vscode.DiagnosticSeverity.Error);
				}

				if (!['plural', 'select', 'gender'].includes(message.complexType.value.trim())) {
					showErrorAt(message.complexType.start, message.complexType.end, `Unknown ICU messagetype "${message.complexType.value.trim()}"`, vscode.DiagnosticSeverity.Error);
				} else {
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
		}

		function decorateMetadata(message: Message, metadata: Metadata | null) {
			const placeholders = message.getPlaceholders();
			for (const placeholder of metadata?.placeholders ?? []) {
				if (!placeholders.some((p) => p.value === placeholder.value)) {
					showErrorAt(placeholder.start, placeholder.end, `The placeholder is defined in the metadata, but not in the message.`, vscode.DiagnosticSeverity.Warning);
				}
			}
		}

		function decorateAt(start: number, end: number, decoration: vscode.TextEditorDecorationType): void {
			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			decorationsMap.get(decoration)!.push(range);
		}

		function showErrorAt(start: number, end: number, errorMessage: string, severity: vscode.DiagnosticSeverity) {
			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			diagnosticsList.push(new vscode.Diagnostic(range, errorMessage, severity));
		}

		return { diagnostics: diagnosticsList, decorations: decorationsMap };
	}
}
