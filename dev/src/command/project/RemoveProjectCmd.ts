/*******************************************************************************
 * Copyright (c) 2018 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";
import * as rmrf from "rimraf";

import Translator from "../../constants/strings/translator";
import StringNamespaces from "../../constants/strings/StringNamespaces";
import Log from "../../Logger";
import * as MCUtil from "../../MCUtil";
import { promptForProject } from "../CommandUtil";
import Project from "../../microclimate/project/Project";
import Requester from "../../microclimate/project/Requester";

export default async function removeProjectCmd(project: Project): Promise<void> {
    if (project == null) {
        const selected = await promptForProject();
        if (selected == null) {
            // user cancelled
            Log.d("User cancelled project prompt");
            return;
        }
        project = selected;
    }

    await removeProject(project);
}

/**
 * @param prompt - Set this to `false` to skip prompting the user, and instead just do the unbind & delete silently.
 */
export async function removeProject(project: Project, prompt: boolean = true): Promise<void> {
    let doDeleteProjectDir: boolean;

    if (prompt) {
        const deleteMsg = Translator.t(StringNamespaces.CMD_MISC, "confirmDeleteProjectMsg", { projectName: project.name });
        const deleteBtn = Translator.t(StringNamespaces.CMD_MISC, "confirmDeleteBtn", { projectName: project.name });

        const deleteRes = await vscode.window.showInformationMessage(deleteMsg, { modal: true }, deleteBtn);
        if (deleteRes !== deleteBtn) {
            // cancelled
            return;
        }

        const projectDirPath: string = project.localPath.fsPath;

        const deleteDirMsg = Translator.t(StringNamespaces.CMD_MISC, "alsoDeleteDirMsg", { dirPath: projectDirPath });
        const deleteDirBtn = Translator.t(StringNamespaces.CMD_MISC, "alsoDeleteDirBtn");
        // const dontDeleteDirBtn = Translator.t(StringNamespaces.CMD_MISC, "dontDeleteDirBtn");
        // const deleteNeverBtn = Translator.t(StringNamespaces.CMD_MISC, "neverDeleteDirBtn");
        // const deleteAlwaysBtn = Translator.t(StringNamespaces.CMD_MISC, "alwaysDeleteDirBtn");
        const deleteDirRes = await vscode.window.showWarningMessage(deleteDirMsg, { modal: true },
            deleteDirBtn, /* dontDeleteDirBtn  deleteNeverBtn, deleteAlwaysBtn */);

        doDeleteProjectDir = deleteDirRes === deleteDirBtn;
    }
    else {
        doDeleteProjectDir = true;
    }

    if (doDeleteProjectDir) {
        project.doDeleteOnUnbind = true;
    }

    await Promise.all([
        Requester.requestUnbind(project),
        // doDeleteProjectDir ? deleteProjectDir(project) : Promise.resolve(),
    ]);
}

export async function deleteProjectDir(project: Project): Promise<void> {
    Log.i("Deleting project directory: " + project.localPath);
    const projectDirPath = project.localPath.fsPath;
    return vscode.window.withProgress({
        cancellable: false,
        location: vscode.ProgressLocation.Window,
        title: `Deleting ${projectDirPath}...`,
    }, (_progress) => {
        return new Promise<void>((resolve, _reject) => {
            rmrf(projectDirPath, { glob: false }, (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to delete ${project.name} directory: ${MCUtil.errToString(err)}`);
                }
                return resolve();
            });
        });
    });
}
