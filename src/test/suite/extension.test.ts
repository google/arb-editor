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
import { EOL } from 'os';
// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { placeholderDecoration, selectDecoration, pluralDecoration, DecoratorAndParser } from '../../parseAndDecorate';
import { Parser } from '../../messageParser';

const annotationNames = new Map<vscode.TextEditorDecorationType, string>([
	[placeholderDecoration, '[decoration]placeholder'],
	[selectDecoration, '[decoration]select'],
	[pluralDecoration, '[decoration]plural'],
]);

suite('Extension Test Suite', async () => {
	test("Decorate golden file.", async () => {
		const contentWithAnnotations = await buildContentWithAnnotations('testarb.arb');
		if (process.env.UPDATE_GOLDENS) {
			console.warn('Updating golden test.');

			//Run `UPDATE_GOLDENS=1 npm test` to regenerate the golden test
			await regenerateGolden(contentWithAnnotations, 'testarb.annotated');
		} else {
			const goldenEditor = await getEditor('testarb.annotated');
			assert.equal(contentWithAnnotations, goldenEditor.document.getText());
		}
	});

	test("A rough parser test, as the real test will be done by the golden.", async () => {
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
		assert.equal(messages.messages.size, 6);
		assert.equal(messages.metadata.size, 5);
	});

});


const testFolderLocation: string = "/../../../src/test/";

async function regenerateGolden(contentWithAnnotations: string, goldenFilename: string) {
	const uri = vscode.Uri.file(path.join(__dirname, testFolderLocation, goldenFilename));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(contentWithAnnotations));
}

async function buildContentWithAnnotations(filename: string) {
	const editor = await getEditor(filename);
	const decorations = new DecoratorAndParser().parseAndDecorate(editor);
	const content = editor.document.getText();
	const annotationsForLine = new Map<number, string[]>();
	for (const entry of decorations?.decorations.entries() ?? []) {
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
	for (const diagnostic of decorations?.diagnostics ?? []) {
		const range = diagnostic.range;
		for (let lineNumber = range.start.line; lineNumber <= range.end.line; lineNumber++) {
			const line = editor.document.lineAt(lineNumber);
			const offsetInLine = range.start.character - line.range.start.character;
			const lengthInLine = (line.range.end.character - range.start.character) - (line.range.end.character - range.end.character);
			const annotation = ' '.repeat(offsetInLine) + '^'.repeat(lengthInLine) + '[' + vscode.DiagnosticSeverity[diagnostic.severity] + ']:"' + diagnostic.message + '"';
			annotationsForLine.set(lineNumber, [...(annotationsForLine.get(lineNumber) ?? []), annotation]);
		}
	}
	const lines = content.split(EOL);
	const numLines = lines.length;
	for (let index = numLines; index > 0; index--) {
		if (annotationsForLine.has(index)) {
			lines.splice(index + 1, 0, ...annotationsForLine.get(index)!);
		}
	}
	const contentWithAnnotations = lines.join(EOL);
	return contentWithAnnotations;
}

async function getEditor(filename: string) {
	const testFilePath = path.join(__dirname, testFolderLocation, filename);
	const uri = vscode.Uri.file(testFilePath);
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document);
	return editor;
}
