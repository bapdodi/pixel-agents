import { useState } from 'react';

import { AGENT_ROLE_PRESETS } from '../constants.js';
import type { AgentRegistryEntry } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';

interface RoleSelectorProps {
  agentId: number;
  entry: AgentRegistryEntry | undefined;
  onClose: () => void;
}

export function RoleSelector({ agentId, entry, onClose }: RoleSelectorProps) {
  const [role, setRole] = useState(entry?.role ?? '');
  const [desc, setDesc] = useState(entry?.roleDescription ?? '');
  const [caps, setCaps] = useState((entry?.capabilities ?? []).join(', '));

  function save() {
    vscode.postMessage({
      type: 'coordination',
      subtype: 'saveRole',
      agentId,
      role: role.trim() || null,
      roleDescription: desc.trim() || undefined,
      capabilities: caps
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    onClose();
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--pixel-bg-light)',
    border: '2px solid var(--pixel-border)',
    borderRadius: 0,
    color: 'var(--pixel-text)',
    fontSize: '20px',
    padding: '3px 6px',
    width: '100%',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '18px',
    color: 'var(--pixel-text-dim)',
    display: 'block',
    marginBottom: 3,
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border-light)',
          boxShadow: '4px 4px 0px #0a0a14',
          padding: '14px 16px',
          minWidth: 260,
          maxWidth: 320,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontSize: '22px',
            color: 'var(--pixel-text)',
            fontWeight: 'bold',
            marginBottom: 12,
            letterSpacing: '0.5px',
          }}
        >
          Set Role
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Role</label>
          <select
            value={
              AGENT_ROLE_PRESETS.includes(role as (typeof AGENT_ROLE_PRESETS)[number])
                ? role
                : '__custom__'
            }
            onChange={(e) => {
              if (e.target.value !== '__custom__') setRole(e.target.value);
            }}
            style={{ ...inputStyle, marginBottom: 4 }}
          >
            <option value="__custom__">Custom…</option>
            {AGENT_ROLE_PRESETS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={role}
            placeholder="Role name"
            onChange={(e) => setRole(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Description (optional)</label>
          <input
            type="text"
            value={desc}
            placeholder="When to use this agent"
            onChange={(e) => setDesc(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Capabilities (comma separated)</label>
          <input
            type="text"
            value={caps}
            placeholder="code-review, testing, ..."
            onChange={(e) => setCaps(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              color: 'var(--pixel-text-dim)',
              fontSize: '20px',
              padding: '3px 10px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            style={{
              background: 'var(--pixel-accent)',
              border: '2px solid var(--pixel-border-light)',
              borderRadius: 0,
              color: '#fff',
              fontSize: '20px',
              padding: '3px 10px',
              cursor: 'pointer',
              boxShadow: '2px 2px 0px #0a0a14',
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
