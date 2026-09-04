// Copyright 2026 Google LLC

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
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	L10N_MEMBER_ACCESS_REGEX,
	createInlayHint,
	isLikelyLocalizationReceiver,
	sanitizeDartSource,
} from '../../inlayHints';
import { ArbData, getArbData, invalidateArbCache } from '../../project';

suite('Dart ARB Inlay Hints', () => {
	suite('sanitizeDartSource', () => {
		test('masks single-line comments with spaces while preserving newlines', () => {
			const source = '// l10n.hello\nText(l10n.hello);';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('l10n.hello\n'));
			assert.ok(sanitized.includes('Text(l10n.hello);'));
		});

		test('masks block comments and nested block comments', () => {
			const source = '/* l10n.comment /* nested */ */\nText(l10n.actual);';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('l10n.comment'));
			assert.ok(!sanitized.includes('nested'));
			assert.ok(sanitized.includes('Text(l10n.actual);'));
		});

		test('masks regular single and double quoted strings', () => {
			const source = 'final a = "l10n.string1";\nfinal b = \'l10n.string2\';\nText(l10n.real);';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('l10n.string1'));
			assert.ok(!sanitized.includes('l10n.string2'));
			assert.ok(sanitized.includes('Text(l10n.real);'));
		});

		test('masks raw and triple quoted strings', () => {
			const source = 'final a = r"l10n.raw";\nfinal b = \'\'\'\nl10n.triple\n\'\'\';\nText(l10n.real);';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('l10n.raw'));
			assert.ok(!sanitized.includes('l10n.triple'));
			assert.ok(sanitized.includes('Text(l10n.real);'));
		});
	});

	suite('isLikelyLocalizationReceiver', () => {
		test('recognizes standard AppLocalizations patterns', () => {
			assert.strictEqual(isLikelyLocalizationReceiver('AppLocalizations'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('AppLocalizations.of(context)'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('AppLocalizations.of(ctx)'), true);
		});

		test('recognizes common variable names and chained context access', () => {
			assert.strictEqual(isLikelyLocalizationReceiver('l10n'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('_l10n'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('context.l10n'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('ctx.l10n'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('loc'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('_loc'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('localizations'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('strings'), true);
		});

		test('recognizes S and custom outputClass', () => {
			assert.strictEqual(isLikelyLocalizationReceiver('S'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('S.of(context)'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('S.current'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('MyStrings', 'MyStrings'), true);
			assert.strictEqual(isLikelyLocalizationReceiver('MyStrings.of(context)', 'MyStrings'), true);
		});

		test('rejects non-localization receivers', () => {
			assert.strictEqual(isLikelyLocalizationReceiver('widget'), false);
			assert.strictEqual(isLikelyLocalizationReceiver('state'), false);
			assert.strictEqual(isLikelyLocalizationReceiver('user'), false);
			assert.strictEqual(isLikelyLocalizationReceiver('theme'), false);
			assert.strictEqual(isLikelyLocalizationReceiver('controller'), false);
		});
	});

	suite('L10N_MEMBER_ACCESS_REGEX', () => {
		test('matches chained and direct member accesses', () => {
			const source = `
Text(context.l10n.helloWorld);
Text(AppLocalizations.of(context)!.title);
Text(AppLocalizations.of(context)?.subtitle);
Text(l10n.welcome);
Text(S.current.greeting);
`;
			const matches = [...source.matchAll(L10N_MEMBER_ACCESS_REGEX)];
			const pairs = matches.map(m => ({
				receiver: m[1] || m[2],
				member: m[3],
			}));

			assert.deepStrictEqual(pairs, [
				{ receiver: 'context.l10n', member: 'helloWorld' },
				{ receiver: 'AppLocalizations.of(context)', member: 'title' },
				{ receiver: 'AppLocalizations.of(context)', member: 'subtitle' },
				{ receiver: 'l10n', member: 'welcome' },
				{ receiver: 'S.current', member: 'greeting' },
			]);
		});
	});

	suite('getArbData and createInlayHint', () => {
		const tempDir = path.join(__dirname, 'temp_arb_test');
		const testArbPath = path.join(tempDir, 'app_en.arb');

		suiteSetup(() => {
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}
			const arbContent = JSON.stringify(
				{
					'@@locale': 'en',
					'helloWorld': 'Hello World!',
					'@helloWorld': {
						'description': 'A friendly greeting',
					},
					'longMessage': 'This is a very long localized string that should be truncated by inlay hint rendering.',
				},
				null,
				2,
			);
			fs.writeFileSync(testArbPath, arbContent, 'utf8');
			invalidateArbCache();
		});

		suiteTeardown(() => {
			if (fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		test('parses ARB messages, locale, and descriptions', () => {
			const arbData = getArbData(testArbPath);
			assert.ok(arbData);
			assert.strictEqual(arbData.locale, 'en');
			assert.strictEqual(arbData.messages.size, 2);

			const hello = arbData.messages.get('helloWorld');
			assert.ok(hello);
			assert.strictEqual(hello.value, 'Hello World!');
			assert.strictEqual(hello.description, 'A friendly greeting');
			assert.ok(hello.offset > 0);
		});

		test('creates InlayHint with truncated label, tooltip, and click command', () => {
			const arbData: ArbData = {
				uri: vscode.Uri.file(testArbPath),
				filePath: testArbPath,
				locale: 'en',
				outputClass: 'AppLocalizations',
				messages: new Map([
					[
						'helloWorld',
						{
							value: 'Hello World!',
							offset: 20,
							description: 'A friendly greeting',
						},
					],
					[
						'longMessage',
						{
							value: '1234567890123456789012345678901234567890',
							offset: 100,
						},
					],
				]),
			};

			const pos = new vscode.Position(10, 5);
			const hint1 = createInlayHint(pos, 'helloWorld', arbData.messages.get('helloWorld')!, arbData, 35);
			assert.strictEqual(hint1.position.line, 10);
			assert.strictEqual(hint1.position.character, 5);
			assert.ok(Array.isArray(hint1.label));
			const part1 = (hint1.label as vscode.InlayHintLabelPart[])[0];
			assert.strictEqual(part1.value, ': "Hello World!"');
			assert.ok(part1.command);
			assert.strictEqual(part1.command.command, 'arb-editor.openArbKey');

			// Truncation test
			const hint2 = createInlayHint(pos, 'longMessage', arbData.messages.get('longMessage')!, arbData, 20);
			const part2 = (hint2.label as vscode.InlayHintLabelPart[])[0];
			assert.strictEqual(part2.value, ': "12345678901234567..."');
		});
	});
});
