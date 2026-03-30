import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';

import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
  WORKSPACE_KEY_LAYOUT,
} from './constants.js';

export interface LayoutWatcher {
  markOwnWrite(): void;
  dispose(): void;
}

function getLayoutFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, LAYOUT_FILE_NAME);
}

export async function readLayoutFromFile(): Promise<Record<string, unknown> | null> {
  const filePath = getLayoutFilePath();
  try {
    const fileExists = await fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
    if (!fileExists) return null;
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error('[Pixel Agents] Failed to read layout file:', err);
    return null;
  }
}

export async function writeLayoutToFile(layout: Record<string, unknown>): Promise<void> {
  const filePath = getLayoutFilePath();
  const dir = path.dirname(filePath);
  try {
    const dirExists = await fs.promises.access(dir, fs.constants.F_OK).then(() => true).catch(() => false);
    if (!dirExists) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    const json = JSON.stringify(layout, null, 2);
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, json, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write layout file:', err);
  }
}

export interface LayoutLoadResult {
  layout: Record<string, unknown>;
  /** True when the user's saved layout was replaced by a newer bundled default */
  wasReset: boolean;
}

/**
 * Load layout with migration from workspace state (Async)
 */
export async function migrateAndLoadLayout(
  context: ExtensionContext,
  defaultLayout?: Record<string, unknown> | null,
): Promise<LayoutLoadResult | null> {
  // 1. Try file — but reset if bundled default has a newer revision
  const fromFile = await readLayoutFromFile();
  if (fromFile) {
    const fileRevision = (fromFile[LAYOUT_REVISION_KEY] as number) ?? 0;
    const defaultRevision = (defaultLayout?.[LAYOUT_REVISION_KEY] as number) ?? 0;
    if (defaultRevision > fileRevision) {
      console.log(
        `[Pixel Agents] Layout revision outdated (${fileRevision} < ${defaultRevision}), resetting to bundled default`,
      );
      await writeLayoutToFile(defaultLayout!);
      return { layout: defaultLayout!, wasReset: true };
    }
    console.log('[Pixel Agents] Layout loaded from file');
    return { layout: fromFile, wasReset: false };
  }

  // 2. Migrate from workspace state
  const fromState = context.workspaceState.get<Record<string, unknown>>(WORKSPACE_KEY_LAYOUT);
  if (fromState) {
    console.log('[Pixel Agents] Migrating layout from workspace state to file');
    await writeLayoutToFile(fromState);
    context.workspaceState.update(WORKSPACE_KEY_LAYOUT, undefined);
    return { layout: fromState, wasReset: false };
  }

  // 3. Use bundled default
  if (defaultLayout) {
    console.log('[Pixel Agents] Writing bundled default layout to file');
    await writeLayoutToFile(defaultLayout);
    return { layout: defaultLayout, wasReset: false };
  }

  // 4. Nothing
  return null;
}

/**
 * Watch ~/.pixel-agents/layout.json for external changes (Async)
 */
export function watchLayoutFile(
  onExternalChange: (layout: Record<string, unknown>) => void,
): LayoutWatcher {
  const filePath = getLayoutFilePath();
  let skipNextChange = false;
  let lastMtime = 0;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  // Initialize lastMtime (Async init)
  (async () => {
    try {
      const fileExists = await fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
      if (fileExists) {
        lastMtime = (await fs.promises.stat(filePath)).mtimeMs;
      }
    } catch { /* ignore */ }
  })();

  async function checkForChange(): Promise<void> {
    if (disposed) return;
    try {
      const fileExists = await fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
      if (!fileExists) return;
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;

      if (skipNextChange) {
        skipNextChange = false;
        return;
      }

      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const layout = JSON.parse(raw) as Record<string, unknown>;
      console.log('[Pixel Agents] External layout change detected');
      onExternalChange(layout);
    } catch (err) {
      console.error('[Pixel Agents] Error checking layout file:', err);
    }
  }

  async function startFsWatch(): Promise<void> {
    if (disposed || fsWatcher) return;
    try {
      const fileExists = await fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
      if (!fileExists) return;
      fsWatcher = fs.watch(filePath, () => {
        checkForChange();
      });
      fsWatcher.on('error', () => {
        fsWatcher?.close();
        fsWatcher = null;
      });
    } catch { /* ignore */ }
  }

  // Start watch
  startFsWatch();

  let isChecking = false;
  pollTimer = setInterval(async () => {
    if (disposed || isChecking) return;
    isChecking = true;
    try {
      if (!fsWatcher) {
        await startFsWatch();
      }
      await checkForChange();
    } finally {
      isChecking = false;
    }
  }, LAYOUT_FILE_POLL_INTERVAL_MS);

  return {
    markOwnWrite(): void {
      skipNextChange = true;
      (async () => {
        try {
          const fileExists = await fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
          if (fileExists) {
            lastMtime = (await fs.promises.stat(filePath)).mtimeMs;
          }
        } catch { /* ignore */ }
      })();
    },
    dispose(): void {
      disposed = true;
      fsWatcher?.close();
      fsWatcher = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
