import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { SettingsModal } from './SettingsModal.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenAgent: (providerId: string, bypassPermissions: boolean) => void;
  onToggleEditMode: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  workspaceFolders: WorkspaceFolder[];
  externalAssetDirectories: string[];
  agents: number[];
  selectedAgent: number | null;
  onSelectAgent: (id: number) => void;
  onToggleTerminal: () => void;
  isTerminalMinimized: boolean;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: 8,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  background: 'var(--pixel-bg)',
  border: '1px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '2px 4px',
  boxShadow: 'var(--pixel-shadow)',
};

const btnBase: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: '13px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '1px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
};

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '1px solid var(--pixel-accent)',
};

export function BottomToolbar({
  isEditMode,
  onOpenAgent,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  workspaceFolders,
  externalAssetDirectories,
  agents,
  selectedAgent,
  onSelectAgent,
  onToggleTerminal,
  isTerminalMinimized,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTerminalMenuOpen, setIsTerminalMenuOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [hoveredFolder, setHoveredFolder] = useState<number | null>(null);
  const [hoveredProvider, setHoveredProvider] = useState<number | null>(null);
  const [hoveredBypass, setHoveredBypass] = useState<number | null>(null);
  const [hoveredTerminal, setHoveredTerminal] = useState<number | null>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);

  // Close menus on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen && !isProviderMenuOpen && !isTerminalMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const isOutsideAgent = folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node);
      const isOutsideTerminal = terminalRef.current && !terminalRef.current.contains(e.target as Node);
      if (isOutsideAgent && isOutsideTerminal) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
        setIsProviderMenuOpen(false);
        setIsTerminalMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen, isProviderMenuOpen, isTerminalMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    setIsFolderPickerOpen(false);
    setIsTerminalMenuOpen(false);
    setIsProviderMenuOpen((v) => !v);
  };

  const handleTerminalBtnClick = () => {
    if (agents.length === 0) return;
    if (agents.length === 1) {
      onToggleTerminal();
    } else {
      setIsTerminalMenuOpen((v) => !v);
    }
  };

  const handleProviderSelect = (providerId: string) => {
    setIsProviderMenuOpen(false);
    setSelectedProvider(providerId);
    const bypassPermissions = pendingBypassRef.current;
    
    if (hasMultipleFolders) {
      setIsFolderPickerOpen(true);
    } else {
      pendingBypassRef.current = false;
      onOpenAgent(providerId, bypassPermissions);
    }
  };

  const handleAgentRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsFolderPickerOpen(false);
    setIsBypassMenuOpen((v) => !v);
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    const providerId = selectedProvider || 'claude';
    pendingBypassRef.current = false;
    setSelectedProvider(null);
    vscode.postMessage({ type: 'openClaude', providerId, folderPath: folder.path, bypassPermissions });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = bypassPermissions;
    setIsProviderMenuOpen(true);
  };

  return (
    <div style={panelStyle}>
      <div ref={folderPickerRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onContextMenu={handleAgentRightClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '4px 10px',
            background:
              hovered === 'agent' || isFolderPickerOpen || isBypassMenuOpen || isProviderMenuOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '1px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
        >
          + Agent
        </button>
        {isProviderMenuOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '1px solid var(--pixel-border)',
              borderRadius: 0,
              padding: 4,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {[
              { id: 'claude', name: 'Claude Code' },
              { id: 'openai', name: 'OpenAI Codex' },
              { id: 'gemini', name: 'Google Gemini' },
              { id: 'shell', name: 'System Shell (Debug)' },
            ].map((p, i) => (
              <button
                key={p.id}
                onClick={() => handleProviderSelect(p.id)}
                onMouseEnter={() => setHoveredProvider(i)}
                onMouseLeave={() => setHoveredProvider(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 8px',
                  fontSize: '13px',
                  color: 'var(--pixel-text)',
                  background: hoveredProvider === i ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        {isBypassMenuOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '1px solid var(--pixel-border)',
              borderRadius: 0,
              padding: 4,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            <button
              onClick={() => handleBypassSelect(false)}
              onMouseEnter={() => setHoveredBypass(0)}
              onMouseLeave={() => setHoveredBypass(null)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '5px 8px',
                fontSize: '13px',
                color: 'var(--pixel-text)',
                background: hoveredBypass === 0 ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                border: 'none',
                borderRadius: 0,
                cursor: 'pointer',
              }}
            >
              Normal
            </button>
            <div style={{ height: 1, margin: '4px 0', background: 'var(--pixel-border)' }} />
            <button
              onClick={() => handleBypassSelect(true)}
              onMouseEnter={() => setHoveredBypass(1)}
              onMouseLeave={() => setHoveredBypass(null)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '5px 8px',
                fontSize: '13px',
                color: 'var(--pixel-warning-text)',
                background: hoveredBypass === 1 ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                border: 'none',
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Bypass Permissions
            </button>
          </div>
        )}
        {isFolderPickerOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '1px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {workspaceFolders.map((folder, i) => (
              <button
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                onMouseEnter={() => setHoveredFolder(i)}
                onMouseLeave={() => setHoveredFolder(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 8px',
                  fontSize: '13px',
                  color: 'var(--pixel-text)',
                  background: hoveredFolder === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {folder.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      {agents.length > 0 && (
        <div ref={terminalRef} style={{ position: 'relative' }}>
          <button
            onClick={handleTerminalBtnClick}
            onMouseEnter={() => setHovered('terminal')}
            onMouseLeave={() => setHovered(null)}
            style={
              !isTerminalMinimized
                ? { ...btnActive }
                : {
                    ...btnBase,
                    background:
                      hovered === 'terminal' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                  }
            }
            title="Terminal"
          >
            Terminal
          </button>
          {isTerminalMenuOpen && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                marginBottom: 4,
                background: 'var(--pixel-bg)',
                border: '1px solid var(--pixel-border)',
                borderRadius: 0,
                padding: 4,
                boxShadow: 'var(--pixel-shadow)',
                minWidth: 140,
                zIndex: 'var(--pixel-controls-z)',
              }}
            >
              {agents.map((id, i) => (
                <button
                  key={id}
                  onClick={() => {
                    onSelectAgent(id);
                    setIsTerminalMenuOpen(false);
                  }}
                  onMouseEnter={() => setHoveredTerminal(i)}
                  onMouseLeave={() => setHoveredTerminal(null)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '5px 8px',
                    fontSize: '13px',
                    color: selectedAgent === id ? 'var(--pixel-accent)' : 'var(--pixel-text)',
                    background: hoveredTerminal === i ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                    border: 'none',
                    borderRadius: 0,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Agent {id} {selectedAgent === id ? '●' : ''}
                </button>
              ))}
              {agents.length > 0 && (
                <>
                  <div style={{ height: 1, margin: '4px 0', background: 'var(--pixel-border)' }} />
                  <button
                    onClick={() => {
                      onToggleTerminal();
                      setIsTerminalMenuOpen(false);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '5px 8px',
                      fontSize: '13px',
                      color: 'var(--pixel-text-dim)',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 0,
                      cursor: 'pointer',
                    }}
                  >
                    {isTerminalMinimized ? 'Show Terminal' : 'Hide Terminal'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background:
                    hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
          alwaysShowOverlay={alwaysShowOverlay}
          onToggleAlwaysShowOverlay={onToggleAlwaysShowOverlay}
          externalAssetDirectories={externalAssetDirectories}
        />
      </div>
    </div>
  );
}
