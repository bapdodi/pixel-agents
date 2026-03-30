import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { 
  AIProvider, 
  AgentEvent 
} from './types';
import { 
  BASH_COMMAND_DISPLAY_MAX_LENGTH, 
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TERMINAL_NAME_PREFIX
} from '../constants';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

export class ClaudeProvider implements AIProvider {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly terminalPrefix = TERMINAL_NAME_PREFIX;

  buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): string {
    return options.bypassPermissions
      ? `claude --session-id ${sessionId} --dangerously-skip-permissions`
      : `claude --session-id ${sessionId}`;
  }

  getProjectDir(cwd: string): string {
    const dirName = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);
    
    // Verify directory exists (fuzzy matching as in original agentManager.ts)
    if (!fs.existsSync(projectDir)) {
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
      try {
        if (fs.existsSync(projectsRoot)) {
          const candidates = fs.readdirSync(projectsRoot);
          const lowerDirName = dirName.toLowerCase();
          const match = candidates.find((c) => c.toLowerCase() === lowerDirName);
          if (match) return path.join(projectsRoot, match);
        }
      } catch { /* ignore scan errors */ }
    }
    return projectDir;
  }

  getExpectedFile(projectDir: string, sessionId: string): string {
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  formatToolStatus(toolName: string, input: Record<string, any>): string {
    const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
    switch (toolName) {
      case 'Read': return `Reading ${base(input.file_path)}`;
      case 'Edit': return `Editing ${base(input.file_path)}`;
      case 'Write': return `Writing ${base(input.file_path)}`;
      case 'Bash': {
        const cmd = (input.command as string) || '';
        return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
      }
      case 'Glob': return 'Searching files';
      case 'Grep': return 'Searching code';
      case 'WebFetch': return 'Fetching web content';
      case 'WebSearch': return 'Searching the web';
      case 'Task':
      case 'Agent': {
        const desc = typeof input.description === 'string' ? input.description : '';
        return desc
          ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
          : 'Running subtask';
      }
      case 'AskUserQuestion': return 'Waiting for your answer';
      case 'EnterPlanMode': return 'Planning';
      case 'NotebookEdit': return 'Editing notebook';
      default: return `Using ${toolName}`;
    }
  }

  parseLine(
    line: string, 
    agentId: number,
    context: { activeToolNames: Map<string, string>; backgroundAgentToolIds: Set<string> }
  ): AgentEvent[] | null {
    try {
      const record = JSON.parse(line);
      const events: AgentEvent[] = [];
      const assistantContent = record.message?.content ?? record.content;

      if (record.type === 'assistant' && Array.isArray(assistantContent)) {
        const blocks = assistantContent as any[];
        for (const block of blocks) {
          if (block.type === 'text' && block.text?.trim()) {
            events.push({ type: 'text', content: block.text });
          } else if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = this.formatToolStatus(toolName, block.input || {});
            events.push({ type: 'tool_start', toolId: block.id, toolName, status });
          }
        }
      } else if (record.type === 'user') {
        const content = record.message?.content ?? record.content;
        if (Array.isArray(content)) {
          const blocks = content as any[];
          const hasToolResult = blocks.some((b) => b.type === 'tool_result');
          if (hasToolResult) {
            for (const block of blocks) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const toolId = block.tool_use_id;
                const toolName = context.activeToolNames.get(toolId);
                
                if (toolName === 'Bash' && block.content) {
                  const content = Array.isArray(block.content) 
                    ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                    : String(block.content);
                  if (content.trim()) {
                    events.push({ type: 'shell', content });
                  }
                }

                if ((toolName === 'Task' || toolName === 'Agent') && this.isAsyncAgentResult(block)) {
                  continue;
                }
                events.push({ type: 'tool_done', toolId });
              }
            }
          } else {
            events.push({ type: 'turn_start' });
          }
        } else if (typeof content === 'string' && content.trim()) {
          events.push({ type: 'turn_start' });
        }
      } else if (record.type === 'progress') {
        const parentToolId = record.parentToolUseID as string;
        const data = record.data as any;
        if (parentToolId && data?.message?.type === 'assistant') {
          const content = data.message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && block.id) {
                const toolName = block.name || '';
                const status = this.formatToolStatus(toolName, block.input || {});
                events.push({ type: 'subagent_tool_start', toolId: block.id, toolName, status, parentToolId });
              }
            }
          }
        } else if (parentToolId && data?.message?.type === 'user') {
          const content = data.message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                events.push({ type: 'subagent_tool_done', toolId: block.tool_use_id, parentToolId });
              }
            }
          }
        }
      } else if (record.type === 'queue-operation' && record.operation === 'enqueue') {
        const content = record.content as string;
        const toolIdMatch = content?.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
        if (toolIdMatch) {
          events.push({ type: 'tool_done', toolId: toolIdMatch[1] });
        }
      } else if (record.type === 'system' && record.subtype === 'turn_duration') {
        events.push({ type: 'turn_end' });
      }

      return events.length > 0 ? events : null;
    } catch {
      return null;
    }
  }

  isAsyncAgentResult(block: any): boolean {
    const content = block.content;
    const asyncText = 'Async agent launched successfully.';
    if (Array.isArray(content)) {
      return content.some(item => typeof item === 'object' && item?.text?.startsWith(asyncText));
    } else if (typeof content === 'string') {
      return content.startsWith(asyncText);
    }
    return false;
  }
}
