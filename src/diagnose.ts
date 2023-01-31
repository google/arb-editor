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

const placeholderNameRegex = /^[a-zA-Z][a-zA-Z_$0-9]*$/; //Must be able to translate to a (non-private) Dart variable
const keyNameRegex = /^[a-zA-Z][a-zA-Z_0-9]*$/; //Must be able to translate to a (non-private) Dart method

export class Diagnostics {
	diagnostics = vscode.languages.createDiagnosticCollection("arb");

	constructor(context?: vscode.ExtensionContext) {
		context?.subscriptions.push(this.diagnostics);
	}

	diagnose(editor: vscode.TextEditor, messageList: MessageList, errors: Literal[]): vscode.Diagnostic[] {
		let diagnosticsList: vscode.Diagnostic[] = [];

		for (const error of errors) {
			showErrorAt(error.start, error.end, error.value, vscode.DiagnosticSeverity.Error);
		}

		for (const [key, message] of messageList?.messages) {
			const hasMetadata = Array.from(messageList.metadata.keys()).filter((literal) => literal.value === ('@' + key.value));
			let metadata: Metadata | null = null;
			if (hasMetadata.length > 0) {
				metadata = messageList.metadata.get(hasMetadata[0])!;
			}

			validateKey(key, metadata, messageList.isReference);
			validateMessage(message, metadata);
			validateMetadata(message, metadata);
		}

		for (const [key, metadata] of messageList?.metadata) {
			const hasMessage = Array.from(messageList.messages.keys()).filter((literal) => '@' + literal.value === key.value);
			if (hasMessage.length === 0) {
				showErrorAt(key.start, key.end, `Metadata for an undefined key. Add a message key with the name "${key.value.substring(1)}".`, vscode.DiagnosticSeverity.Error);
			}
		}

		this.diagnostics.set(editor.document.uri, diagnosticsList);

		function validateKey(key: Literal, metadata: Metadata | null, isReference: boolean) {
			if (keyNameRegex.exec(key.value) === null) {
				showErrorAt(key.start, key.end, `Key "${key.value}" is not a valid message key. The key must start with a letter and contain only letters, numbers, or underscores.`, vscode.DiagnosticSeverity.Error);
			} else {
				if (metadata === null && isReference) {
					showErrorAt(key.start, key.end, `The message with key "${key.value}" does not have metadata defined.`, vscode.DiagnosticSeverity.Information);
				}
			}
		}

		function validateMessage(message: Message, metadata: Metadata | null) {
			if (message instanceof CombinedMessage) {
				for (const submessage of message.parts) {
					validateMessage(submessage, metadata);
				}
			} else if (message instanceof Placeholder) {
				validatePlaceholder(message.placeholder, metadata);
			} else if (message instanceof ComplexMessage) {

				validatePlaceholder(message.argument, metadata);
				if (placeholderNameRegex.exec(message.argument.value) === null) {
					showErrorAt(message.argument.start, message.argument.end, `"${message.argument.value}" is not a valid placeholder name. The key must start with a letter and contain only letters, numbers, underscores.`, vscode.DiagnosticSeverity.Error);
				}

				if (!Array.from(message.messages.keys()).some((p) => p.value === 'other')) {
					showErrorAt(message.start + 1, message.end + 1, `The ICU message format requires a 'other' argument.`, vscode.DiagnosticSeverity.Error);
				}

				if (!['plural', 'select', 'gender'].includes(message.complexType.value)) {
					showErrorAt(message.complexType.start, message.complexType.end, `Unknown ICU messagetype "${message.complexType.value}"`, vscode.DiagnosticSeverity.Error);
				} else {
					for (const submessage of message.messages.values()) {
						validateMessage(submessage, metadata);
					}
				}
			}
		}

		function validatePlaceholder(placeholder: Literal, metadata: Metadata | null) {
			if (placeholderNameRegex.exec(placeholder.value) !== null) {
				if (!metadata?.placeholders.some((p) => p.value === placeholder.value)) {
					showErrorAt(placeholder.start, placeholder.end, `Placeholder "${placeholder.value}" not defined in the message metadata.`, vscode.DiagnosticSeverity.Warning);
				}
			} else {
				showErrorAt(placeholder.start, placeholder.end, `"${placeholder.value}" is not a valid placeholder name. The key must start with a letter and contain only letters, numbers, underscores.`, vscode.DiagnosticSeverity.Error);
			}
		}

		function validateMetadata(message: Message, metadata: Metadata | null) {
			const placeholders = message.getPlaceholders();
			for (const placeholder of metadata?.placeholders ?? []) {
				if (!placeholders.some((p) => p.value === placeholder.value)) {
					showErrorAt(placeholder.start, placeholder.end, `The placeholder is defined in the metadata, but not in the message.`, vscode.DiagnosticSeverity.Warning);
				}
			}
		}


		function showErrorAt(start: number, end: number, errorMessage: string, severity: vscode.DiagnosticSeverity) {
			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			diagnosticsList.push(new vscode.Diagnostic(range, errorMessage, severity));
		}

		return diagnosticsList;
	}
}
