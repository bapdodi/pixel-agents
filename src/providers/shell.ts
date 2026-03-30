import * as os from 'os';
import * as path from 'path';

import { 
  AgentEvent, 
  AIProvider} from './types';

export class ShellProvider implements AIProvider {
  readonly id = 'shell';
  readonly name = 'System Shell';
  readonly terminalPrefix = 'Shell';

  async buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): Promise<string> {
    return os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
  }

  async getProjectDir(cwd: string): Promise<string> {
    return cwd;
  }

  async getExpectedFile(projectDir: string, sessionId: string): Promise<string> {
    return ''; // Shell doesn't have a transcript file
  }

  parseLine(
    line: string, 
    agentId: number, 
    context: { activeToolNames: Map<string, string>; backgroundAgentToolIds: Set<string> }
  ): AgentEvent[] | null {
    return null;
  }

  isAsyncAgentResult(): boolean {
    return false;
  }
}
