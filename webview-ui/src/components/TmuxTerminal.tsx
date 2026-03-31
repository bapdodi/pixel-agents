import React, { useEffect, useRef } from 'react';

import type { TerminalLine } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';

interface TmuxTerminalProps {
  agents: number[];
  selectedAgent: number | null;
  agentTerminalLines: { [id: number]: TerminalLine[] };
  onSelectAgent: (id: number) => void;
  visible: boolean;
  isMinimized: boolean;
  onToggleMinimize: (e: React.MouseEvent) => void;
}

const TmuxTerminal: React.FC<TmuxTerminalProps> = ({
  agents,
  selectedAgent,
  agentTerminalLines,
  onSelectAgent,
  visible,
  isMinimized,
  onToggleMinimize,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (scrollRef.current && !isMinimized) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [agentTerminalLines, selectedAgent, isMinimized]);

  // Ensure input is focused when selectedAgent changes
  useEffect(() => {
    if (visible && selectedAgent !== null && !isMinimized) {
      inputRef.current?.focus();
    }
  }, [selectedAgent, visible, isMinimized]);

  // Handle command sending
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && selectedAgent !== null) {
      const text = e.currentTarget.value.trim();
      if (text) {
        vscode.postMessage({ type: 'agentTerminalInput', id: selectedAgent, input: text + '\n' });
        e.currentTarget.value = '';
      }
    }
  };

  if (!visible) return null;

  const currentLines = selectedAgent !== null ? agentTerminalLines[selectedAgent] || [] : [];

  const renderWelcomeBox = () => (
    <div
      style={{
        border: '1px solid #D97757',
        borderRadius: '4px',
        padding: '12px 16px',
        margin: '8px 0 20px 0',
        backgroundColor: 'rgba(217, 119, 87, 0.05)',
        position: 'relative',
        fontFamily: 'monospace',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '-10px',
          left: '16px',
          backgroundColor: '#1a1a1a',
          padding: '0 8px',
          color: '#D97757',
          fontSize: '11px',
          fontWeight: 'bold',
        }}
      >
        PIXEL AGENTS TERMINAL v1.0
      </div>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#D97757', fontSize: '14px', marginBottom: '8px' }}>
            AGENT CLI READY 🚀
          </div>
          <pre
            style={{
              margin: 0,
              fontSize: '8px',
              lineHeight: '1',
              color: '#D97757',
            }}
          >
            {`   ▆▆▆▆▆   
  ▆     ▆  
 ▆  ●  ●  ▆ 
 ▆   ▆▆   ▆ 
  ▆      ▆  
   ▆▆▆▆▆   `}
          </pre>
        </div>
        <div style={{ flex: 1, fontSize: '12px', color: '#d1d1d1' }}>
          <div style={{ marginBottom: '8px', opacity: 0.8 }}>
            Running in <span style={{ color: '#D97757' }}>Hi-Fi Readability Mode</span>
          </div>
          <div style={{ opacity: 0.6 }}>Direct DOM rendering for perfect text clarity.</div>
          <div style={{ marginTop: '12px', fontSize: '10px', color: '#888' }}>
            {selectedAgent !== null ? `ID: ${selectedAgent}` : 'Waiting for connection...'}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: isMinimized ? 32 : 280,
        backgroundColor: '#1a1a1a',
        borderBottom: '2px solid #D97757',
        zIndex: 51,
        transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: isMinimized ? 'none' : '0 4px 20px rgba(0,0,0,0.5)',
      }}
    >
      {/* Header / Status Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 10px',
          fontSize: '11px',
          background: '#2d2d2d',
          color: '#D97757',
          borderBottom: '1px solid #3d3d3d',
          fontFamily: 'monospace',
          fontWeight: 'bold',
          cursor: 'pointer',
        }}
        onClick={(e) => onToggleMinimize(e)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: agents.length > 0 ? '#4caf50' : '#f44336',
            }}
          />
          TERMINAL SYSTEM: {isMinimized ? 'MINIMIZED' : 'ONLINE'}
        </div>
        <div style={{ opacity: 0.8 }}>{isMinimized ? 'CLICK TO EXPAND ▴' : 'CLICK TO HIDE ▾'}</div>
      </div>

      {/* Terminal Content (DOM rendered) */}
      {!isMinimized && (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            fontSize: '13px',
            lineHeight: '1.4',
            color: '#d1d1d1',
            fontFamily: 'monospace',
            WebkitFontSmoothing: 'subpixel-antialiased',
          }}
        >
          {renderWelcomeBox()}

          {currentLines.length === 0 ? (
            <div style={{ opacity: 0.4, marginTop: '8px' }}>
              <span style={{ color: '#D97757' }}>&gt;</span> 초기화 대기 중...
            </div>
          ) : (
            currentLines.map((line, i) => (
              <div key={i} style={{ marginBottom: '4px', display: 'flex', gap: '8px' }}>
                <span style={{ color: '#D97757', fontWeight: 'bold' }}>&gt;</span>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {line.content}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Input Field */}
      {!isMinimized && (
        <div
          style={{
            height: '40px',
            background: '#242424',
            borderTop: '1px solid #333',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            gap: '8px',
          }}
        >
          <span style={{ color: '#D97757', fontWeight: 'bold' }}>&gt;</span>
          <input
            ref={inputRef}
            onKeyDown={handleKeyDown}
            placeholder="명령어 입력..."
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#f0f0f0',
              fontSize: '13px',
              fontFamily: 'monospace',
            }}
          />
        </div>
      )}

      {/* Tab Bar Agent selection */}
      <div
        style={{
          height: 32,
          minHeight: 32,
          background: '#1a1a1a',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 10px',
          fontSize: '11px',
          borderTop: '1px solid #333',
        }}
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {agents.map((id) => {
            const isActive = selectedAgent === id;
            return (
              <div
                key={id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(id);
                }}
                style={{
                  padding: '2px 8px',
                  background: isActive ? '#D97757' : 'transparent',
                  color: isActive ? '#1a1a1a' : '#D97757',
                  borderRadius: 2,
                  cursor: 'pointer',
                  fontWeight: isActive ? 'bold' : 'normal',
                  fontSize: '10px',
                }}
              >
                AG:{id}
              </div>
            );
          })}
        </div>
      </div>

      <style>{`
        div::-webkit-scrollbar { width: 6px; }
        div::-webkit-scrollbar-track { background: #1a1a1a; }
        div::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        div::-webkit-scrollbar-thumb:hover { background: #444; }
      `}</style>
    </div>
  );
};

export default TmuxTerminal;
