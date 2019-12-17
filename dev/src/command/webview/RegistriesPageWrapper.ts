/*******************************************************************************
 * Copyright (c) 2019 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";
// import * as fs from "fs";

import Connection from "../../codewind/connection/Connection";
import Resources from "../../constants/Resources";
import WebviewUtil from "./WebviewUtil";
import Log from "../../Logger";
import getManageRegistriesHtml from "./pages/RegistriesPage";
import Requester from "../../codewind/project/Requester";
import MCUtil from "../../MCUtil";
import RegistryUtils, { ContainerRegistry } from "../../codewind/connection/RegistryUtils";
import CWDocs from "../../constants/CWDocs";
import Commands from "../../constants/Commands";
import { WebviewWrapper, WebviewResourceProvider } from "./WebviewWrapper";

export enum ManageRegistriesWVMessages {
    ADD_NEW = "add-new",
    DELETE = "delete",
    // EDIT = "edit",
    CHANGE_PUSH = "change-push",
    HELP = "help",
    REFRESH = "refresh",
}

interface ManageRegistriesMsgData {
    readonly fullAddress: string;
}

function getTitle(connectionLabel: string): string {
    let title = "Image Registries";
    if (!global.isTheia) {
        title += ` (${connectionLabel})`;
    }
    return title;
}

export class RegistriesPageWrapper extends WebviewWrapper {

    private registries: ContainerRegistry[] = [];

    constructor(
        private readonly connection: Connection
    ) {
        super(getTitle(connection.label), Resources.Icons.Logo);
        connection.onDidOpenRegistriesPage(this);
        this.refresh();
    }

    protected async generateHtml(resourceProvider: WebviewResourceProvider): Promise<string> {
        this.registries = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
            title: `Fetching image registries...`,
        }, async () => {
            return Requester.getImageRegistries(this.connection);
        });

        const html = getManageRegistriesHtml(resourceProvider, this.connection.label, this.registries, this.connection.isKubeConnection);
        return html;
    }

    protected onDidDispose(): void {
        this.connection.onDidCloseRegistriesPage();
    }

    protected readonly handleWebviewMessage = async (msg: WebviewUtil.IWVMessage): Promise<void> => {
        switch (msg.type as ManageRegistriesWVMessages) {
            case ManageRegistriesWVMessages.ADD_NEW: {
                try {
                    await RegistryUtils.addNewRegistry(this.connection, this.registries);
                }
                catch (err) {
                    const errMsg = `Failed to add new image registry`;
                    Log.e(errMsg, err);
                    vscode.window.showErrorMessage(`${errMsg}: ${MCUtil.errToString(err)}`);
                }

                await this.refresh();
                break;
            }
            case ManageRegistriesWVMessages.CHANGE_PUSH: {
                const data = msg.data as ManageRegistriesMsgData;
                const pushRegistryToSet = this.lookupRegistry(data.fullAddress);
                if (pushRegistryToSet.isPushRegistry) {
                    // shouldn't happen, but nothing to do in this case
                    return;
                }

                try {
                    const updatedPushRegistry = await RegistryUtils.setPushRegistry(this.connection, pushRegistryToSet, true);
                    if (updatedPushRegistry) {
                        vscode.window.showInformationMessage(`Successfully changed push registry to ${updatedPushRegistry.fullAddress}`);
                    }
                }
                catch (err) {
                    const errMsg = `Failed to update push registry to ${pushRegistryToSet.fullAddress}`;
                    Log.e(errMsg, err);
                    vscode.window.showErrorMessage(`${errMsg}: ${MCUtil.errToString(err)}`);
                }

                await this.refresh();
                // this.registriesPage.webview.postMessage({ command: ManageRegistriesWVMessages.CHANGE_PUSH, fullAddress: );
                break;
            }
            case ManageRegistriesWVMessages.DELETE: {
                const data = msg.data as ManageRegistriesMsgData;
                const registry = this.lookupRegistry(data.fullAddress);

                if (registry.isPushRegistry) {
                    const continueBtn = "Remove Anyway";
                    const confirm = await vscode.window.showWarningMessage(
                        `${registry.fullAddress} is currently set as your image push registry. \n` +
                        `Removing it will cause Codewind-style project builds to fail until a new image push registry is selected.`,
                        { modal: true },
                        continueBtn
                    );
                    if (confirm !== continueBtn) {
                        return;
                    }
                }

                try {
                    await Requester.removeRegistrySecret(this.connection, registry);
                }
                catch (err) {
                    const errMsg = `Failed to remove registry ${registry.fullAddress}`;
                    Log.e(errMsg, err);
                    vscode.window.showErrorMessage(`${errMsg}: ${MCUtil.errToString(err)}`);
                }

                await this.refresh();
                break;
            }
            case ManageRegistriesWVMessages.HELP: {
                vscode.commands.executeCommand(Commands.VSC_OPEN, CWDocs.getDocLink(CWDocs.REGISTRIES));
                break;
            }
            case ManageRegistriesWVMessages.REFRESH: {
                await this.refresh();
                break;
            }
            default: {
                Log.e("Received unknown event from manage templates webview:", msg);
            }
        }
    }

    private lookupRegistry(fullAddress: string): ContainerRegistry {
        const matchingRegistry = this.registries.find((registry) => registry.fullAddress === fullAddress);
        if (!matchingRegistry) {
            Log.e(`No matching registry found, expected to find fullAddress ${fullAddress}, registries are:`, this.registries);
            throw new Error(`No registry was found with full address "${fullAddress}"`);
        }
        return matchingRegistry;
    }
}
