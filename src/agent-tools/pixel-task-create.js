#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// This script needs to create a task in the pending directory
// Environment variables: PIXEL_AGENTS_COORD_DIR, PIXEL_AGENTS_SESSION_ID

const coordDir = process.env.PIXEL_AGENTS_COORD_DIR;
const currentSessionId = process.env.PIXEL_AGENTS_SESSION_ID;

if (!coordDir || !currentSessionId) {
  console.error('[pixel-task-create] Missing environment variables.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: pixel-task-create "Title" "Body" [--priority=1-5] [--role=RoleName]');
  process.exit(1);
}

const title = args[0];
const body = args[1];
let priority = 3;
let requiredRole = null;

args.forEach((arg) => {
  if (arg.startsWith('--priority=')) priority = parseInt(arg.split('=')[1]) || 3;
  if (arg.startsWith('--role=')) requiredRole = arg.split('=')[1];
});

const task = {
  id: crypto.randomUUID(),
  title,
  body,
  status: 'pending',
  claimedBy: null,
  createdBy: currentSessionId,
  dependsOn: [],
  requiredRole,
  priority,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

try {
  const pendingDir = path.join(coordDir, 'tasks', 'pending');
  if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });

  const filePath = path.join(pendingDir, `${task.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');

  console.log(`[pixel-task-create] Task created: ${task.id} (${title})`);
} catch (err) {
  console.error(`[pixel-task-create] Failed: ${err.message}`);
  process.exit(1);
}
