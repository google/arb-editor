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
import { getMemberAccessCandidates } from '../../codelens';

suite('AppLocalizations CodeLens', () => {
	test('does not match AppLocalizations.of in assignment', () => {
		const source = `
final l10n = AppLocalizations.of(context)!;
`;

		const candidates = getMemberAccessCandidates(source);
		assert.strictEqual(candidates.length, 0);
	});

	test('does not match static access on AppLocalizations', () => {
		const source = `
final delegates = AppLocalizations.localizationDelegates;
`;

		const candidates = getMemberAccessCandidates(source);
		assert.strictEqual(candidates.length, 0);
	});

	test('matches instance member access for l10n variables', () => {
		const source = `
Text(l10n.helloWorld);
print(someLoc.abcValue);
print(maybeLoc?.abcValue);
print(maybeLoc!.abcValue);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['l10n.helloWorld', 'someLoc.abcValue', 'maybeLoc.abcValue', 'maybeLoc.abcValue']
		);
	});

	test('ignores matches in comments and strings', () => {
		const source = `
// l10n.helloWorld should be ignored
final text = "maybeLoc.abcValue should be ignored";
print(realLoc.magic);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['realLoc.magic']
		);
	});

	test('ignores block comments and triple-quoted strings', () => {
		const source = `
/* l10n.blocked */
final text = '''
maybeLoc.ignoredInTriple
''';
print(okLoc.allowed);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['okLoc.allowed']
		);
	});

	test('ignores uppercase type-like receivers in general', () => {
		const source = `
Theme.of(context);
MyType.someStatic;
print(realLoc.actualUsage);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['realLoc.actualUsage']
		);
	});

	test('supports identifiers with underscores and digits', () => {
		const source = `
print(l10n_2.hello_world_3);
print(_localizations.value_1);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['l10n_2.hello_world_3', '_localizations.value_1']
		);
	});

	test('captures chained access only at first hop', () => {
		const source = `
print(l10n.helloWorld.length);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['l10n.helloWorld']
		);
	});

	test('keeps optional and non-null variants as same candidate shape', () => {
		const source = `
print(loc.value);
print(loc?.value);
print(loc!.value);
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['loc.value', 'loc.value', 'loc.value']
		);
	});

	test('matches direct AppLocalizations.of(context)! member access', () => {
		const source = `
AppLocalizations.of(context)!.abc;
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['AppLocalizations.abc']
		);
	});

	test('matches direct AppLocalizations.of(context)? member access', () => {
		const source = `
AppLocalizations.of(context)?.abc;
`;

		const candidates = getMemberAccessCandidates(source);
		assert.deepStrictEqual(
			candidates.map(candidate => `${candidate.identifier}.${candidate.member}`),
			['AppLocalizations.abc']
		);
	});
});
