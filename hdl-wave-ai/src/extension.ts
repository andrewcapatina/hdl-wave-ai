import * as vscode from 'vscode';
import * as path from 'path';
import { ChatPanel } from './chat/panel';
import { SignalTracker, getActiveDocumentUri } from './vaporview/api';
import { parseWaveformFile } from './waveform/fst';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('HDL Wave AI');
    const tracker = new SignalTracker(log);

    // Seed tracker from any signals already displayed in VaporView
    tracker.initialize();

    // Keep the chat panel's signal picker in sync with VaporView
    context.subscriptions.push(
        tracker.onSignalsChanged(({ signals }) => {
            ChatPanel.notifySignalsChanged(signals);
        })
    );

    const openChat = vscode.commands.registerCommand('hdl-wave-ai.openChat', () => {
        ChatPanel.createOrShow(tracker, log);
    });

    const openChatWithFile = vscode.commands.registerCommand(
        'hdl-wave-ai.openChatWithFile',
        async (contextUri?: vscode.Uri) => {
            // If invoked from the explorer context menu, contextUri is the clicked file.
            // If invoked from the command palette, show a file picker.
            let fileUri = contextUri;
            if (!fileUri) {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Waveform files': ['fst', 'vcd'] },
                    title: 'Select a waveform file to analyze',
                });
                if (!picked?.length) { return; }
                fileUri = picked[0];
            }

            const filePath = fileUri.fsPath;
            const title = path.basename(filePath);

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Parsing ${title}…`, cancellable: false },
                async () => {
                    try {
                        const result = await parseWaveformFile(filePath);
                        log.appendLine(`[File] Parsed ${title}: ${result.signals.length} signals, ${result.transitions.length} transitions, end=${result.endTime} ${result.timescale}`);

                        const ctx = {
                            uri: fileUri!.toString(),
                            signals: result.signals,
                            transitions: result.transitions,
                            startTime: 0,
                            endTime: result.endTime,
                        };

                        ChatPanel.createWithFile(ctx, title, tracker, log);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        log.appendLine(`[File] Error parsing ${title}: ${msg}`);
                        vscode.window.showErrorMessage(`HDL Wave AI: ${msg}`);
                    }
                }
            );
        }
    );

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

    // Forward VaporView marker events to the chat panel as prompt suggestions.
    // The event fires with { uri: UriObject, time: number, units: string } for each
    // individual marker placement — query getViewerState afterward to get both
    // markers (main + alt) at once.
    const vaporExt = vscode.extensions.getExtension('lramseyer.vaporview');
    const markerSub = vaporExt?.exports?.onDidSetMarker(
        async (e: { uri?: { external?: string; fsPath?: string }; time?: number; units?: string }) => {
            log.appendLine(`[Marker] onDidSetMarker: ${JSON.stringify(e)}`);
            const uri = e.uri?.external ?? (e.uri?.fsPath ? `file://${e.uri.fsPath}` : undefined);
            if (!uri) { return; }
            const state = await vscode.commands.executeCommand<{
                markerTime: number | null;
                altMarkerTime: number | null;
            }>('waveformViewer.getViewerState', { uri });
            ChatPanel.notifyMarkerSet(state?.markerTime ?? null, state?.altMarkerTime ?? null);
        }
    );
    if (markerSub) { context.subscriptions.push(markerSub); }

    context.subscriptions.push(openChat, openChatWithFile, debug, tracker, log);
}

export function deactivate() {}
