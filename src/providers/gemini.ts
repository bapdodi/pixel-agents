import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { 
  AIProvider, 
  AgentEvent 
} from './types';

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  readonly name = 'Gemini';
  readonly terminalPrefix = 'Gemini';

  buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): string {
    // Gemini CLI usage
    return 'gemini';
  }

  getProjectDir(cwd: string): string {
    const geminiRoot = path.join(os.homedir(), '.gemini');
    const projectsFile = path.join(geminiRoot, 'projects.json');
    
    let projectId = path.basename(cwd); // Fallback to folder name
    
    if (fs.existsSync(projectsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
        const projects = data.projects || {};
        // Find by path match (case-insensitive on Windows)
        const lowerCwd = cwd.toLowerCase();
        for (const [p, id] of Object.entries(projects)) {
          if (p.toLowerCase() === lowerCwd) {
            projectId = id as string;
            break;
          }
        }
      } catch { /* ignore */ }
    }
    
    return path.join(geminiRoot, 'tmp', projectId, 'chats');
  }

  getExpectedFile(projectDir: string, sessionId: string): string {
    // Gemini filenames are session-YYYY-MM-DD-*.json
    return ''; // Scanner will find it
  }

  parseLine(
    line: string, 
    agentId: number, 
    context: { activeToolNames: Map<string, string>; backgroundAgentToolIds: Set<string> }
  ): AgentEvent[] | null {
    try {
      const record = JSON.parse(line);
      const events: AgentEvent[] = [];

      // Gemini CLI JSON format handling
      // Example: {"role": "model", "parts": [{"functionCall": {"name": "...", "args": {...}}}]}
      const role = record.type || record.role;
      const parts = record.parts || [record];

      if (role === 'model' || role === 'assistant') {
        for (const part of parts) {
          if (part.functionCall) {
            const toolName = part.functionCall.name;
            const toolId = part.functionCall.id || `gc-${Date.now()}`;
            events.push({
              type: 'tool_start',
              toolId,
              toolName,
              status: `Using ${toolName}`
            });
          }
        }
      } else if (role === 'user') {
        // Check for tool results
        const hasToolResponse = parts.some((p: any) => p.functionResponse);
        if (hasToolResponse) {
          for (const part of parts) {
            if (part.functionResponse) {
              const toolId = part.functionResponse.id;
              if (toolId) {
                events.push({ type: 'tool_done', toolId });
              } else {
                // If no ID, clear all matching by name (broad fallback)
                events.push({ type: 'tools_clear' });
              }
            }
          }
        } else {
          events.push({ type: 'turn_start' });
        }
      }

      if (record.finish_reason || record.done) {
        events.push({ type: 'turn_end' });
      }

      return events.length > 0 ? events : null;
    } catch {
      return null;
    }
  }

  isAsyncAgentResult(block: any): boolean {
    return false;
  }
}
