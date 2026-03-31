// ── Timing (ms) ──────────────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;
export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const TEXT_IDLE_DELAY_MS = 5000;

// ── Display Truncation ──────────────────────────────────────
export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const CONFIG_FILE_NAME = 'config.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';

// ── Settings Persistence ────────────────────────────────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';

// ── A2A Coordination ────────────────────────────────────────
export const COORDINATION_DIR = 'coordination';
export const COORDINATION_AGENTS_DIR = 'agents';
export const COORDINATION_INBOX_DIR = 'inbox';
export const COORDINATION_TASKS_DIR = 'tasks';
export const COORDINATION_TASKS_PENDING_DIR = 'tasks/pending';
export const COORDINATION_TASKS_CLAIMED_DIR = 'tasks/claimed';
export const COORDINATION_TASKS_DONE_DIR = 'tasks/done';
export const COORDINATION_TASKS_FAILED_DIR = 'tasks/failed';
export const COORDINATION_REGISTRY_FILE = 'registry.json';
export const COORDINATION_HISTORY_FILE = 'history.jsonl';
export const COORDINATION_AGENT_POLL_MS = 2_000;
export const COORD_CONTEXT_INJECT_DELAY_MS = 3_000;
export const COORDINATION_STALE_MS = 30_000;
export const COORDINATION_LINK_TTL_MS = 10_000;
export const TASK_TIMEOUT_MS = 120_000;
export const TASK_HEARTBEAT_MS = 30_000;
export const MAX_CHAIN_DEPTH = 5;
export const MAX_INLINE_BODY_BYTES = 4_096;
export const DEFAULT_MESSAGE_TTL_MS = 86_400_000;
export const COORD_HISTORY_MAX = 50;
export const AGENT_ROLE_PRESETS = [
  'Architect',
  'Frontend Dev',
  'Backend Dev',
  'QA Engineer',
  'Tech Writer',
  'Code Reviewer',
  'DevOps',
  'Data Analyst',
] as const;
export const CAPABILITY_PRESETS = {
  'code-review': '코드 리뷰 및 품질 검증',
  testing: '테스트 작성 및 실행',
  documentation: '문서화 및 주석 작성',
  architecture: '시스템 설계 및 아키텍처',
  frontend: 'UI/UX 구현',
  backend: 'API 및 서버 구현',
  database: 'DB 스키마 및 쿼리',
  devops: 'CI/CD 및 인프라',
  security: '보안 취약점 분석',
  performance: '성능 최적화',
} as const;

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
export const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';
export const TERMINAL_NAME_PREFIX = 'Claude Code';
