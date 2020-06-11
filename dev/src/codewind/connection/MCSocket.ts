/*******************************************************************************
 * Copyright (c) 2018, 2020 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";
import io from "socket.io-client";

import Connection from "./Connection";
import Project from "../project/Project";
import Log from "../../Logger";
import SocketEvents from "./SocketEvents";
import Validator from "../project/Validator";
import projectOverviewCmd from "../../command/project/ProjectOverviewCmd";
import { CWConfigurations } from "../../constants/Configurations";
import { PFEProjectData } from "../Types";
import addProjectToWorkspaceCmd from "../../command/project/AddToWorkspaceCmd";
import MCUtil from "../../MCUtil";
import CWExtensionContext from "../../CWExtensionContext";
import { manageLogs } from "../../command/project/ManageLogsCmd";

/**
 * Receives and reacts to socket events from Portal
 *
 * Each Connection has exactly one socket
 */
export default class MCSocket implements vscode.Disposable {

    public readonly uri: string;
    private readonly socket: SocketIOClient.Socket;

    private _isConnected: boolean = false;
    private _isAuthorized: boolean = false;

    /**
     * Create a SocketIO connection to the server at the given URI.
     * Can throw an error.
     *
     * @param namespace - Socket namespace. Must not start with a slash. Can be the empty string.
     */
    constructor(
        private readonly connection: Connection,
        namespace: string,
    ) {
        this.uri = connection.url.toString();
        if (namespace) {
            if (!this.uri.endsWith("/")) {
                this.uri += "/";
            }
            this.uri += namespace;
        }
        Log.i("Creating MCSocket for URI", this.uri);

        const usingHttps = connection.url.scheme === "https";
        const timeout = 5000;
        const options: SocketIOClient.ConnectOpts = {
            rejectUnauthorized: !usingHttps,                    // TODO because of our self-signed certs
            secure: usingHttps,
            timeout,
        };

        if (!connection.isRemote) {
            Log.d(`${this} does not require authorization`);
            this._isAuthorized = true;
        }

        this.socket = io(this.uri, options);

        this.socket.connect();

        this.socket
            .on("connect", () => {
                this._isConnected = true;
                this.connection.onConnect();
            })
            .on("disconnect", () => {
                this._isConnected = false;
                this._isAuthorized = false;
                this.connection.onDisconnect();
            })

            // .on(SocketEvents.Types.PROJECT_BOUND,           this.onProjectBound)

            .on(SocketEvents.Types.PROJECT_CREATED,         this.onProjectCreation)
            .on(SocketEvents.Types.PROJECT_CHANGED,         this.onProjectChanged)
            .on(SocketEvents.Types.PROJECT_STATUS_CHANGED,  this.onProjectStatusChanged)
            .on(SocketEvents.Types.PROJECT_CLOSED,          this.onProjectClosed)

            .on(SocketEvents.Types.PROJECT_DELETION,        this.onProjectDeleted)
            .on(SocketEvents.Types.PROJECT_RESTART_RESULT,  this.onProjectRestarted)

            .on(SocketEvents.Types.PROJECT_VALIDATED,       this.onProjectValidated)
            .on(SocketEvents.Types.PROJECT_SETTING_CHANGED, this.onProjectSettingsChanged)
            .on(SocketEvents.Types.LOAD_RUNNER,             this.onLoadRunnerStatusChanged)
            .on(SocketEvents.Types.LOG_UPDATE,              this.onLogUpdate)
            .on(SocketEvents.Types.LOGS_LIST_CHANGED,       this.onLogsListChanged)
            .on(SocketEvents.Types.REGISTRY_STATUS,         this.onPushRegistryStatus)
            .on(SocketEvents.Types.MISSING_LOCAL_DIR,       this.onMissingLocalDir)
            .on(SocketEvents.Types.PROJECT_LINK,            this.onProjectLink)
            ;
    }

    public get isConnected(): boolean {
        return this._isConnected;
    }

    public get isAuthorized(): boolean {
        return !this.connection.isRemote || this._isAuthorized;
    }

    public get isReady(): boolean {
        return this._isConnected && this._isAuthorized;
    }

    /**
     * This MUST be called when the connection is removed.
     * If there are multiple sockets listening on the same connection,
     * the callbacks will be fired multiple times for the same event, which will lead to serious misbehaviour.
     */
    public async dispose(): Promise<void> {
        this.connection.onDisconnect();
        this.socket.disconnect();
    }

    public async authenticate(token: string): Promise<void> {
        Log.i(`Authenticating ${this}`);
        return new Promise<void>((resolve, reject) => {
            this.socket.emit("authentication", { token });

            // const timeoutS = 10;
            // const timeout = setTimeout(() => {
            //     reject(`Socket at ${this.uri} did not respond to authentication request within ${timeoutS} seconds. `
            //         + `Try refreshing the connection.`);
            // }, timeoutS * 1000);

            this.socket.on("authenticated", () => {
                Log.i(`Successfully authenticated ${this}`);
                // The authorization stays valid until we call socket.disconnect()
                this._isAuthorized = true;
                // clearTimeout(timeout);
                resolve();
            });
            this.socket.on("unauthorized", (payload: { message: string }) => {
                Log.e(`${this} received unauthorized event`, payload);
                // clearTimeout(timeout);
                reject(payload.message);
            });
        });
    }

    private readonly onProjectCreation = async (payload: PFEProjectData): Promise<void> => {
        // https://github.com/eclipse/codewind/issues/720#issuecomment-543801321
        // creation event is now, apparently, the same as changed event
        this.onProjectChanged(payload);
    }

    private readonly onProjectStatusChanged = async (payload: PFEProjectData): Promise<void> => {
        // Log.d("onProjectStatusChanged", payload);
        // portal emits the entire inf file with a statusChanged event, so we can treat this the same as projectChanged
        this.onProjectChanged(payload);
    }

    private readonly onProjectChanged = async (payload: PFEProjectData): Promise<void> => {
        // Log.d("onProjectChanged", payload);
        // Log.d(`PROJECT CHANGED name=${payload.name} appState=${payload.appStatus} ` +
                // `buildState=${payload.buildStatus} startMode=${payload.startMode}`);

        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        project.update(payload);
    }

    private readonly onProjectClosed = async (payload: PFEProjectData): Promise<void> => {
        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        this.onProjectChanged(payload);
    }

    private readonly onProjectDeleted = async (payload: SocketEvents.DeletionResult): Promise<void> => {
        Log.d(`Received deletion event for ${payload.projectID}`);

        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        await project.onDeletionEvent(payload);
    }

    private readonly onProjectRestarted = async (payload: SocketEvents.IProjectRestartedEvent): Promise<void> => {
        // Log.d("PROJECT RESTARTED", payload);

        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        project.onRestartEvent(payload);
    }

    private readonly onLogsListChanged = async (payload: SocketEvents.ILogsListChangedEvent): Promise<void> => {
        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        try {
            await project.logManager.onLogsListChanged(payload);
        }
        catch (err) {
            Log.e(`Error processing logs list changed event`, payload, err);
        }
    }

    private readonly onLogUpdate = async (payload: SocketEvents.ILogUpdateEvent): Promise<void> => {
        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        // Log.d(`Received log ${payload.logName} of length ${payload.logs.length} with reset ${payload.reset}`);
        project.logManager.onNewLogs(payload);
    }

    private readonly onProjectValidated = async (payload: { projectID: string, validationResults: SocketEvents.IValidationResult[] })
        : Promise<void> => {

        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        if (payload.validationResults != null) {
            Validator.validate(project, payload.validationResults);
        }
        else {
            Log.e("Backend didn't send result with validation event");
        }
    }

    private readonly onProjectSettingsChanged = async (payload: SocketEvents.IProjectSettingsEvent): Promise<void> => {
        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }
        // Log.d("projectSettingsChanged", payload);
        return project.onSettingsChangedEvent(payload);
    }

    private readonly onLoadRunnerStatusChanged = async (payload: SocketEvents.LoadRunnerStatusEvent): Promise<void> => {
        const project = await this.getProject(payload);
        if (project == null) {
            return;
        }

        try {
            await project.onLoadRunnerUpdate(payload);
        }
        catch (err) {
            Log.e("Uncaught error receiving load runner update", err);
            vscode.window.showErrorMessage(`Error processing load runner status for ${project.name}: ${MCUtil.errToString(err)}`);
        }
    }

    private readonly onPushRegistryStatus = async (payload: SocketEvents.IPushRegistryStatus): Promise<void> => {
        Log.d(`Received push registry status`, payload);
        if (payload.msg) {
            if (payload.imagePushRegistryTest) {
                vscode.window.showInformationMessage(payload.msg);
            }
            else {
                vscode.window.showErrorMessage(payload.msg);
            }
        }
    }

    private readonly onMissingLocalDir = async (payload: { projectID: string }): Promise<void> => {
        Log.d(`Received missing local dir for ${payload.projectID}`);
        const project = await this.getProject(payload);

        try {
            await project?.deleteFromConnection(false);
        }
        catch (err) {
            Log.e(`Error deleting project after local dir removed`, err);
        }
    }

    private readonly onProjectLink = async (payload: { projectID: string, name: string, status: string, error: string | null }): Promise<void> => {
        Log.d(`Link event for ${payload.name}`, payload);
        if (payload.error != null) {
            const errMsg = `Error linking ${payload.name}`;
            Log.e(errMsg, payload.error);
            vscode.window.showErrorMessage(`${errMsg}: ${MCUtil.errToString(payload.error)}`);
        }
    }

    // prevents multiple events from simultaneously requesting a projects refresh
    private refreshingProjectsProm: Promise<Project | undefined> | undefined;

    private readonly getProject = async (payload: { projectID: string }): Promise<Project | undefined> => {
        const projectID = payload.projectID;
        if (projectID == null) {
            // Should never happen
            Log.e("No projectID in socket event!", payload);
            return undefined;
        }

        if (this.refreshingProjectsProm) {
            await this.refreshingProjectsProm;
        }

        const existingProject = await this.connection.getProjectByID(projectID);
        if (existingProject) {
            return existingProject;
        }

        Log.w(`${this} received socket event for nonexistent project`, projectID);

        this.refreshingProjectsProm = this.connection.updateProjects().then(() => {
            return this.connection.getProjectByID(projectID);
        });
        const newProject = await this.refreshingProjectsProm;
        this.refreshingProjectsProm = undefined;

        if (!newProject) {
            Log.e(`Still did not find project with ID ${projectID} after refreshing projects list; socket event cannot be processed:`, payload);
            return undefined;
        }

        try {
            await this.onNewProject(newProject);
        }
        catch (err) {
            Log.e(`Error processing new project ${newProject.name}`, err);
            vscode.window.showErrorMessage(`${MCUtil.errToString(err)}`);
        }

        return newProject;
    }

    private readonly HIDE_NEW_LOGS_MSG_KEY: string = "show-new-logs-msg";

    private async onNewProject(newProject: Project): Promise<void> {
        Log.i(`Project ${newProject.name} has been created`);

        if (CWConfigurations.OVERVIEW_ON_CREATION.get()) {
            projectOverviewCmd(newProject);
        }

        if (CWConfigurations.LOGS_ON_CREATION.get()) {
            if (!CWExtensionContext.get().globalState.get<boolean>(this.HIDE_NEW_LOGS_MSG_KEY)) {
                const configureBtn = "Configure";
                const dontShowAgainBtn = "Don't show again";

                vscode.window.showInformationMessage(`Build and application logs for the new project will be shown as they become available.`,
                    configureBtn, dontShowAgainBtn,
                ).then((res) => {
                    if (res === configureBtn) {
                        CWConfigurations.LOGS_ON_CREATION.openUI();
                    }
                    else if (res === dontShowAgainBtn) {
                        CWExtensionContext.get().globalState.update(this.HIDE_NEW_LOGS_MSG_KEY, true);
                    }
                });
            }
            manageLogs(newProject, "show-from-creation");
        }

        if (!newProject.isInVSCodeWorkspace) {
            if (CWConfigurations.ADD_NEW_PROJECTS_TO_WORKSPACE.get()) {
                addProjectToWorkspaceCmd(newProject);
            }
            else {
                vscode.window.showWarningMessage(`${newProject.name} is not in your VS Code workspace. ` +
                    `Right click the project in the Codewind view and run the Add Project to Workspace command to add it.`);
            }
        }
    }

    public toString(): string {
        return "MCSocket @ " + this.uri;        // not displayed to user        // non-nls
    }
}
