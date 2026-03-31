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
  COORDINATION_TASKS_CLAIMED_DIR,
  COORDINATION_TASKS_DONE_DIR,
  COORDINATION_TASKS_FAILED_DIR,
  COORDINATION_TASKS_PENDING_DIR,
  LAYOUT_FILE_DIR,
  TASK_TIMEOUT_MS,
} from './constants.js';
import type {
  AgentRegistryEntry,
  CoordinationMessage,
  CoordinationRegistry,
  CoordLogEntry,
  SharedTask,
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
      if (typeof msg.body !== 'string' || typeof msg.sentAt !== 'number') continue;

      // Auto-assign ID if missing from local tools
      if (!msg.id) {
        msg.id = `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }

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

// ── Task I/O ──────────────────────────────────────────────────

export function getTasksDir(): string {
  return path.join(getCoordDir(), 'tasks');
}

export function getTasksPendingDir(): string {
  return path.join(getCoordDir(), COORDINATION_TASKS_PENDING_DIR);
}

export function getTasksClaimedDir(): string {
  return path.join(getCoordDir(), COORDINATION_TASKS_CLAIMED_DIR);
}

export function getTasksDoneDir(): string {
  return path.join(getCoordDir(), COORDINATION_TASKS_DONE_DIR);
}

export function getTasksFailedDir(): string {
  return path.join(getCoordDir(), COORDINATION_TASKS_FAILED_DIR);
}

export async function ensureTaskDirs(): Promise<void> {
  for (const d of [
    getTasksPendingDir(),
    getTasksClaimedDir(),
    getTasksDoneDir(),
    getTasksFailedDir(),
  ]) {
    await fs.promises.mkdir(d, { recursive: true });
  }
}

export async function createTask(task: SharedTask): Promise<void> {
  const filePath = path.join(getTasksPendingDir(), `${task.id}.json`);
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(task, null, 2), 'utf-8');
  await fs.promises.rename(tmp, filePath);
}

/** Atomic rename-based claim. Returns null if task already claimed. */
export function claimTaskSync(taskId: string, sessionId: string): SharedTask | null {
  const pendingPath = path.join(getTasksPendingDir(), `${taskId}.json`);
  const claimedPath = path.join(getTasksClaimedDir(), `${taskId}.${sessionId}`);
  try {
    fs.renameSync(pendingPath, claimedPath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // already claimed
    throw e;
  }
  const task = JSON.parse(fs.readFileSync(claimedPath, 'utf-8')) as SharedTask;
  task.status = 'in_progress';
  task.claimedBy = sessionId;
  task.assignedAt = Date.now();
  task.updatedAt = Date.now();
  const tmp = claimedPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, claimedPath);
  return task;
}

export async function completeTask(
  taskId: string,
  sessionId: string,
  result?: string,
): Promise<void> {
  const claimedPath = path.join(getTasksClaimedDir(), `${taskId}.${sessionId}`);
  const donePath = path.join(getTasksDoneDir(), `${taskId}.json`);
  try {
    const raw = await fs.promises.readFile(claimedPath, 'utf-8');
    const task = JSON.parse(raw) as SharedTask;
    task.status = 'completed';
    task.result = result;
    task.updatedAt = Date.now();
    const tmp = donePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(task, null, 2), 'utf-8');
    await fs.promises.rename(tmp, donePath);
    await fs.promises.unlink(claimedPath).catch(() => {
      /* ignore */
    });
  } catch {
    /* file may already be moved */
  }
}

export async function failTask(taskId: string, sessionId: string, reason?: string): Promise<void> {
  const claimedPath = path.join(getTasksClaimedDir(), `${taskId}.${sessionId}`);
  const failedPath = path.join(getTasksFailedDir(), `${taskId}.json`);
  try {
    const raw = await fs.promises.readFile(claimedPath, 'utf-8');
    const task = JSON.parse(raw) as SharedTask;
    task.status = 'failed';
    task.result = reason;
    task.updatedAt = Date.now();
    const tmp = failedPath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(task, null, 2), 'utf-8');
    await fs.promises.rename(tmp, failedPath);
    await fs.promises.unlink(claimedPath).catch(() => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
}

/** Roll back all tasks claimed by sessionId → pending */
export async function rollbackTasksForSession(sessionId: string): Promise<void> {
  const dir = getTasksClaimedDir();
  let files: string[] = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith(`.${sessionId}`)) continue;
    const taskId = file.replace(`.${sessionId}`, '');
    const claimedPath = path.join(dir, file);
    const pendingPath = path.join(getTasksPendingDir(), `${taskId}.json`);
    try {
      const raw = await fs.promises.readFile(claimedPath, 'utf-8');
      const task = JSON.parse(raw) as SharedTask;
      task.status = 'pending';
      task.claimedBy = null;
      task.assignedAt = undefined;
      task.updatedAt = Date.now();
      const tmp = pendingPath + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(task, null, 2), 'utf-8');
      await fs.promises.rename(tmp, pendingPath);
      await fs.promises.unlink(claimedPath).catch(() => {
        /* ignore */
      });
    } catch {
      /* skip */
    }
  }
}

/** Reclaim timed-out tasks (assignedAt > TASK_TIMEOUT_MS) → pending */
export async function recoverTimedOutTasks(): Promise<string[]> {
  const dir = getTasksClaimedDir();
  const recovered: string[] = [];
  let files: string[] = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return recovered;
  }

  const now = Date.now();
  for (const file of files) {
    const claimedPath = path.join(dir, file);
    try {
      const raw = await fs.promises.readFile(claimedPath, 'utf-8');
      const task = JSON.parse(raw) as SharedTask;
      if (task.assignedAt && now - task.assignedAt > TASK_TIMEOUT_MS) {
        const taskId = file.split('.')[0];
        const pendingPath = path.join(getTasksPendingDir(), `${taskId}.json`);
        task.status = 'pending';
        task.claimedBy = null;
        task.assignedAt = undefined;
        task.updatedAt = now;
        const tmp = pendingPath + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(task, null, 2), 'utf-8');
        await fs.promises.rename(tmp, pendingPath);
        await fs.promises.unlink(claimedPath).catch(() => {
          /* ignore */
        });
        recovered.push(taskId);
      }
    } catch {
      /* skip malformed */
    }
  }
  return recovered;
}

/** List all tasks across status dirs */
export async function listAllTasks(): Promise<SharedTask[]> {
  const dirs = [
    { dir: getTasksPendingDir(), status: 'pending' as const },
    { dir: getTasksClaimedDir(), status: 'in_progress' as const },
    { dir: getTasksDoneDir(), status: 'completed' as const },
    { dir: getTasksFailedDir(), status: 'failed' as const },
  ];
  const tasks: SharedTask[] = [];
  for (const { dir } of dirs) {
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') && !file.includes('.')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(dir, file), 'utf-8');
        tasks.push(JSON.parse(raw) as SharedTask);
      } catch {
        /* skip */
      }
    }
  }
  return tasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}
