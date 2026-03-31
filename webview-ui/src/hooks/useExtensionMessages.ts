import { useEffect, useRef, useState } from 'react';

import { playDoneSound, setSoundEnabled } from '../notificationSound.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { setFloorSprites } from '../office/floorTiles.js';
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js';
import { setCharacterTemplates } from '../office/sprites/spriteData.js';
import { extractToolName } from '../office/toolUtils.js';
import type { OfficeLayout, ToolActivity } from '../office/types.js';
import { setWallSprites } from '../office/wallTiles.js';
import { vscode } from '../vscodeApi.js';

export interface SubagentCharacter {
  id: number;
  parentAgentId: number;
  parentToolId: string;
  label: string;
}

export interface TerminalLine {
  content: string;
  type: 'thought' | 'shell';
  timestamp: number;
}

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface CoordLogEntry {
  timestamp: number;
  fromAgentId: number;
  toAgentId: number | null;
  fromRole: string | null;
  msgType: string;
  body: string;
}

export type SharedTaskStatus =
  | 'pending'
  | 'blocked'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'timed_out';

export interface SharedTask {
  id: string;
  title: string;
  body: string;
  status: SharedTaskStatus;
  claimedBy: string | null;
  createdBy: string;
  dependsOn: string[];
  requiredRole: string | null;
  priority: number;
  result?: string;
  assignedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRegistryEntry {
  sessionId: string;
  agentId: number;
  providerId: string;
  providerName: string;
  role: string | null;
  roleDescription: string | null;
  capabilities: string[];
  status: 'active' | 'waiting' | 'idle';
  currentTask: string | null;
  inboxFile: string;
  registeredAt: number;
  updatedAt: number;
}

export interface ExtensionMessageState {
  agents: number[];
  selectedAgent: number | null;
  setSelectedAgent: (id: number | null) => void;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  layoutReady: boolean;
  layoutWasReset: boolean;
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> };
  workspaceFolders: WorkspaceFolder[];
  externalAssetDirectories: string[];
  lastSeenVersion: string;
  extensionVersion: string;
  agentTerminalLines: Record<number, TerminalLine[]>;
  agentTerminalRawData: Record<number, string[]>;
  coordinationRegistry: AgentRegistryEntry[];
  agentRoles: Record<number, string | null>;
  taskList: SharedTask[];
  coordLog: CoordLogEntry[];
  systemNotification: string | null;
  setSystemNotification: (msg: string | null) => void;
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue;
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId };
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats });
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({});
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({});
  const [subagentTools, setSubagentTools] = useState<
    Record<number, Record<string, ToolActivity[]>>
  >({});
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([]);
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutWasReset, setLayoutWasReset] = useState(false);
  const [loadedAssets, setLoadedAssets] = useState<
    { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined
  >();
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [externalAssetDirectories, setExternalAssetDirectories] = useState<string[]>([]);
  const [lastSeenVersion, setLastSeenVersion] = useState('');
  const [extensionVersion, setExtensionVersion] = useState('');
  const [agentTerminalLines, setAgentTerminalLines] = useState<Record<number, TerminalLine[]>>({});
  const [agentTerminalRawData, setAgentTerminalRawData] = useState<Record<number, string[]>>({});
  const [coordinationRegistry, setCoordinationRegistry] = useState<AgentRegistryEntry[]>([]);
  const [agentRoles, setAgentRoles] = useState<Record<number, string | null>>({});
  const [taskList, setTaskList] = useState<SharedTask[]>([]);
  const [coordLog, setCoordLog] = useState<CoordLogEntry[]>([]);
  const [systemNotification, setSystemNotification] = useState<string | null>(null);

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false);

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{
      id: number;
      palette?: number;
      hueShift?: number;
      seatId?: string;
      folderName?: string;
      providerId?: string;
    }> = [];

    // Report any early errors captured during bootstrap
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingErrors = (window as any).__pixelAgentsPendingErrors as unknown[];
    if (pendingErrors && pendingErrors.length > 0) {
      for (const e of pendingErrors) {
        vscode.postMessage({ type: 'webviewError', error: e });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__pixelAgentsPendingErrors = [];
    }

    const handler = (e: MessageEvent) => {
      const msg = e.data;
      const os = getOfficeState();

      if (msg && msg.type) {
        console.log(`[Webview] 📬 Incoming message: ${msg.type}`, msg);
      }

      if (msg.type === 'layoutLoaded') {
        console.log(
          `[Webview] 🏠 Layout loaded (revision: ${msg.layout ? (msg.layout as Record<string, unknown>).revision : 'N/A'})`,
        );
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes');
          return;
        }
        const rawLayout = msg.layout as OfficeLayout | null;
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayoutLoaded?.(layout);
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout());
        }
        // Add buffered agents now that layout (and seats) are correct
        if (pendingAgents.length > 0) {
          console.log(`[Webview] Adding ${pendingAgents.length} pending agent(s)`);
          for (const p of pendingAgents) {
            os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName, p.providerId);
          }
          pendingAgents = [];
        }
        layoutReadyRef.current = true;
        setLayoutReady(true);
        if (msg.wasReset) {
          setLayoutWasReset(true);
        }
        if (os.characters.size > 0) {
          saveAgentSeats(os);
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number;
        console.log(`[Webview] 🤖 Agent ${id} created`);
        const folderName = msg.folderName as string | undefined;
        const providerId = msg.providerId as string | undefined;
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]));
        setSelectedAgent(id);
        os.addAgent(id, undefined, undefined, undefined, undefined, folderName, providerId);
        saveAgentSeats(os);
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number;
        setAgents((prev) => {
          const next = prev.filter((a) => a !== id);
          // Auto-select another agent if the deleted one was selected
          setSelectedAgent((current) =>
            current === id ? (next.length > 0 ? next[0] : null) : current,
          );
          return next;
        });
        setAgentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id);
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id));
        os.removeAgent(id);
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[];
        const meta = (msg.agentMeta || {}) as Record<
          number,
          { palette?: number; hueShift?: number; seatId?: string; providerId?: string }
        >;
        const folderNames = (msg.folderNames || {}) as Record<number, string>;
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id];
          pendingAgents.push({
            id,
            palette: m?.palette,
            hueShift: m?.hueShift,
            seatId: m?.seatId,
            folderName: folderNames[id],
            providerId: m?.providerId,
          });
        }
        setAgents((prev) => {
          const ids = new Set(prev);
          const merged = [...prev];
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id);
            }
          }
          return merged.sort((a, b) => a - b);
        });
        // Select first agent if none selected
        if (incoming.length > 0) {
          setSelectedAgent((prev) => (prev === null ? incoming[0] : prev));
        }
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number;
        const toolId = msg.toolId as string;
        const status = msg.status as string;
        setAgentTools((prev) => {
          const list = prev[id] || [];
          if (list.some((t) => t.toolId === toolId)) return prev;
          return { ...prev, [id]: [...list, { toolId, status, done: false }] };
        });
        const toolName = extractToolName(status);
        os.setAgentTool(id, toolName);
        os.setAgentActive(id, true);
        os.clearPermissionBubble(id);
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim();
          const subId = os.addSubagent(id, toolId);
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev;
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }];
          });
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number;
        const toolId = msg.toolId as string;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          };
        });
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number;
        setAgentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id);
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id));
        os.setAgentTool(id, null);
        os.clearPermissionBubble(id);
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number;
        setSelectedAgent(id);
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number;
        const status = msg.status as string;
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }
          return { ...prev, [id]: status };
        });
        os.setAgentActive(id, status === 'active');
        if (status === 'waiting') {
          os.showWaitingBubble(id);
          playDoneSound();
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          };
        });
        os.showPermissionBubble(id);
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number;
        const parentToolId = msg.parentToolId as string;
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId);
        if (subId !== null) {
          os.showPermissionBubble(subId);
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          const hasPermission = list.some((t) => t.permissionWait);
          if (!hasPermission) return prev;
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          };
        });
        os.clearPermissionBubble(id);
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId);
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number;
        const parentToolId = msg.parentToolId as string;
        const toolId = msg.toolId as string;
        const status = msg.status as string;
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {};
          const list = agentSubs[parentToolId] || [];
          if (list.some((t) => t.toolId === toolId)) return prev;
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] },
          };
        });
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId);
        if (subId !== null) {
          const subToolName = extractToolName(status);
          os.setAgentTool(subId, subToolName);
          os.setAgentActive(subId, true);
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number;
        const parentToolId = msg.parentToolId as string;
        const toolId = msg.toolId as string;
        setSubagentTools((prev) => {
          const agentSubs = prev[id];
          if (!agentSubs) return prev;
          const list = agentSubs[parentToolId];
          if (!list) return prev;
          return {
            ...prev,
            [id]: {
              ...agentSubs,
              [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
            },
          };
        });
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number;
        const parentToolId = msg.parentToolId as string;
        setSubagentTools((prev) => {
          const agentSubs = prev[id];
          if (!agentSubs || !(parentToolId in agentSubs)) return prev;
          const next = { ...agentSubs };
          delete next[parentToolId];
          if (Object.keys(next).length === 0) {
            const outer = { ...prev };
            delete outer[id];
            return outer;
          }
          return { ...prev, [id]: next };
        });
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId);
        setSubagentCharacters((prev) =>
          prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)),
        );
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{
          down: string[][][];
          up: string[][][];
          right: string[][][];
        }>;
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`);
        setCharacterTemplates(characters);
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][];
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`);
        setFloorSprites(sprites);
      } else if (msg.type === 'wallTilesLoaded') {
        const sets = msg.sets as string[][][][];
        console.log(`[Webview] Received ${sets.length} wall tile set(s)`);
        setWallSprites(sets);
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[];
        setWorkspaceFolders(folders);
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean;
        setSoundEnabled(soundOn);
        if (Array.isArray(msg.externalAssetDirectories)) {
          setExternalAssetDirectories(msg.externalAssetDirectories as string[]);
        }
        if (typeof msg.lastSeenVersion === 'string') {
          setLastSeenVersion(msg.lastSeenVersion as string);
        }
        if (typeof msg.extensionVersion === 'string') {
          setExtensionVersion(msg.extensionVersion as string);
        }
      } else if (msg.type === 'externalAssetDirectoriesUpdated') {
        if (Array.isArray(msg.dirs)) {
          setExternalAssetDirectories(msg.dirs as string[]);
        }
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[];
          const sprites = msg.sprites as Record<string, string[][]>;
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`);
          buildDynamicCatalog({ catalog, sprites });
          setLoadedAssets({ catalog, sprites });
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err);
        }
      } else if (msg.type === 'coordination') {
        const sub = msg.subtype as string;
        if (sub === 'registry') {
          const entries = msg.agents as AgentRegistryEntry[];
          setCoordinationRegistry(entries);
          // Sync roles into agentRoles map
          const roles: Record<number, string | null> = {};
          for (const entry of entries) {
            roles[entry.agentId] = entry.role;
          }
          setAgentRoles(roles);
        } else if (sub === 'roleUpdated') {
          const agentId = msg.agentId as number;
          const role = (msg.role as string | null) ?? null;
          setAgentRoles((prev) => ({ ...prev, [agentId]: role }));
          setCoordinationRegistry((prev) =>
            prev.map((e) =>
              e.agentId === agentId
                ? {
                    ...e,
                    role,
                    roleDescription: (msg.roleDescription as string | null) ?? null,
                    capabilities: (msg.capabilities as string[]) ?? [],
                  }
                : e,
            ),
          );
        } else if (sub === 'arc') {
          os.addCoordinationArc?.(msg.fromId as number, msg.toId as number, msg.arcType as string);
        } else if (sub === 'message') {
          os.showMessageBubble?.(msg.agentId as number, msg.body as string);
        } else if (sub === 'taskList') {
          setTaskList(msg.tasks as SharedTask[]);
        } else if (sub === 'log') {
          const events = msg.events as CoordLogEntry[];
          setCoordLog((prev) => [...prev, ...events].slice(-50));
        } else if (sub === 'notification') {
          const content = msg.message as string;
          setSystemNotification(content);
          setTimeout(() => setSystemNotification(null), 3000);
        }
      } else if (msg.type === 'agentTerminalText') {
        const id = msg.id as number;
        const content = msg.content as string;
        const type = msg.streamType as 'thought' | 'shell';
        setAgentTerminalLines((prev) => {
          const list = prev[id] || [];
          const newLine: TerminalLine = { content, type, timestamp: Date.now() };
          const nextList = [...list, newLine].slice(-50); // Keep last 50 lines
          return { ...prev, [id]: nextList };
        });
      } else if (msg.type === 'agentTerminalData') {
        const id = msg.id as number;
        const data = msg.data as string;
        setAgentTerminalRawData((prev) => {
          const list = prev[id] || [];
          return { ...prev, [id]: [...list, data] };
        });
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'webviewReady' });
    return () => window.removeEventListener('message', handler);
  }, [getOfficeState, onLayoutLoaded, isEditDirty]);

  return {
    agents,
    selectedAgent,
    setSelectedAgent,
    agentTools,
    agentStatuses,
    agentTerminalLines,
    agentTerminalRawData,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    coordinationRegistry,
    agentRoles,
    taskList,
    coordLog,
    systemNotification,
    setSystemNotification,
  };
}
