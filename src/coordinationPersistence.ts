import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  COORD_HISTORY_MAX,
  COORDINATION_AGENTS_DIR,
  COORDINATION_DIR,
  COORDINATION_HISTORY_FILE,
  COORDINATION_INBOX_DIR,
  COORDINATION_REGISTRY_FILE,
  COORDINATION_STALE_MS,
  LAYOUT_FILE_DIR,
} from './constants.js';
import type {
  AgentRegistryEntry,
  CoordinationMessage,
  CoordinationRegistry,
  CoordLogEntry,
} from './types.js';

// ── Path helpers ──────────────────────────────────────────────

export function getCoordDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, COORDINATION_DIR);
}

export function getAgentsDir(): string {
  return path.join(getCoordDir(), COORDINATION_AGENTS_DIR);
}

export function getInboxDir(): string {
  return path.join(getCoordDir(), COORDINATION_INBOX_DIR);
}

export function getRegistryFilePath(): string {
  return path.join(getCoordDir(), COORDINATION_REGISTRY_FILE);
}

export function getAgentFilePath(sessionId: string): string {
  return path.join(getAgentsDir(), `${sessionId}.json`);
}

export function getInboxFilePath(sessionId: string): string {
  return path.join(getInboxDir(), `${sessionId}.jsonl`);
}

export function getHistoryFilePath(): string {
  return path.join(getCoordDir(), COORDINATION_HISTORY_FILE);
}

/** Extract sessionId from a JSONL file path (basename without extension) */
export function extractSessionId(jsonlFile: string): string {
  return path.basename(jsonlFile, '.jsonl');
}

// ── Directory init ────────────────────────────────────────────

export async function ensureCoordDirs(): Promise<void> {
  await fs.promises.mkdir(getAgentsDir(), { recursive: true });
  await fs.promises.mkdir(getInboxDir(), { recursive: true });
}

// ── Per-agent file (agents/<session-id>.json) ─────────────────

export async function writeAgentEntry(entry: AgentRegistryEntry): Promise<void> {
  const filePath = getAgentFilePath(entry.sessionId);
  const tmpPath = filePath + '.tmp';
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    console.error('[CoordPersistence] Failed to write agent entry:', err);
  }
}

export async function deleteAgentEntry(sessionId: string): Promise<void> {
  try {
    await fs.promises.unlink(getAgentFilePath(sessionId));
  } catch {
    /* already gone */
  }
}

export async function deleteInboxFile(sessionId: string): Promise<void> {
  try {
    await fs.promises.unlink(getInboxFilePath(sessionId));
  } catch {
    /* already gone */
  }
}

export async function readAgentEntry(sessionId: string): Promise<AgentRegistryEntry | null> {
  try {
    const raw = await fs.promises.readFile(getAgentFilePath(sessionId), 'utf-8');
    return JSON.parse(raw) as AgentRegistryEntry;
  } catch {
    return null;
  }
}

// ── Registry (registry.json) — Extension is sole writer ───────

export async function rebuildRegistry(): Promise<CoordinationRegistry> {
  const dir = getAgentsDir();
  const registry: CoordinationRegistry = { version: 1, agents: {}, updatedAt: Date.now() };

  let files: string[] = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return registry;
  }

  const now = Date.now();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, file), 'utf-8');
      const entry = JSON.parse(raw) as AgentRegistryEntry;
      // Skip stale entries (30s without update)
      if (now - entry.updatedAt < COORDINATION_STALE_MS) {
        registry.agents[entry.sessionId] = entry;
      }
    } catch {
      /* skip malformed */
    }
  }
  return registry;
}

export async function writeRegistry(registry: CoordinationRegistry): Promise<void> {
  const filePath = getRegistryFilePath();
  const tmpPath = filePath + '.tmp';
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    console.error('[CoordPersistence] Failed to write registry:', err);
  }
}

/** Rebuild registry.json from agents/ directory and write it */
export async function refreshRegistry(): Promise<CoordinationRegistry> {
  await ensureCoordDirs();
  const registry = await rebuildRegistry();
  await writeRegistry(registry);
  return registry;
}

// ── Stale agent cleanup ───────────────────────────────────────

/** Remove agents/ entries that haven't updated in COORDINATION_STALE_MS */
export async function pruneStaleAgentFiles(): Promise<string[]> {
  const dir = getAgentsDir();
  const pruned: string[] = [];
  const now = Date.now();

  let files: string[] = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return pruned;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const sessionId = file.replace(/\.json$/, '');
    try {
      const raw = await fs.promises.readFile(path.join(dir, file), 'utf-8');
      const entry = JSON.parse(raw) as AgentRegistryEntry;
      if (now - entry.updatedAt >= COORDINATION_STALE_MS) {
        await fs.promises.unlink(path.join(dir, file));
        await deleteInboxFile(sessionId);
        pruned.push(sessionId);
      }
    } catch {
      // Malformed file — delete it
      try {
        await fs.promises.unlink(path.join(dir, file));
      } catch {
        /* ignore */
      }
    }
  }
  return pruned;
}

// ── Inbox read (byte-offset, returns new messages) ────────────

const inboxOffsets = new Map<string, number>();

export function resetInboxOffset(sessionId: string): void {
  inboxOffsets.set(sessionId, 0);
}

export async function readNewInboxMessages(sessionId: string): Promise<CoordinationMessage[]> {
  const filePath = getInboxFilePath(sessionId);
  const offset = inboxOffsets.get(sessionId) ?? 0;
  const messages: CoordinationMessage[] = [];

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return messages; // inbox doesn't exist yet
  }

  if (stat.size <= offset) return messages;

  const buf = Buffer.alloc(stat.size - offset);
  const fd = await fs.promises.open(filePath, 'r');
  try {
    await fd.read(buf, 0, buf.length, offset);
    inboxOffsets.set(sessionId, stat.size);
  } finally {
    await fd.close();
  }

  const lines = buf.toString('utf-8').split('\n');
  const now = Date.now();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as CoordinationMessage;
      if (
        typeof msg.id !== 'string' ||
        typeof msg.body !== 'string' ||
        typeof msg.sentAt !== 'number'
      )
        continue;
      const ttl = msg.ttl ?? 86_400_000;
      if (now - msg.sentAt > ttl) continue; // expired
      messages.push(msg);
    } catch {
      /* skip malformed */
    }
  }

  return messages;
}

/** Append a routed message to target's inbox */
export async function appendToInbox(sessionId: string, msg: CoordinationMessage): Promise<void> {
  const filePath = getInboxFilePath(sessionId);
  // Ensure inbox dir exists
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(msg) + '\n';
  try {
    await fs.promises.appendFile(filePath, line, 'utf-8');
  } catch (err) {
    console.error('[CoordPersistence] Failed to append to inbox:', err);
  }
}

// ── send_to message builder ───────────────────────────────────

/** Build a fully-populated CoordinationMessage from a send_to inbox entry */
export function buildRoutedMessage(
  sendTo: Partial<CoordinationMessage> & { toSessionId: string; body: string },
  fromEntry: AgentRegistryEntry,
): CoordinationMessage {
  return {
    id: crypto.randomUUID(),
    fromSessionId: fromEntry.sessionId,
    fromProviderId: fromEntry.providerId,
    fromRole: fromEntry.role,
    toSessionId: sendTo.toSessionId,
    type: sendTo.type === 'send_to' ? 'message' : (sendTo.type ?? 'message'),
    body: sendTo.body,
    taskId: sendTo.taskId,
    chainDepth: (sendTo.chainDepth ?? 0) + 1,
    rootMessageId: sendTo.rootMessageId ?? sendTo.id,
    sentAt: Date.now(),
    ttl: sendTo.ttl,
  };
}

// ── Coordination history log ──────────────────────────────────

const historyBuffer: CoordLogEntry[] = [];

export async function appendHistory(entry: CoordLogEntry): Promise<void> {
  historyBuffer.push(entry);
  if (historyBuffer.length > COORD_HISTORY_MAX) historyBuffer.shift();

  const line = JSON.stringify(entry) + '\n';
  try {
    await fs.promises.appendFile(getHistoryFilePath(), line, 'utf-8');
  } catch {
    /* ignore */
  }
}

export function getRecentHistory(): CoordLogEntry[] {
  return [...historyBuffer];
}
