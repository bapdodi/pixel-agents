import {
  appendToInbox,
  readAgentEntry,
  readInboxMessages,
  rebuildRegistry,
  writeAgentEntry,
} from './coordinationPersistence.js';
import type { CoordinationMessage } from './types.js';

export function resolveEventBusSessionId(
  args: Record<string, unknown>,
  envSessionId?: string,
): string | null {
  const fromArgs =
    typeof args.sessionId === 'string' && args.sessionId.trim().length > 0
      ? args.sessionId.trim()
      : null;
  const fromEnv = envSessionId?.trim() ? envSessionId.trim() : null;
  return fromArgs ?? fromEnv ?? null;
}

export function sessionIdSchema(required = false) {
  return {
    sessionId: {
      type: 'string',
      description: required
        ? 'Caller session ID. Required when the MCP server was launched without a bound session.'
        : 'Caller session ID. Usually optional when the MCP server inherits PIXEL_AGENTS_SESSION_ID.',
    },
  };
}

export async function listAgentsEvent() {
  const registry = await rebuildRegistry();
  return {
    content: [{ type: 'text', text: JSON.stringify(Object.values(registry.agents), null, 2) }],
  };
}

export async function checkMessagesEvent(sessionId: string) {
  const messages = await readInboxMessages(sessionId);
  const received = messages.filter((m) => m.type !== 'send_to');

  if (received.length === 0) {
    return {
      content: [{ type: 'text', text: 'Your inbox has no received messages.' }],
    };
  }

  const latest = received.slice(-10);
  return {
    content: [
      {
        type: 'text',
        text: `Latest ${latest.length} received messages:\n${JSON.stringify(latest, null, 2)}`,
      },
    ],
  };
}

export async function spawnAgentEvent(sessionId: string, args: Record<string, any>) {
  const spawnMsg: Partial<CoordinationMessage> = {
    type: 'spawn_agent',
    body: JSON.stringify({
      providerId: args.provider || 'gemini',
      role: args.role,
      description: args.description || '',
    }),
    sentAt: Date.now(),
  };
  await appendToInbox(sessionId, spawnMsg as CoordinationMessage);
  return {
    content: [
      { type: 'text', text: `Spawn requested: ${args.role} (${args.provider || 'gemini'})` },
    ],
  };
}

export async function sendMessageEvent(sessionId: string, args: Record<string, any>) {
  const msg: Partial<CoordinationMessage> = {
    type: 'send_to',
    toSessionId: args.toSessionId,
    body: args.body,
    sentAt: Date.now(),
  };
  await appendToInbox(sessionId, msg as CoordinationMessage);
  return {
    content: [{ type: 'text', text: 'Message sent.' }],
  };
}

export async function setRoleEvent(sessionId: string, args: Record<string, any>) {
  const entry = await readAgentEntry(sessionId);
  if (!entry) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Agent registry entry not found.' }],
    };
  }

  entry.role = args.role;
  entry.roleDescription = args.description || '';
  entry.updatedAt = Date.now();
  await writeAgentEntry(entry);

  return {
    content: [{ type: 'text', text: `Role updated to '${args.role}'.` }],
  };
}
