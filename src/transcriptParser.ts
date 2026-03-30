import * as path from 'path';
import type * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import { PERMISSION_EXEMPT_TOOLS as CLAUDE_EXEMPT_TOOLS } from './providers/claude.js';
import { getProvider } from './providers/index.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';


export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;

  const provider = getProvider(agent.providerId);
  const events = provider.parseLine(line, agentId, {
    activeToolNames: agent.activeToolNames,
    backgroundAgentToolIds: agent.backgroundAgentToolIds,
  });

  if (!events) return;

  for (const event of events) {
    switch (event.type) {
      case 'tool_start': {
        if (!event.toolId) continue;
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        getWebview()?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

        const toolName = event.toolName || '';
        agent.activeToolIds.add(event.toolId);
        agent.activeToolStatuses.set(event.toolId, event.status || 'Active');
        agent.activeToolNames.set(event.toolId, toolName);

        const isExempt = agent.providerId === 'claude' 
          ? CLAUDE_EXEMPT_TOOLS.has(toolName)
          : false;

        getWebview()?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: event.toolId,
          status: event.status,
        });

        if (!isExempt) {
          startPermissionTimer(agentId, agents, permissionTimers, CLAUDE_EXEMPT_TOOLS, getWebview);
        }
        break;
      }

      case 'tool_done': {
        if (!event.toolId) continue;
        const toolId = event.toolId;
        const toolName = agent.activeToolNames.get(toolId);

        if (toolName === 'Task' || toolName === 'Agent') {
          agent.activeSubagentToolIds.delete(toolId);
          agent.activeSubagentToolNames.delete(toolId);
          getWebview()?.postMessage({ type: 'subagentClear', id: agentId, parentToolId: toolId });
        }

        agent.activeToolIds.delete(toolId);
        agent.activeToolStatuses.delete(toolId);
        agent.activeToolNames.delete(toolId);

        setTimeout(() => {
          getWebview()?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
        }, TOOL_DONE_DELAY_MS);

        if (agent.activeToolIds.size === 0) {
          agent.hadToolsInTurn = false;
        }
        break;
      }

      case 'subagent_tool_start': {
        if (!event.toolId || !event.parentToolId) continue;
        const parentId = event.parentToolId;
        const subId = event.toolId;
        const toolName = event.toolName || '';

        let subIds = agent.activeSubagentToolIds.get(parentId);
        if (!subIds) {
          subIds = new Set();
          agent.activeSubagentToolIds.set(parentId, subIds);
        }
        subIds.add(subId);

        let subNames = agent.activeSubagentToolNames.get(parentId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentId, subNames);
        }
        subNames.set(subId, toolName);

        const isExempt = agent.providerId === 'claude'
          ? CLAUDE_EXEMPT_TOOLS.has(toolName)
          : false;

        getWebview()?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId: parentId,
          toolId: subId,
          status: event.status,
        });

        if (!isExempt) {
          startPermissionTimer(agentId, agents, permissionTimers, CLAUDE_EXEMPT_TOOLS, getWebview);
        }
        break;
      }

      case 'subagent_tool_done': {
        if (!event.toolId || !event.parentToolId) continue;
        const parentId = event.parentToolId;
        const subId = event.toolId;

        agent.activeSubagentToolIds.get(parentId)?.delete(subId);
        agent.activeSubagentToolNames.get(parentId)?.delete(subId);

        setTimeout(() => {
          getWebview()?.postMessage({ type: 'subagentToolDone', id: agentId, parentToolId: parentId, toolId: subId });
        }, 300);
        break;
      }

      case 'turn_start': {
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, getWebview);
        agent.hadToolsInTurn = false;
        break;
      }

      case 'turn_end': {
        cancelWaitingTimer(agentId, waitingTimers);
        cancelPermissionTimer(agentId, permissionTimers);

        const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
        if (hasForegroundTools) {
          for (const tid of agent.activeToolIds) {
            if (agent.backgroundAgentToolIds.has(tid)) continue;
            agent.activeToolIds.delete(tid);
            agent.activeToolStatuses.delete(tid);
            const tName = agent.activeToolNames.get(tid);
            agent.activeToolNames.delete(tid);
            if (tName === 'Task' || tName === 'Agent') {
              agent.activeSubagentToolIds.delete(tid);
              agent.activeSubagentToolNames.delete(tid);
            }
          }
          getWebview()?.postMessage({ type: 'agentToolsClear', id: agentId });
          for (const tid of agent.backgroundAgentToolIds) {
            const status = agent.activeToolStatuses.get(tid);
            if (status) {
              getWebview()?.postMessage({ type: 'agentToolStart', id: agentId, toolId: tid, status });
            }
          }
        } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
          agent.activeToolIds.clear();
          agent.activeToolStatuses.clear();
          agent.activeToolNames.clear();
          agent.activeSubagentToolIds.clear();
          agent.activeSubagentToolNames.clear();
          getWebview()?.postMessage({ type: 'agentToolsClear', id: agentId });
        }

        agent.isWaiting = true;
        agent.permissionSent = false;
        agent.hadToolsInTurn = false;
        getWebview()?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
        break;
      }

      case 'text': {
        getWebview()?.postMessage({ type: 'agentTerminalText', id: agentId, content: event.content, streamType: 'thought' });
        break;
      }

      case 'shell': {
        getWebview()?.postMessage({ type: 'agentTerminalText', id: agentId, content: event.content, streamType: 'shell' });
        break;
      }
    }
  }
}
