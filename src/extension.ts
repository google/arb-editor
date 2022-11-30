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
import * as vscode from 'vscode';
import { ConfigurationTarget, workspace } from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const configuration = workspace.getConfiguration('files');
	// eslint-disable-next-line @typescript-eslint/naming-convention
	await configuration.update('associations', { "*.arb": "json" }, ConfigurationTarget.Global);
}

// This method is called when your extension is deactivated
export function deactivate() { }
