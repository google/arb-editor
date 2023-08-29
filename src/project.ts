import * as fs from "fs";
import * as path from "path";
import { Uri, workspace } from "vscode";

export const UPGRADE_TO_WORKSPACE_FOLDERS = "Mark Projects as Workspace Folders";

export function locateL10nYaml(folder: string): string | undefined {
    if (!folder || (!isWithinWorkspace(folder) && workspace.workspaceFolders?.length)) {
        return undefined;
    }

    let dir = folder;
    while (dir !== path.dirname(dir)) {
        if (hasL10nYaml(dir)) {
            return path.join(dir, "l10n.yaml");
        }
        dir = path.dirname(dir);
    }

    return undefined;
}

function hasL10nYaml(folder: string): boolean {
    return fs.existsSync(path.join(folder, "l10n.yaml"));
}

function isWithinWorkspace(file: string) {
    return !!workspace.getWorkspaceFolder(Uri.file(file));
}