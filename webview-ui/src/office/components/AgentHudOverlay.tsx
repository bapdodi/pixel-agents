import React, { useEffect, useState } from 'react';
import type { OfficeState } from '../engine/officeState.js';
import { TILE_SIZE } from '../types.js';
import type { TerminalLine } from '../../hooks/useExtensionMessages.js';
import AgentHud from './AgentHud.js';

interface AgentHudOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTerminalLines: Record<number, TerminalLine[]>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  alwaysShowOverlay: boolean;
}

export const AgentHudOverlay: React.FC<AgentHudOverlayProps> = ({
  officeState,
  agents,
  agentTerminalLines,
  containerRef,
  zoom,
  panRef,
  alwaysShowOverlay,
}) => {
  const [, setTick] = useState(0);

  // Synced with ToolOverlay's tick for smooth positioning
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  return (
    <>
      {agents.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        
        // Show HUD only if active or selected/hovered
        const lines = agentTerminalLines[id] || [];
        if (lines.length === 0) return null;
        
        // Follow the same visibility logic as ToolOverlay
        if (!alwaysShowOverlay && !isSelected && !isHovered && !ch.isActive) return null;

        // Calculate screen position
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
        const screenY = (deviceOffsetY + ch.y * zoom) / dpr;

        return (
          <AgentHud
            key={`hud-${id}`}
            agentId={id}
            lines={lines}
            position={{ x: screenX, y: screenY }}
            visible={true}
          />
        );
      })}
    </>
  );
};
