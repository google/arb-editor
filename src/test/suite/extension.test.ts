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
import * as assert from 'assert';
import path = require('path');
import { TextEncoder } from 'util';
// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { placeholderDecoration, selectDecoration, pluralDecoration, Decorator } from '../../decorate';
import { CombinedMessage, Key, Literal, MessageList, Parser, getUnescapedRegions } from '../../messageParser';
import { DiagnosticCode, Diagnostics } from '../../diagnose';
import { L10nYaml } from '../../extension';
import { CodeActions } from '../../codeactions';

const annotationNames = new Map<vscode.TextEditorDecorationType, string>([
	[placeholderDecoration, '[decoration]placeholder'],
	[selectDecoration, '[decoration]select'],
	[pluralDecoration, '[decoration]plural'],
]);

suite('Extension Test Suite', async () => {
	test("Decorate golden file.", async () => {
		await updateConfiguration(null);
		const contentWithAnnotations = await buildContentWithAnnotations('testarb.arb');
		await compareGolden(contentWithAnnotations, 'testarb.annotated');
	});

	test("Decorate golden file with template.", async () => {
		await updateConfiguration(null);
		const contentWithAnnotations = await buildContentWithAnnotations('testarb_2.arb');
		await compareGolden(contentWithAnnotations, 'testarb_2.annotated');
	});

	test("A rough parser test, as the real test will be done by the golden.", async () => {
		await updateConfiguration(null);
		const document = `{
			"@@locale": "en",
			"appName": "Demo app",
			"pageLog{inUsername": "Your username",
			"@pageLoginUsername": {},
			"pageLoginPassword": "Your password",
			"@pageLoginPassword": {},
			"pageHomeTitle": "Welcome {firstName} to {test}!",
			"@pageHomeTitle": {
				"description": "Welcome message on the Home screen",
				"placeholders": {
					"firstName": {}
				}
			},
			"pageHomeInboxCount": "{count, plural, zero{I have {vehicle;;Type, select, sedn{Sedan} cabrolet{Solid roof cabriolet} tuck{16 wheel truck} oter{Other}} no new messages} one{You have 1 new message} other{You have {count} new messages}}",
			"@pageHomeInboxCount": {
				"description": "New messages count on the Home screen",
				"placeholders": {
					"count": {},
					"vehicleType": {}
				}
			},
			"commonVehicleType": "{vehicleType, select, sedan{Sedan} cabriolet{Solid roof cabriolet} truck{16 wheel truck} other{Other}}",
			"@commonVeshicleType": {
				"description": "Vehicle type",
				"placeholders": {
					"vehicleType": {}
				}
			}
		}`;
		const [messages, errors] = new Parser().parse(document);
		assert.equal(errors.length, 0);
		assert.equal(messages.messageEntries.length, 6);
		assert.equal(messages.metadataEntries.length, 5);
	});

	test("Test quickfix for missing Metadata", async () => {
		await updateConfiguration(null);
		await testFixAgainstGolden('quickfix.arb', getFirstKey, 'quickfix.golden');
	});

	test("Test quickfix for placeholder without metadata with tabs", async () => {
		await updateConfiguration(null);
		await testFixAgainstGolden('quickfix2.arb', getPlaceholder, 'quickfix2.golden');
	});

	test("Test quickfix for placeholder without metadata with spaces", async () => {
		await updateConfiguration(null);
		await testFixAgainstGolden('quickfix2_spaces.arb', getPlaceholder, 'quickfix2_spaces.golden');
	});

	test("Test finding unescaped regions", async () => {
		await updateConfiguration(null);
		assert.deepEqual(getUnescapedRegions("Test"), [[0, 4]]);
		assert.deepEqual(getUnescapedRegions("Te''st"), [[0, 6]]);
		assert.deepEqual(getUnescapedRegions("Te'some text'st"), [[0, 2], [13, 15]]);
		assert.deepEqual(getUnescapedRegions("Te'some text'st and 'another'"), [[0, 2], [13, 20]]);
		assert.deepEqual(getUnescapedRegions("'some text'st and 'another'"), [[11, 18]]);
		assert.deepEqual(getUnescapedRegions("Te''''st"), [[0, 8]]);
	});

	test("Test suppressed all warnings", async () => {
		await updateConfiguration('all');

		const document = await getEditor('testarb.arb');

		const [messageList, errors] = new Parser().parse(document.document.getText())!;
		const diagnosticsList = new Diagnostics().diagnose(document, messageList, errors, undefined);

		assert.equal(diagnosticsList.length, 0);
	});

	test("Test suppressed warning with id missing_metadata_for_key", async () => {
		const id = DiagnosticCode.missingMetadataForKey;
		await updateConfiguration([id]);

		const document = await getEditor('quickfix.arb');

		const [messageList, errors] = new Parser().parse(document.document.getText())!;
		const diagnosticsList = new Diagnostics().diagnose(document, messageList, errors, undefined);

		assert.equal(diagnosticsList.every(item => item.code !== id), true);
	});

	test("Test suppressed warning with id 'invalid_key', 'missing_metadata_for_key'", async () => {
		const ids = [DiagnosticCode.invalidKey, DiagnosticCode.missingMetadataForKey];
		await updateConfiguration(ids);

		const document = await getEditor('testarb_2.arb');

		const [messageList, errors] = new Parser().parse(document.document.getText())!;
		const diagnosticsList = new Diagnostics().diagnose(document, messageList, errors, undefined);

		assert.equal(diagnosticsList.every(item => !ids.includes(item.code as DiagnosticCode)), true);
	});

	test("Test suppressed warning with code 'metadata_for_missing_key'", async () => {
		const id = DiagnosticCode.metadataForMissingKey;
		await updateConfiguration([id]);

		const document = await getEditor('testarb_2.arb');

		const [messageList, errors] = new Parser().parse(document.document.getText())!;
		const diagnosticsList = new Diagnostics().diagnose(document, messageList, errors, undefined);

		assert.equal(diagnosticsList.every(item => item.code !== id), true);
	});

	suite('Template Path', async () => {
		/* eslint-disable @typescript-eslint/naming-convention */
		test("Resolve template path from @@x-template with L10nYaml", async () => {
			const testDir = 'l10nYaml/with_x-template/l10n';
			await updateConfiguration(null);
			const contentWithAnnotations = await buildContentWithAnnotations(`${testDir}/testarb_2.arb`);
			await compareGolden(contentWithAnnotations, `${testDir}/testarb_2.annotated`);
		});

		test("Resolve template path from empty L10nYaml", async () => {
			const testDir = 'l10nYaml/empty/lib/l10n';
			await updateConfiguration(null);
			const contentWithAnnotations = await buildContentWithAnnotations(`${testDir}/testarb_2.arb`);
			await compareGolden(contentWithAnnotations, `${testDir}/testarb_2.annotated`);
		});

		test("Resolve template path from L10nYaml with arb-dir and template-arb-file", async () => {
			const testDir = 'l10nYaml/arb-dir_template-arb-file/_l10n';
			await updateConfiguration(null);
			const contentWithAnnotations = await buildContentWithAnnotations(`${testDir}/testarb_2.arb`);
			await compareGolden(contentWithAnnotations, `${testDir}/testarb_2.annotated`);
		});

		test("Resolve template path from L10nYaml with template-arb-file", async () => {
			const testDir = 'l10nYaml/template-arb-file/lib/l10n';
			await updateConfiguration(null);
			const contentWithAnnotations = await buildContentWithAnnotations(`${testDir}/testarb_2.arb`);
			await compareGolden(contentWithAnnotations, `${testDir}/testarb_2.annotated`);
		});

		test("Resolve template path from L10nYaml with arb-dir", async () => {
			const testDir = 'l10nYaml/arb-dir/_l10n';
			await updateConfiguration(null);
			const contentWithAnnotations = await buildContentWithAnnotations(`${testDir}/testarb_2.arb`);
			await compareGolden(contentWithAnnotations, `${testDir}/testarb_2.annotated`);
		});
		/* eslint-enable */
	});
});

const testFolderLocation: string = "/../../../src/test/";

function getFirstKey(messageList: MessageList) {
	return messageList.messageEntries[0].key as Key;
}

function getPlaceholder(messageList: MessageList) {
	const message = messageList.messageEntries[0].message as CombinedMessage;
	const entry = message.getPlaceholders()[0];
	return entry;
}

async function testFixAgainstGolden(testFile: string, getItemFromParsed: (messageList: MessageList) => Literal, goldenFile: string) {
	const editor = await getEditor(testFile);

	// Parse original
	const [messageList,] = new Parser().parse(editor.document.getText());

	// Apply fix for placeholder not defined in metadata
	const item = getItemFromParsed(messageList);

	const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider",
		editor.document.uri,
		new vscode.Range(
			editor.document.positionAt(item.start + 1),
			editor.document.positionAt(item.end - 1)
		));
	await vscode.workspace.applyEdit(actions[0].edit as vscode.WorkspaceEdit);

	// Compare with golden
	await compareGolden(editor.document.getText(), goldenFile);
}

async function compareGolden(text: string, goldenFile: string) {
	if (process.env.UPDATE_GOLDENS) {
		console.warn('Updating golden test.');

		// Run ```
		// UPDATE_GOLDENS=1 npm test
		// ``` to regenerate the golden test
		await regenerateGolden(text, goldenFile);
	} else {
		const goldenEditor = await getEditor(goldenFile);
		assert.equal(text, goldenEditor.document.getText());
	}
}

async function regenerateGolden(newContent: string, goldenFilename: string) {
	const uri = vscode.Uri.file(path.join(__dirname, testFolderLocation, goldenFilename));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(newContent));
}

async function buildContentWithAnnotations(filename: string) {
	const editor = await getEditor(filename);
	const editorEol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";

	const { decorations, diagnostics } = new Parser().parseAndDecorate({
		editor,
		decorator: new Decorator(),
		diagnostics: new Diagnostics(),
		quickfixes: new CodeActions(),
	});


	const content = editor.document.getText();
	const annotationsForLine = new Map<number, string[]>();
	for (const entry of decorations.entries() ?? []) {
		const decorationType = entry[0];
		for (const range of entry[1]) {
			for (let lineNumber = range.start.line; lineNumber <= range.end.line; lineNumber++) {
				const line = editor.document.lineAt(lineNumber);
				const offsetInLine = range.start.character - line.range.start.character;
				const lengthInLine = (line.range.end.character - range.start.character) - (line.range.end.character - range.end.character);
				const annotation = ' '.repeat(offsetInLine) + '^'.repeat(lengthInLine) + annotationNames.get(decorationType)!;
				annotationsForLine.set(lineNumber, [...(annotationsForLine.get(lineNumber) ?? []), annotation]);
			}
		}
	}
	for (const diagnostic of diagnostics ?? []) {
		const range = diagnostic.range;
		for (let lineNumber = range.start.line; lineNumber <= range.end.line; lineNumber++) {
			const line = editor.document.lineAt(lineNumber);
			const offsetInLine = range.start.character - line.range.start.character;
			const lengthInLine = (line.range.end.character - range.start.character) - (line.range.end.character - range.end.character);
			const annotation = ' '.repeat(offsetInLine) + '^'.repeat(lengthInLine) + '[' + vscode.DiagnosticSeverity[diagnostic.severity] + ']:"' + diagnostic.message + '"';
			annotationsForLine.set(lineNumber, [...(annotationsForLine.get(lineNumber) ?? []), annotation]);
		}
	}
	const lines = content.split(editorEol);
	const numLines = lines.length;
	for (let index = numLines; index > 0; index--) {
		if (annotationsForLine.has(index)) {
			lines.splice(index + 1, 0, ...annotationsForLine.get(index)!);
		}
	}
	const contentWithAnnotations = lines.join(editorEol);
	return contentWithAnnotations;
}

async function getEditor(filename: string) {
	const testFilePath = path.join(__dirname, testFolderLocation, filename);
	const uri = vscode.Uri.file(testFilePath);
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document);
	return editor;
}

async function updateConfiguration(config: null | 'all' | DiagnosticCode[]) {
	if (config === null) {
		await vscode.workspace.getConfiguration().update("arb-editor.suppressedWarnings", undefined, vscode.ConfigurationTarget.Global);
		return;
	}

	await vscode.workspace.getConfiguration().update("arb-editor.suppressedWarnings", config, vscode.ConfigurationTarget.Global);
}

