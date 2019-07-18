/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { commands, Disposable, Extension, extensions, MessageItem, ProgressLocation, window } from 'vscode';
import * as types from '../../index';
import { AzureAccount, AzureLoginStatus, AzureResourceFilter } from '../azure-account.api';
import { UserCancelledError } from '../errors';
import { ext } from '../extensionVariables';
import { localize } from '../localize';
import { TestAzureAccount } from '../TestAzureAccount';
import { nonNullProp, nonNullValue } from '../utils/nonNull';
import { AzureWizardPromptStep } from '../wizard/AzureWizardPromptStep';
import { AzExtParentTreeItem } from './AzExtParentTreeItem';
import { AzExtTreeItem } from './AzExtTreeItem';
import { GenericTreeItem } from './GenericTreeItem';
import { SubscriptionTreeItemBase } from './SubscriptionTreeItemBase';

const signInLabel: string = localize('signInLabel', 'Sign in to Azure...');
const createAccountLabel: string = localize('createAccountLabel', 'Create a Free Azure Account...');
const selectSubscriptionsLabel: string = localize('noSubscriptions', 'Select Subscriptions...');
const signInCommandId: string = 'azure-account.login';
const createAccountCommandId: string = 'azure-account.createAccount';
const selectSubscriptionsCommandId: string = 'azure-account.selectSubscriptions';
const azureAccountExtensionId: string = 'ms-vscode.azure-account';
const extensionOpenCommand: string = 'extension.open';

export abstract class AzureAccountTreeItemBase extends AzExtParentTreeItem implements types.AzureAccountTreeItemBase {
    public static contextValue: string = 'azureextensionui.azureAccount';
    public readonly contextValue: string = AzureAccountTreeItemBase.contextValue;
    public readonly label: string = 'Azure';
    public readonly childTypeLabel: string = localize('subscription', 'subscription');
    public autoSelectInTreeItemPicker: boolean = true;
    public disposables: Disposable[] = [];

    private _azureAccountTask: Promise<AzureAccount | undefined>;
    private _subscriptionTreeItems: SubscriptionTreeItemBase[] | undefined;

    constructor(parent?: AzExtParentTreeItem, testAccount?: TestAzureAccount) {
        super(parent);
        this._azureAccountTask = this.loadAzureAccount(testAccount);
    }

    //#region Methods implemented by base class
    public abstract createSubscriptionTreeItem(root: types.ISubscriptionContext): SubscriptionTreeItemBase | Promise<SubscriptionTreeItemBase>;
    //#endregion

    public dispose(): void {
        Disposable.from(...this.disposables).dispose();
    }

    public hasMoreChildrenImpl(): boolean {
        return false;
    }

    public async loadMoreChildrenImpl(_clearCache: boolean, context: types.IActionContext): Promise<AzExtTreeItem[]> {
        const azureAccount: AzureAccount | undefined = await this._azureAccountTask;
        if (!azureAccount) {
            context.telemetry.properties.accountStatus = 'notInstalled';
            const label: string = localize('installAzureAccount', 'Install Azure Account Extension...');
            const result: AzExtTreeItem = new GenericTreeItem(this, { label, commandId: extensionOpenCommand, contextValue: 'installAzureAccount', includeInTreeItemPicker: true });
            result.commandArgs = [azureAccountExtensionId];
            return [result];
        }

        context.telemetry.properties.accountStatus = azureAccount.status;
        const existingSubscriptions: SubscriptionTreeItemBase[] = this._subscriptionTreeItems ? this._subscriptionTreeItems : [];
        this._subscriptionTreeItems = [];

        const contextValue: string = 'azureCommand';
        if (azureAccount.status === 'Initializing' || azureAccount.status === 'LoggingIn') {
            return [new GenericTreeItem(this, {
                label: azureAccount.status === 'Initializing' ? localize('loadingTreeItem', 'Loading...') : localize('signingIn', 'Waiting for Azure sign-in...'),
                commandId: signInCommandId,
                contextValue,
                id: signInCommandId,
                iconPath: {
                    light: path.join(__filename, '..', '..', '..', '..', 'resources', 'light', 'Loading.svg'),
                    dark: path.join(__filename, '..', '..', '..', '..', 'resources', 'dark', 'Loading.svg')
                }
            })];
        } else if (azureAccount.status === 'LoggedOut') {
            return [
                new GenericTreeItem(this, { label: signInLabel, commandId: signInCommandId, contextValue, id: signInCommandId, includeInTreeItemPicker: true }),
                new GenericTreeItem(this, { label: createAccountLabel, commandId: createAccountCommandId, contextValue, id: createAccountCommandId, includeInTreeItemPicker: true })
            ];
        }

        await azureAccount.waitForFilters();

        if (azureAccount.filters.length === 0) {
            return [
                new GenericTreeItem(this, { label: selectSubscriptionsLabel, commandId: selectSubscriptionsCommandId, contextValue, id: selectSubscriptionsCommandId, includeInTreeItemPicker: true })
            ];
        } else {
            this._subscriptionTreeItems = await Promise.all(azureAccount.filters.map(async (filter: AzureResourceFilter) => {
                const existingTreeItem: SubscriptionTreeItemBase | undefined = existingSubscriptions.find(ti => ti.id === filter.subscription.id);
                if (existingTreeItem) {
                    // Return existing treeItem (which might have many 'cached' tree items underneath it) rather than creating a brand new tree item every time
                    return existingTreeItem;
                } else {
                    // filter.subscription.id is the The fully qualified ID of the subscription (For example, /subscriptions/00000000-0000-0000-0000-000000000000) and should be used as the tree item's id for the purposes of OpenInPortal
                    // filter.subscription.subscriptionId is just the guid and is used in all other cases when creating clients for managing Azure resources
                    return await this.createSubscriptionTreeItem({
                        credentials: filter.session.credentials,
                        subscriptionDisplayName: nonNullProp(filter.subscription, 'displayName'),
                        subscriptionId: nonNullProp(filter.subscription, 'subscriptionId'),
                        subscriptionPath: nonNullProp(filter.subscription, 'id'),
                        tenantId: filter.session.tenantId,
                        userId: filter.session.userId,
                        environment: filter.session.environment
                    });
                }
            }));
            return this._subscriptionTreeItems;
        }
    }

    public async getSubscriptionPromptStep(context: Partial<types.ISubscriptionWizardContext> & types.IActionContext): Promise<types.AzureWizardPromptStep<types.ISubscriptionWizardContext> | undefined> {
        const subscriptions: SubscriptionTreeItemBase[] = await this.ensureSubscriptionTreeItems(context);
        if (subscriptions.length === 1) {
            Object.assign(context, subscriptions[0].root);
            return undefined;
        } else {
            // tslint:disable-next-line: no-var-self
            const me: AzureAccountTreeItemBase = this;
            class SubscriptionPromptStep extends AzureWizardPromptStep<types.ISubscriptionWizardContext> {
                public async prompt(): Promise<void> {
                    const ti: SubscriptionTreeItemBase = <SubscriptionTreeItemBase>await me.treeDataProvider.showTreeItemPicker(SubscriptionTreeItemBase.contextValue, context);
                    Object.assign(context, ti.root);
                }
                public shouldPrompt(): boolean { return !(<types.ISubscriptionWizardContext>context).subscriptionId; }
            }
            return new SubscriptionPromptStep();
        }
    }

    public async pickTreeItemImpl(_expectedContextValues: (string | RegExp)[]): Promise<AzExtTreeItem | undefined> {
        const azureAccount: AzureAccount | undefined = await this._azureAccountTask;
        if (azureAccount && (azureAccount.status === 'LoggingIn' || azureAccount.status === 'Initializing')) {
            const title: string = localize('waitingForAzureSignin', 'Waiting for Azure sign-in...');
            // tslint:disable-next-line: no-non-null-assertion
            await window.withProgress({ location: ProgressLocation.Notification, title }, async (): Promise<boolean> => await azureAccount!.waitForSubscriptions());
        }

        return undefined;
    }

    private async loadAzureAccount(azureAccount: AzureAccount | undefined): Promise<AzureAccount | undefined> {
        if (!azureAccount) {
            const extension: Extension<AzureAccount> | undefined = extensions.getExtension<AzureAccount>(azureAccountExtensionId);
            if (extension) {
                if (!extension.isActive) {
                    await extension.activate();
                }

                azureAccount = extension.exports;
            }
        }

        if (azureAccount) {
            this.disposables.push(azureAccount.onFiltersChanged(async () => await this.refresh()));
            this.disposables.push(azureAccount.onStatusChanged(async (status: AzureLoginStatus) => {
                // Ignore status change to 'LoggedIn' and wait for the 'onFiltersChanged' event to fire instead
                // (so that the tree stays in 'Loading...' state until the filters are actually ready)
                if (status !== 'LoggedIn') {
                    await this.refresh();
                }
            }));
            await commands.executeCommand('setContext', 'isAzureAccountInstalled', true);
        }

        return azureAccount;
    }

    private async ensureSubscriptionTreeItems(context: types.IActionContext): Promise<SubscriptionTreeItemBase[]> {
        const azureAccount: AzureAccount | undefined = await this._azureAccountTask;
        if (!azureAccount) {
            context.telemetry.properties.cancelStep = 'requiresAzureAccount';
            const message: string = localize('requiresAzureAccount', "This functionality requires installing the Azure Account extension.");
            const viewInMarketplace: MessageItem = { title: localize('viewInMarketplace', "View in Marketplace") };
            if (await ext.ui.showWarningMessage(message, viewInMarketplace) === viewInMarketplace) {
                await commands.executeCommand(extensionOpenCommand, azureAccountExtensionId);
            }

            throw new UserCancelledError();
        }

        if (!this._subscriptionTreeItems) {
            await this.getCachedChildren(context);
        }

        return nonNullValue(this._subscriptionTreeItems, 'subscriptionTreeItems');
    }
}