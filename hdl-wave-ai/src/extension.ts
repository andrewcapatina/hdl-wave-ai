import * as vscode from 'vscode';
import { ChatPanel } from './chat/panel';
import { SignalTracker, getActiveDocumentUri } from './vaporview/api';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('HDL Wave AI');
    const tracker = new SignalTracker(log);

    const openChat = vscode.commands.registerCommand('hdl-wave-ai.openChat', () => {
        ChatPanel.createOrShow(tracker, log);
    });

    const debug = vscode.commands.registerCommand('hdl-wave-ai.debug', async () => {
        log.show();

        // Check VaporView extension
        const ext = vscode.extensions.getExtension('lramseyer.vaporview');
        log.appendLine(`[Debug] VaporView found: ${!!ext}`);
        log.appendLine(`[Debug] VaporView active: ${ext?.isActive}`);
        log.appendLine(`[Debug] VaporView exports keys: ${Object.keys(ext?.exports ?? {}).join(', ')}`);

        // Check open documents
        const uri = await getActiveDocumentUri(log);
        log.appendLine(`[Debug] Active document URI: ${uri}`);

        // Raw getViewerState
        if (uri) {
            const state = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
            log.appendLine(`[Debug] getViewerState raw: ${JSON.stringify(state)}`);
        }

        // Tracked signals
        log.appendLine(`[Debug] Tracked signals: ${JSON.stringify(uri ? tracker.getSignals(uri) : [])}`);
    });

    context.subscriptions.push(openChat, debug, tracker, log);
}

export function deactivate() {}
