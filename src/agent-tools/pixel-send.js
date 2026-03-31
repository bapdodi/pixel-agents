#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// PIXEL_AGENTS_INBOX is already the path to the current agent's inbox
// We need to send TO another agent's inbox. We can find it from the registry or by path.

const registryFile = process.env.PIXEL_AGENTS_REGISTRY;
const currentSessionId = process.env.PIXEL_AGENTS_SESSION_ID;

if (!registryFile || !currentSessionId) {
  console.error(
    '[pixel-send] Missing environment variables. Ensure PIXEL_AGENTS_REGISTRY and PIXEL_AGENTS_SESSION_ID are set.',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: pixel-send [toSessionId] [body] [--type=message|delegate|result|...]');
  process.exit(1);
}

const toSessionId = args[0];
const body = args[1];
let msgType = 'message';

args.forEach((arg) => {
  if (arg.startsWith('--type=')) msgType = arg.split('=')[1];
});

try {
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
  const targetAgent = registry.agents[toSessionId];

  if (!targetAgent) {
    console.error(`[pixel-send] Agent with session ID ${toSessionId} not found in registry.`);
    process.exit(1);
  }

  const targetInbox = targetAgent.inboxFile;
  const message = {
    id: crypto.randomUUID(),
    fromSessionId: currentSessionId,
    toSessionId: targetSessionId, // Handled by extension core when reading inbox
    type: 'send_to', // We send as 'send_to' so the extension core routes it
    body: body,
    sentAt: Date.now(),
  };

  // The extension core expects a 'send_to' type in our inbox to route it.
  // Wait, actually, current implementation routes 'send_to' messages from our own inbox to the target.
  // Let's check CoordinationManager.ts: processSendToMessages calls _routeSendTo for 'send_to'

  const myInbox = process.env.PIXEL_AGENTS_INBOX;
  fs.appendFileSync(
    myInbox,
    JSON.stringify({
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'send_to',
      toSessionId: toSessionId,
      msgType: msgType,
      body: body,
      sentAt: Date.now(),
    }) + '\n',
  );

  console.log(`[pixel-send] Sent message to ${toSessionId} (type: ${msgType})`);
} catch (err) {
  console.error(`[pixel-send] Failed: ${err.message}`);
  process.exit(1);
}
