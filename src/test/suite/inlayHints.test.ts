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
	ArbData,
	L10N_MEMBER_ACCESS_REGEX,
	createInlayHint,
	escapeMarkdown,
	getArbData,
	invalidateArbCache,
	isLikelyLocalizationReceiver,
	parseYaml,
	sanitizeDartSource,
} from '../../inlayHints';

suite('Dart ARB Inlay Hints', () => {
	suite('sanitizeDartSource', () => {
		test('masks single-line comments with spaces while preserving newlines', () => {
			const source = '// l10n.hello\nText(l10n.hello);';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('l10n.hello\n'));
			assert.ok(sanitized.includes('Text(l10n.hello);'));
		});

		test('masks doc comments (///) with spaces', () => {
			const source = '/// See [context.l10n.hello]\nText(context.l10n.hello);';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('context.l10n.hello]'));
			assert.ok(sanitized.includes('Text(context.l10n.hello);'));
		});

		test('preserves code and string interpolation', () => {
			const source = 'final msg = "${l10n.greeting}"; // end of line comment';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(sanitized.includes('final msg = "${l10n.greeting}";'));
			assert.ok(!sanitized.includes('end of line comment'));
		});

		test('masks indented single-line comments', () => {
			const source = 'class Foo {\n  // l10n.hello\n  Text(l10n.hello);\n}';
			const sanitized = sanitizeDartSource(source);

			assert.strictEqual(sanitized.length, source.length);
			assert.ok(!sanitized.includes('// l10n.hello'));
			assert.ok(!sanitized.includes('  l10n.hello\n'));
			assert.ok(sanitized.includes('Text(l10n.hello);'));
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

	suite('parseYaml', () => {
		const tempDir = path.join(__dirname, 'temp_yaml_test');
		const validYamlPath = path.join(tempDir, 'valid.yaml');
		const invalidYamlPath = path.join(tempDir, 'invalid.yaml');

		suiteSetup(() => {
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}
			fs.writeFileSync(validYamlPath, 'arb-dir: lib/l10n\ntemplate-arb-file: app_en.arb\n', 'utf8');
			fs.writeFileSync(invalidYamlPath, ': invalid: yaml: [unclosed', 'utf8');
		});

		suiteTeardown(() => {
			if (fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		test('parses valid yaml', () => {
			const result = parseYaml(validYamlPath);
			assert.ok(result);
			assert.strictEqual(result['arb-dir'], 'lib/l10n');
			assert.strictEqual(result['template-arb-file'], 'app_en.arb');
		});

		test('returns undefined for non-existent file', () => {
			const result = parseYaml(path.join(tempDir, 'does_not_exist.yaml'));
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for invalid yaml without throwing', () => {
			const result = parseYaml(invalidYamlPath);
			assert.strictEqual(result, undefined);
		});
	});

	suite('escapeMarkdown', () => {
		test('escapes markdown formatting characters', () => {
			const raw = '**bold** _italic_ `code` [link](url) # heading ~strike~ > quote';
			const escaped = escapeMarkdown(raw);
			assert.strictEqual(escaped, '\\*\\*bold\\*\\* \\_italic\\_ \\`code\\` \\[link\\]\\(url\\) \\# heading \\~strike\\~ \\> quote');
		});

		test('preserves alphanumeric and simple punctuation', () => {
			const raw = 'Hello world, 123; how are you?';
			assert.strictEqual(escapeMarkdown(raw), raw);
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

		test('returns undefined for non-existent file', () => {
			const arbData = getArbData(path.join(tempDir, 'non_existent.arb'));
			assert.strictEqual(arbData, undefined);
		});

		test('supports different outputClass without stale cache', () => {
			const first = getArbData(testArbPath, 'AppLocalizations');
			assert.ok(first);
			assert.strictEqual(first.outputClass, 'AppLocalizations');

			const second = getArbData(testArbPath, 'CustomLocalizations');
			assert.ok(second);
			assert.strictEqual(second.outputClass, 'CustomLocalizations');
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
							description: 'A friendly greeting',
						},
					],
					[
						'longMessage',
						{
							value: '1234567890123456789012345678901234567890',
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
			assert.deepStrictEqual(part1.command.arguments, [arbData.uri, 'helloWorld']);
			assert.ok(hint1.tooltip);

			// Truncation test
			const hint2 = createInlayHint(pos, 'longMessage', arbData.messages.get('longMessage')!, arbData, 20);
			const part2 = (hint2.label as vscode.InlayHintLabelPart[])[0];
			assert.strictEqual(part2.value, ': "12345678901234567..."');
		});

		test('truncates multi-byte Unicode / emojis cleanly without splitting surrogate pairs', () => {
			const arbData: ArbData = {
				uri: vscode.Uri.file(testArbPath),
				filePath: testArbPath,
				locale: 'en',
				outputClass: 'AppLocalizations',
				messages: new Map([
					[
						'emojis',
						{
							value: '👋🎉🚀🌍✨❤️🔥💡',
						},
					],
				]),
			};

			const pos = new vscode.Position(0, 0);
			// 8 emojis. Truncating to 6 characters means max(0, 6 - 3) = 3 code points + '...'
			const hint = createInlayHint(pos, 'emojis', arbData.messages.get('emojis')!, arbData, 6);
			const part = (hint.label as vscode.InlayHintLabelPart[])[0];
			assert.strictEqual(part.value, ': "👋🎉🚀..."');
		});

		test('escapes markdown characters in tooltip', () => {
			const arbData: ArbData = {
				uri: vscode.Uri.file(testArbPath),
				filePath: testArbPath,
				locale: 'en',
				outputClass: 'AppLocalizations',
				messages: new Map([
					[
						'special_key',
						{
							value: 'Hello *world* and _stars_ [link]',
							description: 'Description with *stars* and [brackets]',
						},
					],
				]),
			};

			const pos = new vscode.Position(0, 0);
			const hint = createInlayHint(pos, 'special_key', arbData.messages.get('special_key')!, arbData, 50);
			const tooltip = hint.tooltip as vscode.MarkdownString;
			assert.ok(tooltip);
			assert.ok(tooltip.value.includes('**special\\_key**'));
			assert.ok(tooltip.value.includes('*Description with \\*stars\\* and \\[brackets\\]*'));
			assert.ok(tooltip.value.includes('> Hello \\*world\\* and \\_stars\\_ \\[link\\]'));
		});
	});
});
