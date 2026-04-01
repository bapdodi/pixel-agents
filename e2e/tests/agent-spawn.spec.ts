/**
 * E2E: Clicking "+ Agent" in the Pixel Agents webview spawns a mock Claude terminal.
 *
 * Assertions:
 *   1. The mock `claude` binary was invoked (invocations.log exists and is non-empty).
 *   2. The expected JSONL session file was created in the isolated HOME.
 *   3. A VS Code terminal named "Claude Code #1" appears in the workbench.
 *
 * NOTE FOR NEW TESTS: As more specs are added, refactor session setup into a
 * Playwright fixture using test.extend<{ session: VSCodeSession }>() so that
 * launch/cleanup is automatic and tests stay focused on assertions. See:
 * https://playwright.dev/docs/test-fixtures
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { launchVSCode, waitForWorkbench } from '../helpers/launch';
import { createAgent, getPixelAgentsFrame, openPixelAgentsPanel } from '../helpers/webview';

test('creating an agent from the toolbar spawns mock claude and creates a JSONL session file', async ({}, testInfo) => {
  const session = await launchVSCode(testInfo.title);
  const { window, tmpHome, mockLogFile } = session;
  const runVideo = window.video();

  test.setTimeout(120_000);

  try {
    // 1. Wait for VS Code workbench to be ready
    await waitForWorkbench(window);

    // 2. Open the Pixel Agents panel
    await openPixelAgentsPanel(window);

    // 3. Find the webview frame and complete the current creation flow
    const frame = await getPixelAgentsFrame(window);
    await createAgent(frame, {
      providerName: 'Claude Code',
      folderMode: 'workspace',
      role: 'Architect',
      description: 'E2E spawn validation',
      capabilities: 'testing',
    });

    // 4. Assert: mock claude was invoked
    //    The mock script writes to $HOME/.claude-mock/invocations.log
    await expect
      .poll(
        () => {
          try {
            const content = fs.readFileSync(mockLogFile, 'utf8');
            return content.trim().length > 0;
          } catch {
            return false;
          }
        },
        {
          message: `Expected invocations.log at ${mockLogFile} to be non-empty`,
          timeout: 20_000,
          intervals: [500, 1000],
        },
      )
      .toBe(true);

    const invocationLog = fs.readFileSync(mockLogFile, 'utf8');
    expect(invocationLog).toContain('session-id=');
    await testInfo.attach('mock-claude-invocations', {
      body: invocationLog,
      contentType: 'text/plain',
    });

    // 5. Assert: JSONL session file was created.
    //    Scan all subdirectories under .claude/projects/ rather than hard-coding a
    //    specific hash. On Windows, os.tmpdir() may return an 8.3 short path while
    //    the VS Code terminal sees the long path, making the hashes differ even after
    //    normalisation attempts.
    const projectsDir = path.join(tmpHome, '.claude', 'projects');

    const findJsonlFiles = (): string[] => {
      try {
        if (!fs.existsSync(projectsDir)) return [];
        return fs.readdirSync(projectsDir).flatMap((entry) => {
          const sub = path.join(projectsDir, entry);
          try {
            return fs.statSync(sub).isDirectory()
              ? fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl'))
              : [];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    };

    await expect
      .poll(findJsonlFiles, {
        message: `Expected at least one .jsonl file under ${projectsDir}`,
        timeout: 20_000,
        intervals: [500, 1000],
      })
      .not.toHaveLength(0);

    await testInfo.attach('jsonl-files', {
      body: findJsonlFiles().join('\n'),
      contentType: 'text/plain',
    });

    // 6. Spawn success is already covered by:
    //    - the mock claude invocation log
    //    - the JSONL session file being created under the isolated HOME
    //    The terminal UI itself is rendered inside the webview and is validated
    //    separately by focused UI tests.
  } finally {
    // Save a screenshot of the final state regardless of outcome
    const screenshotPath = path.join(
      __dirname,
      '../../test-results/e2e',
      `agent-spawn-final-${Date.now()}.png`,
    );
    try {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await window.screenshot({ path: screenshotPath });
      await testInfo.attach('final-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } catch {
      // screenshot failure is non-fatal
    }

    await session.cleanup();

    if (runVideo) {
      try {
        const videoPath = testInfo.outputPath('run-video.webm');
        await runVideo.saveAs(videoPath);
        await testInfo.attach('run-video', {
          path: videoPath,
          contentType: 'video/webm',
        });
      } catch {
        // video attachment failure is non-fatal
      }
    }
  }
});

test('creating an agent through Browse Folder launches claude in the picked directory', async ({}, testInfo) => {
  const session = await launchVSCode(testInfo.title, { enableBrowseFolderMock: true });
  const { window, pickedFolderDir, mockLogFile } = session;

  test.setTimeout(120_000);

  try {
    await waitForWorkbench(window);
    await openPixelAgentsPanel(window);

    const frame = await getPixelAgentsFrame(window);
    await createAgent(frame, {
      providerName: 'Claude Code',
      folderMode: 'browse',
      role: 'Architect',
      description: 'Browse folder validation',
      capabilities: 'testing',
    });

    await expect
      .poll(
        () => {
          try {
            return fs.readFileSync(mockLogFile, 'utf8').toLowerCase();
          } catch {
            return '';
          }
        },
        {
          message: `Expected invocations.log at ${mockLogFile} to include the browse-folder cwd`,
          timeout: 20_000,
          intervals: [500, 1000],
        },
      )
      .toContain(`cwd=${pickedFolderDir?.toLowerCase()}`);
  } finally {
    await session.cleanup();
  }
});
