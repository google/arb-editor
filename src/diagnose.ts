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
import { CombinedMessage, ComplexMessage, Key, Literal, Message, MessageEntry, MessageList, Metadata, Placeholder } from './messageParser';

const placeholderNameRegex = /^[a-zA-Z][a-zA-Z_$0-9]*$/; //Must be able to translate to a (non-private) Dart variable
const keyNameRegex = /^[a-zA-Z][a-zA-Z_0-9]*$/; //Must be able to translate to a (non-private) Dart method

export enum DiagnosticCode {
	mismatchedBrackets = "mismatched_brackets",
	metadataForMissingKey = "metadata_for_missing_key",
	invalidKey = "invalid_key",
	missingMetadataForKey = "missing_metadata_for_key",
	invalidPlaceholder = "invalid_placeholder",
	missingOtherInICU = "missing_other_in_icu",
	unknownICUMessageType = "unknown_icu_message_type",
	placeholderWithoutMetadata = "placeholder_without_metadata",
	missingPlaceholderWithMetadata = "missing_placeholder_with_metadata",
	missingMessagesFromTemplate = "missing_messages_from_template",
}

export class Diagnostics {
	diagnostics = vscode.languages.createDiagnosticCollection("arb");

	constructor(context?: vscode.ExtensionContext) {
		context?.subscriptions.push(this.diagnostics);
	}

	diagnose(editor: vscode.TextEditor, messageList: MessageList, errors: Literal[], templateMessageList: MessageList | undefined): vscode.Diagnostic[] {
		const suppressedWarnings: 'all' | DiagnosticCode[] = vscode.workspace.getConfiguration('arbEditor').get('suppressedWarnings') || [];
		if (suppressedWarnings === 'all') {
			return [];
		}

		let diagnosticsList: vscode.Diagnostic[] = [];

		for (const error of errors) {
			showErrorAt(error.start, error.end, error.value, vscode.DiagnosticSeverity.Error, DiagnosticCode.mismatchedBrackets);
		}

		/// Validate messages, checking if
		/// * The message has metadata defined,
		/// * The key is a valid string,
		/// * The ICU syntax is valid,
		/// * The message has all its placeholders defined in the metadata,
		/// * The placeholders in the metadata actually exist in the message.
		for (const entry of messageList?.messageEntries) {
			const hasMetadata = checkMetadataExistence(messageList, entry);
			let metadata: Metadata | null = null;
			let templateMetadata: Metadata | null = null;
			if (hasMetadata.length > 0) {
				metadata = hasMetadata[0].message as Metadata;
			} else if (templateMessageList) {
				const hasTemplateMetadata = checkMetadataExistence(templateMessageList, entry);
				if (hasTemplateMetadata.length > 0) {
					templateMetadata = hasTemplateMetadata[0].message as Metadata;
				}
			}

			validateKey(entry.key, metadata ?? templateMetadata);
			validateMessage(entry.message as Message, metadata ?? templateMetadata);
			validateMetadata(entry.message as Message, metadata);
		}

		/// Check if any metadata is defined for a message which doesn't exist.
		for (const metadataKey of messageList?.metadataEntries.map((entry) => entry.key)) {
			const hasMessage = messageList.messageEntries.filter((messageEntry) => '@' + messageEntry.key.value === metadataKey.value);
			if (hasMessage.length === 0) {
				showErrorAt(metadataKey.start,
					metadataKey.end,
					`Metadata for an undefined key. Add a message key with the name "${metadataKey.value.substring(1)}".`,
					vscode.DiagnosticSeverity.Error,
					DiagnosticCode.metadataForMissingKey,
				);
			}
		}

		/// Check if any messages are left out of the current file compared to the template.
		if (templateMessageList) {
			let missing: Key[] = [];
			for (const entry of templateMessageList.messageEntries) {
				if (!messageList.messageEntries.some((m) => m.key === entry.key)) {
					missing.push(entry.key);
				}
			}

			let messagesEnd = editor.document.offsetAt(editor.document.lineAt(editor.document.lineCount - 1).range.end);
			showErrorAt(messagesEnd,
				messagesEnd + 1,
				`Missing messages from template: ${missing.map((key) => key.value).join(', ')}`,
				vscode.DiagnosticSeverity.Warning,
				DiagnosticCode.missingMessagesFromTemplate,
			);
		}

		this.diagnostics.set(editor.document.uri, diagnosticsList);

		function validateKey(key: Literal, metadata: Metadata | null) {
			if (keyNameRegex.exec(key.value) === null) {
				showErrorAt(key.start,
					key.end,
					`Key "${key.value}" is not a valid message key. The key must start with a letter and contain only letters, numbers, or underscores.`,
					vscode.DiagnosticSeverity.Error,
					DiagnosticCode.invalidKey,
				);
			} else {
				if (metadata === null) {
					showErrorAt(key.start,
						key.end,
						`The message with key "${key.value}" does not have metadata defined.`,
						vscode.DiagnosticSeverity.Information,
						DiagnosticCode.missingMetadataForKey,
					);
				}
			}
		}

		function validateMessage(message: Message, metadata: Metadata | null) {
			if (message instanceof CombinedMessage) {
				for (const submessage of message.parts) {
					validateMessage(submessage, metadata);
				}
			} else if (message instanceof Placeholder) {
				validatePlaceholder(message, metadata);
			} else if (message instanceof ComplexMessage) {
				validatePlaceholder(message.argument, metadata);

				if (!Array.from(message.messages.keys()).some((p) => p.value === 'other')) {
					showErrorAt(message.start + 1,
						message.end + 1,
						`The ICU message format requires a 'other' argument.`,
						vscode.DiagnosticSeverity.Error,
						DiagnosticCode.missingOtherInICU,
					);
				}

				if (!['plural', 'select', 'gender'].includes(message.complexType.value)) {
					showErrorAt(message.complexType.start,
						message.complexType.end,
						`Unknown ICU messagetype "${message.complexType.value}"`,
						vscode.DiagnosticSeverity.Error,
						DiagnosticCode.unknownICUMessageType,
					);
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
					showErrorAt(placeholder.start,
						placeholder.end,
						`Placeholder "${placeholder.value}" not defined in the message metadata.`,
						vscode.DiagnosticSeverity.Warning,
						DiagnosticCode.placeholderWithoutMetadata,
					);
				}
			} else {
				showErrorAt(placeholder.start,
					placeholder.end,
					`"${placeholder.value}" is not a valid placeholder name. The key must start with a letter and contain only letters, numbers, underscores.`,
					vscode.DiagnosticSeverity.Error,
					DiagnosticCode.invalidPlaceholder,
				);
			}
		}

		function validateMetadata(message: Message, metadata: Metadata | null) {
			const placeholders = message.getPlaceholders();
			for (const placeholder of metadata?.placeholders ?? []) {
				if (!placeholders.some((p) => p.value === placeholder.value)) {
					showErrorAt(placeholder.start,
						placeholder.end,
						`The placeholder is defined in the metadata, but not in the message.`,
						vscode.DiagnosticSeverity.Warning,
						DiagnosticCode.missingPlaceholderWithMetadata,
					);
				}
			}
		}


		function showErrorAt(start: number, end: number, errorMessage: string, severity: vscode.DiagnosticSeverity, code: DiagnosticCode) {
			if (suppressedWarnings.includes(code)) {
				return;
			}

			const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
			const diagnostic = new vscode.Diagnostic(range, errorMessage, severity);
			diagnostic.code = code;
			diagnosticsList.push(diagnostic);
		}

		return diagnosticsList;
	}
}
function checkMetadataExistence(messageList: MessageList, entry: MessageEntry) {
	return messageList.metadataEntries.filter((metadataEntry) => metadataEntry.key.value === ('@' + entry.key.value));
}

