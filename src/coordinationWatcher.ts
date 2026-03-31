import * as fs from 'fs';

import { getInboxDir } from './coordinationPersistence.js';

// ── Inbox directory watcher ───────────────────────────────────
// Single fs.watch on coordination/inbox/ — O(1) regardless of agent count.
// On any file event, triggers the provided callback.

let _watcher: fs.FSWatcher | null = null;
let _onInboxChange: (() => void) | null = null;

export function startInboxWatcher(onInboxChange: () => void): void {
  if (_watcher) return; // already started
  _onInboxChange = onInboxChange;

  const dir = getInboxDir();
  fs.mkdirSync(dir, { recursive: true });

  try {
    _watcher = fs.watch(dir, (_event, _filename) => {
      _onInboxChange?.();
    });
    _watcher.on('error', () => {
      // fs.watch can fail on some systems; polling fallback handles it
    });
  } catch {
    // Watcher creation failed; polling in coordinationManager will still work
  }
}

export function stopInboxWatcher(): void {
  _watcher?.close();
  _watcher = null;
  _onInboxChange = null;
}
