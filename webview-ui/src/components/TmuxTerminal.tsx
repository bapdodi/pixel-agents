import React, { useEffect, useRef } from 'react';
import type { TerminalLine } from '../hooks/useExtensionMessages.js';

interface TmuxTerminalProps {
  agents: number[];
  selectedAgent: number | null;
  agentTerminalLines: { [id: number]: TerminalLine[] };
  onSelectAgent: (id: number) => void;
  onSendCommand: (id: number, text: string) => void;
  visible: boolean;
  isMinimized: boolean;
  onToggleMinimize: (e: React.MouseEvent) => void;
}

const TmuxTerminal: React.FC<TmuxTerminalProps> = ({
  agents,
  selectedAgent,
  agentTerminalLines,
  onSelectAgent,
  onSendCommand,
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

  // Ensure input is focused when selectedAgent changes or viewport is ready
  useEffect(() => {
    if (visible && selectedAgent !== null && !isMinimized) {
      inputRef.current?.focus();
    }
  }, [selectedAgent, visible, agents, isMinimized]);

  // Keep input focused when terminal is clicked
  const handleTerminalClick = () => {
    if (!isMinimized) {
      inputRef.current?.focus();
    }
  };

  const toggleMinimize = (e: React.MouseEvent) => {
    onToggleMinimize(e);
  };

  if (!visible || agents.length === 0) return null;

  const currentLines = selectedAgent !== null ? agentTerminalLines[selectedAgent] || [] : [];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Isolate this event from global listeners!
    e.stopPropagation();

    if (e.key === 'Enter' && selectedAgent !== null) {
      const text = e.currentTarget.value.trim();
      if (text) {
        onSendCommand(selectedAgent, text);
        e.currentTarget.value = '';
      }
    }
  };

  const renderWelcomeBox = () => (
    <div
      style={{
        border: '1px solid #D97757',
        borderRadius: '4px',
        padding: '12px 16px',
        margin: '8px 0 20px 0',
        backgroundColor: 'rgba(217, 119, 87, 0.05)',
        position: 'relative',
        fontFamily: '"Fira Code", monospace',
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
        Claude Code v2.1.80
      </div>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#D97757', fontSize: '14px', marginBottom: '8px' }}>
            Welcome back 🚀
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
            Running with <span style={{ color: '#D97757' }}>medium effort</span> • Claude Pro
          </div>
          <div style={{ opacity: 0.6 }}>Your workspace is ready for action.</div>
          <div style={{ marginTop: '12px', fontSize: '10px', color: '#888' }}>
            {selectedAgent !== null ? `Agent ID: ${selectedAgent}` : 'Initializing...'}
          </div>
        </div>
        <div
          style={{
            borderLeft: '1px solid rgba(217, 119, 87, 0.2)',
            paddingLeft: '24px',
            fontSize: '11px',
            color: '#888',
          }}
        >
          <div style={{ color: '#D97757', marginBottom: '4px', fontWeight: 'bold' }}>
            Tips for getting started
          </div>
          <div>Type your command below to interact.</div>
          <div>The agent is listening.</div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      onClick={handleTerminalClick}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: isMinimized ? '0px' : '280px',
        backgroundColor: '#1a1a1a',
        borderBottom: isMinimized ? 'none' : '2px solid #D97757',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000,
        fontFamily: '"Fira Code", monospace',
        transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        pointerEvents: isMinimized ? 'none' : 'auto',
        boxShadow: isMinimized ? 'none' : '0 4px 20px rgba(0,0,0,0.5)',
      }}
    >
      {/* Viewport (Hidden when minimized) */}
      {!isMinimized && (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            fontSize: '13px',
            lineHeight: '1.5',
            color: '#d1d1d1',
          }}
        >
          {renderWelcomeBox()}

          {currentLines.length === 0 ? (
            <div style={{ opacity: 0.4, marginTop: '8px' }}>
              <span style={{ color: '#D97757' }}>&gt;</span> Waiting for first message...
            </div>
          ) : (
            currentLines.map((line, i) => {
              const color = line.type === 'thought' ? '#888' : '#D97757';
              return (
                <div key={i} style={{ marginBottom: '6px', display: 'flex', gap: '10px' }}>
                  <span style={{ color, opacity: 0.9, fontWeight: 'bold' }}>
                    {line.type === 'thought' ? '●' : '>'}
                  </span>
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {line.content}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Input Area (Hidden when minimized) */}
      {!isMinimized && (
        <div
          style={{
            height: '48px',
            backgroundColor: '#222',
            borderTop: '1px solid rgba(217, 119, 87, 0.3)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: '12px',
          }}
        >
          <span style={{ color: '#D97757', fontWeight: 'bold', fontSize: '16px' }}>&gt;</span>
          <input
            ref={inputRef}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything..."
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#efefef',
              fontSize: '14px',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ fontSize: '10px', color: '#555', letterSpacing: '1px' }}>
            CLAUDE CODE
          </div>
        </div>
      )}

      {/* Status Bar - Always visible, acts as toggle */}
      <div
        onClick={toggleMinimize}
        style={{
          height: '32px',
          backgroundColor: '#333',
          color: '#D97757',
          borderTop: '1px solid #444',
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          fontWeight: 'bold',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{ opacity: 0.7 }}>TERMINAL</div>
          <div style={{ display: 'flex', gap: '2px' }}>
            {agents.map((id, index) => {
              const isActive = selectedAgent === id;
              return (
                <div
                  key={id}
                  onClick={(e) => {
                    if (isMinimized) {
                      toggleMinimize(e);
                    } else {
                      e.stopPropagation();
                      onSelectAgent(id);
                    }
                  }}
                  style={{
                    padding: '0 10px',
                    backgroundColor: isActive ? '#D97757' : 'transparent',
                    color: isActive ? '#1a1a1a' : '#D97757',
                    borderRadius: '2px',
                    transition: 'all 0.2s',
                  }}
                >
                  {index}:{id === selectedAgent ? `${id}*` : id}
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ opacity: 0.6, fontSize: '9px' }}>
            {isMinimized ? 'EXPAND 터미널 ▴' : 'HIDE 터미널 ▾'}
          </div>
          <div style={{ opacity: 0.8 }}>
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>

      <style>{`
        div::-webkit-scrollbar { width: 8px; }
        div::-webkit-scrollbar-track { background: #1a1a1a; }
        div::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        div::-webkit-scrollbar-thumb:hover { background: #444; }
      `}</style>
    </div>
  );
};

export default TmuxTerminal;
