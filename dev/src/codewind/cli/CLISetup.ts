/*******************************************************************************
 * Copyright (c) 2020 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
// we use fs here because it supports withFileTypes for readdir
import * as nodefs from "fs";
// we use fs-extra for everything else
import * as fs from "fs-extra";
import * as crypto from "crypto";
import got from "got";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

import Log from "../../Logger";
import Constants from "../../constants/Constants";
import MCUtil from "../../MCUtil";
import Requester from "../Requester";
import CWExtensionContext from "../../CWExtensionContext";

namespace CLISetup {

    export const DOT_CODEWIND_DIR = path.join(os.homedir(), ".codewind");

    export const CWCTL_DOWNLOAD_NAME = "cwctl";
    const CWCTL_BASENAME = MCUtil.getOS() === "windows" ? "cwctl.exe" : "cwctl";

    export const APPSODY_DOWNLOAD_NAME = "appsody";
    const APPSODY_BASENAME = MCUtil.getOS() === "windows" ? "appsody.exe" : "appsody";

    let binariesTargetDir: string | undefined;
    /**
     * Eg ~/.codewind/0.9.0
     */
    export function getBinariesTargetDir(): string {
        if (!binariesTargetDir) {
            binariesTargetDir = path.join(DOT_CODEWIND_DIR, CWExtensionContext.get().codewindImageTag)
        }
        return binariesTargetDir;
    }

    let cwctlPath: string | undefined;
    /**
     * The absolute path to the cwctl executable after it's set up, eg ~/.codewind/0.9.0/cwctl
     */
    export function getCwctlPath(): string {
        if (!cwctlPath) {
            cwctlPath = path.join(getBinariesTargetDir(), CWCTL_BASENAME);
        }
        return cwctlPath
    }

    let appsodyPath: string | undefined;
    /**
     * The absolute path to the appsody executable after it's set up, eg ~/.codewind/0.9.0/appsody
     */
    export function getAppsodyPath(): string {
        if (!appsodyPath) {
            appsodyPath = path.join(getBinariesTargetDir(), APPSODY_BASENAME);
        }
        return appsodyPath;
    }

    /**
     * Ensures that the BINARIES_TARGET_DIR exists.
     * @returns True if it already existed, false if it was created.
     */
    export async function doesBinariesTargetDirExist(): Promise<boolean> {
        let existed = true;

        try {
            await fs.ensureDir(DOT_CODEWIND_DIR);
        }
        catch (err) {
            await fs.mkdir(DOT_CODEWIND_DIR);
            Log.d(`Created ${DOT_CODEWIND_DIR}`);
            existed = false;
        }

        try {
            if (existed) {
                await fs.access(getBinariesTargetDir());
            }
        }
        catch (err) {
            existed = false;
        }
        finally {
            if (!existed) {
                await fs.ensureDir(getBinariesTargetDir());
                Log.d(`Created ${getBinariesTargetDir()}`);
            }
        }

        return existed;
    }

    /**
     * Returns if cwctl is found at the expected path, is executable, and matches the latest shasum from the download site.
     */
    export async function isCwctlSetup(): Promise<boolean> {
        try {
            await fs.access(getCwctlPath(), fs.constants.X_OK);
        }
        catch (err) {
            Log.d(`${getCwctlPath()} was not found or not executable`);
            return false;
        }

        Log.d(`${getCwctlPath()} exists and is executable`);

        if (!!process.env[Constants.ENV_CWCTL_DEVMODE]) {
            Log.i(`cwctl devmode is enabled; skipping sha check`);
            return true;
        }

        const [ expectedHash, actualHash ]: string[] = await Promise.all([
            getLatestCwctlSha1(),
            getOnDiskCwctlSha1(),
        ]);

        if (expectedHash !== actualHash) {
            Log.i(`Latest CLI hash ${expectedHash} did not match CLI on disk ${actualHash}; an update is required.`);
            // Delete the invalid executable
            await fs.unlink(getCwctlPath());
            return false;
        }

        Log.i(`cwctl matches latest from download site.`);
        return true;
    }

    /**
     * Returns if appsody is found at the expect path, is executable, and matches the expected version.
     */
    export async function isAppsodySetup(): Promise<boolean> {
        try {
            await fs.access(getAppsodyPath(), fs.constants.X_OK);
        }
        catch (err) {
            Log.d(`${getAppsodyPath()} was not found or not executable`);
            return false;
        }

        Log.d(`${getAppsodyPath()} exists and is executable`);

        if (!!process.env[Constants.ENV_APPSODY_DEVMODE]) {
            Log.i(`appsody devmode is enabled; skipping version check`);
            return true;
        }

        let versionOutput;
        try {
            versionOutput = await execFileAsync(getAppsodyPath(), [ "version" ]);
        }
        catch (err) {
            Log.w(`Unexpected error running "${getAppsodyPath()} version"`, err);
            return false;
        }

        if (versionOutput.stderr) {
            Log.e(`Unexpected error output from appsody version`, versionOutput.stderr);
        }

        // The output is eg "appsody 0.5.9"
        const currentVersion = versionOutput.stdout.trim().split(" ")[1];
        const isCorrectVersion = currentVersion === CWExtensionContext.get().appsodyVersion;

        if (isCorrectVersion) {
            Log.i(`Appsody binary is the correct version ${currentVersion}`);
        }
        else {
            Log.i(`Appsody version "${currentVersion}" doesn't match expected "${CWExtensionContext.get().appsodyVersion}"`);
            // Delete the invalid executable
            await fs.unlink(getAppsodyPath());
        }
        return isCorrectVersion;
    }

    /**
     * @returns The download site directory that contains the cwctl builds that this version of the extension should use.
     */
    function getCwctlDirectoryUrl(): string {
        let cliBranch = CWExtensionContext.get().codewindImageTag;
        if (cliBranch === Constants.CODEWIND_IMAGE_VERSION_DEV) {
            cliBranch = "master";
        }
        return `https://download.eclipse.org/codewind/codewind-installer/${cliBranch}/latest/`;
    }

    /**
     * @returns The sha1 of the latest cwctl build for this OS according to the download site.
     */
    async function getLatestCwctlSha1(): Promise<string> {
        const cliDownloadBaseUrl = getCwctlDirectoryUrl();
        const propertiesFileUrl = cliDownloadBaseUrl + "build_info.properties";

        Log.d(`Downloading ${propertiesFileUrl}`);
        const latestPropertiesResponse = got.get(propertiesFileUrl, {
            responseType: "text",
        });

        const slowDlTimeout = setTimeout(() => {
            Log.d(`Properties file download is slow`);
            vscode.window.withProgress({
                cancellable: false,
                location: vscode.ProgressLocation.Notification,
                title: `Checking the ${CWCTL_BASENAME} version is taking longer than usual, please be patient...`
            }, async () => {
                try {
                    await latestPropertiesResponse;
                }
                catch (err) {
                    // swallow the error, it will be thrown below too.
                }
            });
        }, 5000);

        let latestCLIProperties;
        try {
            latestCLIProperties = (await latestPropertiesResponse).body;
        }
        catch (err) {
            if (err.toString().includes("HTTPError")) {
                // too bad the url isn't always in the error message
                err.message += ` - ${propertiesFileUrl}`;
            }
            throw err;
        }
        finally {
            clearTimeout(slowDlTimeout);
        }

        Log.d(`CLI properties from ${propertiesFileUrl}:\n`, latestCLIProperties);

        const propertiesLines = latestCLIProperties.split("\n");

        const shaProperty = `build_info.${getCwctlOS()}.SHA-1=`;
        const osLine = propertiesLines.find((line) => line.startsWith(shaProperty));
        if (osLine == null) {
            throw new Error(`Properties file did not match expected format; "${shaProperty}" was not found.`);
        }
        const sha1 = osLine.substring(shaProperty.length).trim();
        return sha1;
    }

    /**
     * The build site uses slightly different operating system names from this extension.
     * @returns The OS the cwctl build site uses.
     */
    function getCwctlOS(): "win" | "macos" | "linux" {
        const ourOS = MCUtil.getOS();
        if (ourOS === "windows") {
            return "win";
        }
        else if (ourOS === "darwin") {
            return "macos";
        }
        else if (ourOS !== "linux") {
            Log.e(`Unrecognized operating system ${ourOS}`);
        }
        return "linux";
    }

    /**
     * @returns The sha1 of the cwctl currently on disk.
     */
    async function getOnDiskCwctlSha1(): Promise<string> {
        const sha1 = crypto.createHash("sha1");

        return new Promise<string>((resolve, reject) => {
            fs.createReadStream(getCwctlPath())
            .on("error", (err) => {
                reject(err);
            })
            .on("data", (data) => {
                sha1.update(data);
            })
            .on("close", () => {
                const hash = sha1.digest("hex");
                resolve(hash.toString());
            });
        });
    }

    /**
     * @returns The binary name for this OS on the download site, eg "cwctl-win.exe"
     */
    function getCwctlDownloadBinaryName(): string {
        const cwctlOS = getCwctlOS();
        const extension = cwctlOS === "win" ? ".exe" : "";
        return `${CWCTL_DOWNLOAD_NAME}-${cwctlOS}${extension}`;
    }

    /**
     * @returns The url to the cwctl targz file download.
     */
    export function getCwctlArchiveDownloadUrl(): string {
        // eg http://download.eclipse.org/codewind/codewind-installer/master/latest/zips/cwctl-win.exe.tar.gz
        return getCwctlDirectoryUrl() + "zips/" + getCwctlDownloadBinaryName() + ".tar.gz";
    }

    const EXECUTABLES_MODE = 0o755;

    /**
     * Download cwctl.tar.gz, unzip it, move it to the expected location, and give it the required permissions.
     */
    export async function downloadCwctl(): Promise<string> {
        Log.i(`Downloading cwctl`);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
            title: `Downloading the Codewind CLI`,
        }, async (progress) => {
            const cwctlArchiveDownloadUrl = getCwctlArchiveDownloadUrl();
            const cwctlArchiveTargetPath = path.join(getBinariesTargetDir(), path.basename(cwctlArchiveDownloadUrl));

            await Requester.httpWriteStreamToFile(cwctlArchiveDownloadUrl, cwctlArchiveTargetPath, {
                destFileMode: EXECUTABLES_MODE,
                progress,
                progressEndPercent: 90,
            });

            progress.report({ message: `Extracting ${cwctlArchiveTargetPath}`, increment: 5 });

            const cwctlTargetDir = path.dirname(getCwctlPath());

            const extracted = await MCUtil.extractTar(cwctlArchiveTargetPath, cwctlTargetDir);
            const extractCwctlFilename = extracted.find((file) => file.startsWith(CWCTL_DOWNLOAD_NAME));
            if (!extractCwctlFilename) {
                throw new Error("Did not find cwctl after extracting cwctl archive");
            }
            const extractCwctlPath = path.join(cwctlTargetDir, extractCwctlFilename);

            progress.report({ message: `Finishing up`, increment: 5 });

            await Promise.all([
                fs.rename(extractCwctlPath, getCwctlPath())
                .then(() => {
                    fs.chmod(getCwctlPath(), EXECUTABLES_MODE);
                }),
                fs.unlink(cwctlArchiveTargetPath),
            ]);
        });

        Log.i("Finished cwctl setup");

        return getCwctlPath();
    }

    /**
     * @returns The URL to the Appsody tar.gz for this OS on the GitHub releases site.
     */
    export function getAppsodyDownloadUrl(): string {
        // appsody uses the same OS's as us, but suffixes "amd64" to non-windows builds.
        const ourOS = MCUtil.getOS();
        const appsodyOS = ourOS === "windows" ? ourOS : `${ourOS}-amd64`;

        // eg https://github.com/appsody/appsody/releases/download/0.5.9/appsody-0.5.9-darwin-amd64.tar.gz
        return `https://github.com/appsody/appsody/releases/download/` +
            `${CWExtensionContext.get().appsodyVersion}/${APPSODY_DOWNLOAD_NAME}-${CWExtensionContext.get().appsodyVersion}-${appsodyOS}.tar.gz`;
    }

    /**
     * Download appsody, unzip it, move it to the expected location, and give it the required permissions.
     */
    export async function downloadAppsody(): Promise<string> {
        Log.i(`Downloading Appsody`);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
            title: `Downloading the Appsody CLI`,
        }, async (progress) => {
            const appsodyDownloadUrl = getAppsodyDownloadUrl();
            const appsodyArchiveFile = path.join(getBinariesTargetDir(), path.basename(appsodyDownloadUrl));

            await Requester.httpWriteStreamToFile(appsodyDownloadUrl, appsodyArchiveFile, {
                destFileMode: EXECUTABLES_MODE,
                progress,
                progressEndPercent: 90,
            });

            progress.report({ message: `Extracting ${appsodyArchiveFile}`, increment: 5 });

            await MCUtil.extractTar(appsodyArchiveFile, path.dirname(getAppsodyPath()), [ APPSODY_BASENAME ]);

            progress.report({ message: `Finishing up`, increment: 5 });

            await Promise.all([
                fs.chmod(getAppsodyPath(), EXECUTABLES_MODE),
                fs.unlink(appsodyArchiveFile),
            ]);
        });

        Log.d(`Finished appsody setup`);

        return getAppsodyPath();
    }

    export async function lsBinariesTargetDir(): Promise<void> {
        const files = await fs.readdir(getBinariesTargetDir());
        Log.d(`Contents of ${getBinariesTargetDir()}: ${files.join(" ")}`);
    }

    /**
     * Delete all dirs for older releases.
     * @param deleteCurrent - Delete the current version (matches the image version, or 'latest') of the binaries too. For test usage only!!
     */
    export async function deleteOldBinaryDirs(deleteCurrent: boolean = false): Promise<void> {
        const binaryDirs = (await promisify(nodefs.readdir)(DOT_CODEWIND_DIR, { withFileTypes: true }))
        .filter((entry) => {
            if (!entry.isDirectory()) {
                return false;
            }
            else if (!deleteCurrent &&
                (entry.name === CWExtensionContext.get().extensionVersion || entry.name === Constants.CODEWIND_IMAGE_VERSION_DEV)) {

                // Don't delete the current version, or latest
                return false;
            }
            return MCUtil.couldBeCodewindVersion(entry.name, deleteCurrent);
        })
        .map((entry) => entry.name);

        let deletedCount = 0;

        await Promise.all(binaryDirs.map(async (binaryDir) => {
            const pathToDelete = path.join(DOT_CODEWIND_DIR, binaryDir);
            try {
                await fs.remove(pathToDelete);
                Log.d(`Deleted ${pathToDelete}`);
                deletedCount++;
            }
            catch (err) {
                Log.e(`Failed to delete ${pathToDelete}`, err);
            }
        }));

        if (binaryDirs.length === 0) {
            Log.d(`No old binary dirs to delete`);
        }
        else {
            Log.i(`Deleted ${deletedCount} old binary dirs`);
        }
    }
}

export default CLISetup;
