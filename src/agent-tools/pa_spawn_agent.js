#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const currentInbox = process.env.PIXEL_AGENTS_INBOX;
if (!currentInbox) {
  // Try to find inbox via registry if env is missing
  console.error('[pa_spawn_agent] PIXEL_AGENTS_INBOX not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
let role = 'Architect';
let description = '';
let providerId = 'claude';
let capabilities = [];

// Simplified arg parsing for the agent
args.forEach((arg) => {
  if (arg.startsWith('--role=')) role = arg.split('=')[1];
  else if (arg.startsWith('--desc=')) description = arg.split('=')[1];
  else if (arg.startsWith('--provider=')) providerId = arg.split('=')[1];
  else if (arg.startsWith('--caps='))
    capabilities = arg
      .split('=')[1]
      .split(',')
      .map((s) => s.trim());
  else {
    // If first arg is just a string, treat it as role
    if (!arg.startsWith('-')) role = arg;
  }
});

try {
  const spawnMsg = {
    id: `spawn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type: 'spawn_agent',
    body: JSON.stringify({
      providerId,
      role,
      description,
      capabilities,
    }),
    sentAt: Date.now(),
  };

  fs.appendFileSync(currentInbox, JSON.stringify(spawnMsg) + '\n');
  console.log(`[pa_spawn_agent] Requested new agent: ${role} (${providerId})`);
} catch (err) {
  console.error(`[pa_spawn_agent] Failed: ${err.message}`);
  process.exit(1);
}
