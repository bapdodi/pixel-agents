#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const coordDir = process.env.PIXEL_AGENTS_COORD_DIR;
if (!coordDir) {
  console.error('[pixel-task-list] PIXEL_AGENTS_COORD_DIR not set.');
  process.exit(1);
}

const statusDirs = [
  { dir: 'pending', status: 'PENDING' },
  { dir: 'claimed', status: 'CLAIMED' },
  { dir: 'done', status: 'DONE' },
  { dir: 'failed', status: 'FAILED' },
];

try {
  console.log('SHARED TASKS LIST');
  console.log('--------------------------------------------------------------------------------');
  console.log('| ID                                   | STATUS   | PRI | ROLE         | TITLE |');
  console.log('--------------------------------------------------------------------------------');

  statusDirs.forEach(({ dir, status }) => {
    const fullPath = path.join(coordDir, 'tasks', dir);
    if (!fs.existsSync(fullPath)) return;

    const files = fs.readdirSync(fullPath);
    files.forEach((file) => {
      if (!file.endsWith('.json') && !file.includes('.')) return;
      try {
        const task = JSON.parse(fs.readFileSync(path.join(fullPath, file), 'utf-8'));
        const id = task.id.padEnd(36);
        const stat = status.padEnd(8);
        const pri = String(task.priority).padEnd(3);
        const role = (task.requiredRole || 'Any').padEnd(12);
        const title = task.title;
        console.log(`| ${id} | ${stat} | ${pri} | ${role} | ${title} |`);
      } catch {
        /* skip */
      }
    });
  });

  console.log('--------------------------------------------------------------------------------');
} catch (err) {
  console.error(`[pixel-task-list] Failed: ${err.message}`);
  process.exit(1);
}
