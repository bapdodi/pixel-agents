import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  getProjectDirPath,
  launchNewTerminal,
  persistAgents,
  removeAgent,
  restoreAgents,
  sendExistingAgents,
  sendLayout,
  sendTextToTerminal,
} from './agentManager.js';
import type { LoadedAssets } from './assetLoader.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
  mergeLoadedAssets,
  sendAssetsToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendWallTilesToWebview,
} from './assetLoader.js';
import { readConfig, writeConfig } from './configPersistence.js';
import {
  GLOBAL_KEY_LAST_SEEN_VERSION,
  GLOBAL_KEY_SOUND_ENABLED,
  LAYOUT_REVISION_KEY,
  WORKSPACE_KEY_AGENT_SEATS,
} from './constants.js';
import { ensureProjectScan } from './fileWatcher.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { readLayoutFromFile, watchLayoutFile, writeLayoutToFile } from './layoutPersistence.js';
import type { AgentState } from './types.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
  nextAgentId = { current: 1 };
  nextTerminalIndex = { current: 1 };
  agents = new Map<number, AgentState>();
  webviewView: vscode.WebviewView | undefined;

  // Per-agent timers
  fileWatchers = new Map<number, fs.FSWatcher>();
  pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
  permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // /clear detection: project-level scan for new JSONL files
  activeAgentId = { current: null as number | null };
  knownJsonlFiles = new Set<string>();
  projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };

  // Bundled default layout (loaded from assets/default-layout.json)
  defaultLayout: Record<string, unknown> | null = null;

  // Root path of bundled assets (set once on first load)
  private assetsRoot: string | null = null;

  // Cross-window layout sync
  layoutWatcher: LayoutWatcher | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  private persistAgents = async (): Promise<void> => {
    await persistAgents(this.agents, this.context);
  };

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.context.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'openClaude') {
        console.log(`[Extension] 🚀 Manual trigger for Agent ${message.providerId}`);
        await launchNewTerminal(
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.activeAgentId,
          this.knownJsonlFiles,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          this.jsonlPollTimers,
          this.projectScanTimer,
          () => this.webview,
          this.persistAgents,
          {
            providerId: (message.providerId as string) || 'claude',
            folderPath: message.folderPath as string | undefined,
            bypassPermissions: message.bypassPermissions as boolean | undefined,
          },
        );

      } else if (message.type === 'webviewError') {
        console.error(`[Webview Error] ${JSON.stringify(message.error)}`);
        vscode.window.showErrorMessage(`Pixel Agents Webview Error: ${message.error.message}`);
      } else if (message.type === 'webviewLog') {
        // Improved Diagnostic Logging
        const level = (message.level as string).toUpperCase();
        const args = Array.isArray(message.args) ? message.args.join(' ') : String(message.args);
        console.log(`[Webview ${level}] ${args}`);
      } else if (message.type === 'sendAgentCommand') {
        const id = Number(message.id);
        const text = message.text as string;
        sendTextToTerminal(id, text, this.agents);

      } else if (message.type === 'agentTerminalInput') {
        const id = Number(message.id);
        const input = message.input as string;
        const agent = this.agents.get(id);
        if (agent?.pty) {
          agent.pty.ptyProcess.write(input);
        }

      } else if (message.type === 'focusAgent') {
        const id = Number(message.id);
        if (this.agents.has(id)) {
          this.activeAgentId.current = id;
        }
      } else if (message.type === 'closeAgent') {
        const id = Number(message.id);
        const agent = this.agents.get(id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.dispose();
          } else {
            agent.pty?.dispose();
          }
        }
      } else if (message.type === 'saveAgentSeats') {
        await this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        await writeLayoutToFile(message.layout as Record<string, unknown>);
      } else if (message.type === 'setSoundEnabled') {
        await this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'setLastSeenVersion') {
        await this.context.globalState.update(GLOBAL_KEY_LAST_SEEN_VERSION, message.version as string);
      } else if (message.type === 'webviewReady') {
        console.log('[Extension] 🟢 Webview Ready report received');
        await restoreAgents(
          this.context,
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.knownJsonlFiles,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          this.jsonlPollTimers,
          this.projectScanTimer,
          this.activeAgentId,
          () => this.webview,
          this.persistAgents,
        );

        // Replay terminal buffers
        for (const [id, agent] of this.agents) {
          if (agent.terminalBuffer.length > 0) {
            for (const b64 of agent.terminalBuffer) {
              this.webview?.postMessage({ type: 'agentTerminalData', id, data: b64 });
            }
          }
        }

        if (this.activeAgentId.current !== null) {
          this.webview?.postMessage({ type: 'agentSelected', id: this.activeAgentId.current });
        }

        const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        const lastSeenVersion = this.context.globalState.get<string>(GLOBAL_KEY_LAST_SEEN_VERSION, '');
        const extensionVersion = (this.context.extension.packageJSON as { version?: string }).version ?? '';
        const config = await readConfig();
        
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          externalAssetDirectories: config.externalAssetDirectories,
        });

        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 1) {
          this.webview?.postMessage({
            type: 'workspaceFolders',
            folders: wsFolders.map((f) => ({ name: f.name, path: f.uri.fsPath })),
          });
        }

        const projectDir = getProjectDirPath();
        await ensureProjectScan(
          projectDir,
          this.knownJsonlFiles,
          this.projectScanTimer,
          this.activeAgentId,
          this.nextAgentId,
          this.agents,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.webview,
          this.persistAgents,
        );

        (async () => {
          try {
            const extensionPath = this.extensionUri.fsPath;
            const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
            let assetsRoot: string | null = null;
            const bundledExists = await fs.promises.access(bundledAssetsDir, fs.constants.F_OK).then(() => true).catch(() => false);
            if (bundledExists) {
              assetsRoot = path.join(extensionPath, 'dist');
            } else if (wsFolders?.[0]?.uri.fsPath) {
              assetsRoot = wsFolders[0].uri.fsPath;
            }

            if (!assetsRoot) {
              if (this.webview) {
                await sendLayout(this.context, this.webview, this.defaultLayout);
                this.startLayoutWatcher();
              }
              return;
            }

            this.assetsRoot = assetsRoot;
            this.defaultLayout = await loadDefaultLayout(assetsRoot);

            const charSprites = await loadCharacterSprites(assetsRoot);
            if (charSprites && this.webview) sendCharacterSpritesToWebview(this.webview, charSprites);

            const floorTiles = await loadFloorTiles(assetsRoot);
            if (floorTiles && this.webview) sendFloorTilesToWebview(this.webview, floorTiles);

            const wallTiles = await loadWallTiles(assetsRoot);
            if (wallTiles && this.webview) sendWallTilesToWebview(this.webview, wallTiles);

            const assets = await this.loadAllFurnitureAssets();
            if (assets && this.webview) sendAssetsToWebview(this.webview, assets);
          } catch (err) {
            console.error('[Extension] ❌ Error loading assets:', err);
          }
          if (this.webview) {
            await sendLayout(this.context, this.webview, this.defaultLayout);
            this.startLayoutWatcher();
          }
        })();
        await sendExistingAgents(this.agents, this.context, this.webview);
      } else if (message.type === 'requestDiagnostics') {
        const diagnostics: any[] = [];
        for (const [, agent] of this.agents) {
          diagnostics.push({
            id: agent.id,
            projectDir: agent.projectDir,
            jsonlFile: agent.jsonlFile,
            lastDataAt: agent.lastDataAt,
          });
        }
        this.webview?.postMessage({ type: 'agentDiagnostics', agents: diagnostics });
      } else if (message.type === 'addExternalAssetDirectory') {
        const uris = await vscode.window.showOpenDialog({ canSelectFolders: true });
        if (!uris || uris.length === 0) return;
        const newPath = uris[0].fsPath;
        const cfg = await readConfig();
        if (!cfg.externalAssetDirectories.includes(newPath)) {
          cfg.externalAssetDirectories.push(newPath);
          await writeConfig(cfg);
        }
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      } else if (message.type === 'removeExternalAssetDirectory') {
        const cfg = await readConfig();
        cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== (message.path as string));
        await writeConfig(cfg);
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      this.activeAgentId.current = null;
      if (!terminal) return;
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef === terminal) {
          this.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          break;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef === closed) {
          if (this.activeAgentId.current === id) this.activeAgentId.current = null;
          removeAgent(id, this.agents, this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers, this.jsonlPollTimers, this.persistAgents);
          webviewView.webview.postMessage({ type: 'agentClosed', id });
        }
      }
    });
  }

  private async loadAllFurnitureAssets(): Promise<LoadedAssets | null> {
    if (!this.assetsRoot) return null;
    let assets = await loadFurnitureAssets([this.assetsRoot]);
    const config = await readConfig();
    if (config.externalAssetDirectories.length > 0) {
      const extra = await loadFurnitureAssets(config.externalAssetDirectories);
      if (extra) assets = assets ? mergeLoadedAssets(assets, extra) : extra;
    }
    return assets;
  }

  private async reloadAndSendFurniture(): Promise<void> {
    const assets = await this.loadAllFurnitureAssets();
    if (this.webview && assets) sendAssetsToWebview(this.webview, assets);
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) return;
    this.layoutWatcher = watchLayoutFile((layout) => {
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  dispose() {
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    for (const id of Array.from(this.agents.keys())) {
      removeAgent(id, this.agents, this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers, this.jsonlPollTimers, this.persistAgents);
    }
    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
  }
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexUri = vscode.Uri.joinPath(distPath, 'index.html');
  if (!fs.existsSync(indexUri.fsPath)) return `<html><body><h1>Error: index.html not found</h1></body></html>`;
  
  let html = fs.readFileSync(indexUri.fsPath, 'utf-8');
  const baseUri = webview.asWebviewUri(distPath);
  
  const headInject = `
    <base href="${baseUri}/">
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      img-src ${webview.cspSource} https: data:;
      script-src 'unsafe-eval' 'unsafe-inline' ${webview.cspSource};
      style-src ${webview.cspSource} 'unsafe-inline';
      font-src ${webview.cspSource};
      connect-src ${webview.cspSource} https:;
    ">
  `;
  html = html.replace('<head>', `<head>${headInject}`);

  html = html.replace(/(href|src)="(\.\/|\/)?([^"]+)"/g, (match, attr, _prefix, filePath) => {
    if (filePath.startsWith('http') || filePath.startsWith('https') || filePath.startsWith('data:')) return match;
    return `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(distPath, filePath))}"`;
  });

  return html;
}
