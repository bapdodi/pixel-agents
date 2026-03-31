import { useState } from 'react';

import type {
  AgentRegistryEntry,
  SharedTask,
  SharedTaskStatus,
} from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';

interface TaskPanelProps {
  tasks: SharedTask[];
  selectedAgent: number | null;
  coordinationRegistry: AgentRegistryEntry[];
  onClose: () => void;
}

type TabKey = 'pending' | 'active' | 'done';

const STATUS_TAB: Record<SharedTaskStatus, TabKey> = {
  pending: 'pending',
  blocked: 'pending',
  in_progress: 'active',
  completed: 'done',
  failed: 'done',
  declined: 'done',
  timed_out: 'done',
};

const PRIORITY_LABEL = ['', 'P1', 'P2', 'P3', 'P4', 'P5'];
const PRIORITY_COLOR = ['', '#ff6b6b', '#ffa94d', '#ffe066', '#a9e34b', '#74c0fc'];

const STATUS_COLOR: Record<SharedTaskStatus, string> = {
  pending: 'var(--pixel-text-dim)',
  blocked: '#aaa',
  in_progress: 'var(--pixel-status-active)',
  completed: '#a9e34b',
  failed: '#ff6b6b',
  declined: '#aaa',
  timed_out: '#ff9f43',
};

export function TaskPanel({ tasks, selectedAgent, coordinationRegistry, onClose }: TaskPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = tasks.filter((t) => STATUS_TAB[t.status] === activeTab);

  const selectedEntry =
    selectedAgent !== null ? coordinationRegistry.find((e) => e.agentId === selectedAgent) : null;

  function handleClaim(taskId: string) {
    if (selectedAgent === null) return;
    vscode.postMessage({
      type: 'coordination',
      subtype: 'claimTask',
      agentId: selectedAgent,
      taskId,
    });
  }

  function handleCreate() {
    if (selectedAgent === null) return;
    const title = prompt('Task title:');
    if (!title?.trim()) return;
    const body = prompt('Task description (optional):') ?? '';
    vscode.postMessage({
      type: 'coordination',
      subtype: 'createTask',
      agentId: selectedAgent,
      title: title.trim(),
      body,
      priority: 3,
    });
  }

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    right: 12,
    bottom: 48,
    width: 320,
    maxHeight: 420,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border-light)',
    borderRadius: 0,
    boxShadow: '4px 4px 0px #0a0a14',
    zIndex: 200,
    overflow: 'hidden',
  };

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '5px 0',
    fontSize: '18px',
    background: active ? 'var(--pixel-active-bg)' : 'var(--pixel-btn-bg)',
    border: 'none',
    borderBottom: active ? '2px solid var(--pixel-accent)' : '2px solid transparent',
    borderRadius: 0,
    color: active ? 'var(--pixel-accent)' : 'var(--pixel-text-dim)',
    cursor: 'pointer',
  });

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          borderBottom: '1px solid var(--pixel-border)',
        }}
      >
        <span style={{ fontSize: '20px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
          Shared Tasks
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {selectedAgent !== null && (
            <button
              onClick={handleCreate}
              title="Create task"
              style={{
                background: 'var(--pixel-accent)',
                border: '2px solid var(--pixel-border-light)',
                borderRadius: 0,
                color: '#fff',
                fontSize: '18px',
                padding: '2px 8px',
                cursor: 'pointer',
              }}
            >
              + New
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--pixel-close-text)',
              fontSize: '22px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--pixel-border)' }}>
        {(['pending', 'active', 'done'] as TabKey[]).map((tab) => {
          const count = tasks.filter((t) => STATUS_TAB[t.status] === tab).length;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={tabBtnStyle(activeTab === tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {count > 0 && (
                <span style={{ marginLeft: 4, opacity: 0.7, fontSize: '15px' }}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Task list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '16px 12px',
              fontSize: '18px',
              color: 'var(--pixel-text-dim)',
              textAlign: 'center',
            }}
          >
            No {activeTab} tasks
          </div>
        ) : (
          filtered.map((task) => {
            const expanded = expandedId === task.id;
            const canClaim =
              activeTab === 'pending' &&
              selectedAgent !== null &&
              (!task.requiredRole || task.requiredRole === selectedEntry?.role);

            return (
              <div
                key={task.id}
                style={{
                  borderBottom: '1px solid var(--pixel-border)',
                  padding: '7px 10px',
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}
                  onClick={() => setExpandedId(expanded ? null : task.id)}
                >
                  <span
                    style={{
                      fontSize: '15px',
                      fontWeight: 'bold',
                      color: PRIORITY_COLOR[task.priority] ?? 'var(--pixel-text-dim)',
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {PRIORITY_LABEL[task.priority]}
                  </span>
                  {task.requiredRole && (
                    <span
                      style={{
                        fontSize: '14px',
                        color: 'var(--pixel-accent)',
                        border: '1px solid var(--pixel-accent)',
                        padding: '0 3px',
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      {task.requiredRole}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: '19px',
                      color: 'var(--pixel-text)',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {task.title}
                  </span>
                  <span
                    style={{
                      fontSize: '15px',
                      color: STATUS_COLOR[task.status],
                      flexShrink: 0,
                    }}
                  >
                    {task.status}
                  </span>
                </div>

                {expanded && (
                  <div style={{ marginTop: 6 }}>
                    {task.body && (
                      <p
                        style={{
                          fontSize: '17px',
                          color: 'var(--pixel-text-dim)',
                          margin: '0 0 6px 0',
                        }}
                      >
                        {task.body}
                      </p>
                    )}
                    {task.result && (
                      <p style={{ fontSize: '16px', color: '#a9e34b', margin: '0 0 6px 0' }}>
                        Result: {task.result}
                      </p>
                    )}
                    {canClaim && (
                      <button
                        onClick={() => handleClaim(task.id)}
                        style={{
                          background: 'var(--pixel-accent)',
                          border: '2px solid var(--pixel-border-light)',
                          borderRadius: 0,
                          color: '#fff',
                          fontSize: '17px',
                          padding: '3px 10px',
                          cursor: 'pointer',
                          boxShadow: '2px 2px 0px #0a0a14',
                        }}
                      >
                        Claim
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
