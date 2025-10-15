'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import html2canvas from 'html2canvas';
import { motion } from 'framer-motion';
import { getLayoutedElements } from '@/lib/layout';
import { useSession, signIn, signOut } from 'next-auth/react';

interface FileNode {
  id: string;
  label: string;
  file: string;
}

interface FunctionNode {
  id: string;
  label: string;
  file: string;
  type: 'function' | 'class' | 'method';
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

interface AnalysisResult {
  files: {
    nodes: FileNode[];
    edges: GraphEdge[];
  };
  functions: {
    nodes: FunctionNode[];
    edges: GraphEdge[];
  };
}

interface GraphVisualizationProps {
  data: AnalysisResult;
  repoUrl: string;
  onBack: () => void;
}

// Custom node component with center handle
function CustomNode({ data }: { data: { label: string } }) {
  return (
    <div
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        border: 'none',
        borderRadius: '50%',
        color: '#000000',
        padding: '1px',
        fontSize: '6px',
        fontWeight: '400',
        width: 2,
        height: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      {data.label && (
        <div
          style={{
            position: 'absolute',
            top: '-20px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '2px 4px',
            borderRadius: '3px',
            fontSize: '8px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          {data.label}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.8)',
          border: 'none',
          width: 2,
          height: 2,
          borderRadius: '50%',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />
      <Handle
        type="target"
        position={Position.Top}
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.8)',
          border: 'none',
          width: 2,
          height: 2,
          borderRadius: '50%',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  );
}

const nodeTypes = {
  customNode: CustomNode,
};

export default function GraphVisualization({ data, repoUrl, onBack }: GraphVisualizationProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [showLabels, setShowLabels] = useState(false); // Hidden by default
  const [isMobile, setIsMobile] = useState(false);
  const graphRef = useRef<HTMLDivElement>(null);
  const { data: session } = useSession();

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 640);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (data?.files) {
      // Transform FileNode[] and GraphEdge[] to React Flow Node[] and Edge[]
      const reactFlowNodes: Node[] = data.files.nodes.map(node => ({
        id: node.id,
        position: { x: 0, y: 0 }, // Will be set by layout
        data: { label: node.label },
        type: 'customNode',
      }));
      
      const reactFlowEdges: Edge[] = data.files.edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'straight',
      }));

      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
        reactFlowNodes,
        reactFlowEdges
      );
      
      // Conditionally hide labels
      const nodesWithLabels = layoutedNodes.map(node => ({
        ...node,
        data: {
          ...node.data,
          label: showLabels ? node.data.label : '',
        },
      }));
      
      setNodes(nodesWithLabels);
      setEdges(layoutedEdges);
    }
  }, [data, setNodes, setEdges, showLabels]);

  // Check and generate image preview
  useEffect(() => {
    if (repoUrl) {
      fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      }).catch(err => console.warn('Failed to generate image preview:', err));
    }
  }, [repoUrl]);

  const exportGraph = useCallback(async () => {
    if (graphRef.current) {
      const controls = graphRef.current.querySelector('.react-flow__controls');
      const minimap = graphRef.current.querySelector('.react-flow__minimap');
      
      const canvas = await html2canvas(graphRef.current, {
        backgroundColor: 'black',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        foreignObjectRendering: true,
        ignoreElements: (element) => {
          return element === controls || element === minimap || 
                 element.classList.contains('react-flow__controls') || 
                 element.classList.contains('react-flow__minimap');
        }
      });
      const link = document.createElement('a');
      link.download = 'gitweb-graph.png';
      link.href = canvas.toDataURL();
      link.click();
    }
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: 'black' }}>
      <style dangerouslySetInnerHTML={{
        __html: `
          .react-flow__controls-button {
            background-color: rgba(255, 255, 255, 0.1) !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
            color: rgba(255, 255, 255, 0.8) !important;
            border-radius: 4px !important;
          }
          .react-flow__controls-button:hover {
            background-color: rgba(255, 255, 255, 0.2) !important;
            border-color: rgba(255, 255, 255, 0.4) !important;
          }
          .react-flow__controls-button svg {
            fill: rgba(255, 255, 255, 0.8) !important;
          }
          .react-flow__minimap {
            background-color: rgba(0, 0, 0, 0.8) !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
          }
          .react-flow__minimap-node {
            fill: rgba(255, 255, 255, 0.6) !important;
            stroke: rgba(255, 255, 255, 0.8) !important;
          }
          .react-flow__minimap-mask {
            fill: rgba(0, 0, 0, 0.6) !important;
          }
        `
      }} />
      {/* Header */}
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: isMobile ? 'flex-start' : 'center',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: isMobile ? 'flex-start' : 'space-between',
          padding: '1.5rem',
          gap: isMobile ? '1rem' : '0',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)'
        }}
      >
        <button
          onClick={onBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            color: 'rgba(255, 255, 255, 0.6)',
            fontSize: '0.875rem',
            fontWeight: '300',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            transition: 'color 0.2s'
          }}
          onMouseEnter={(e) => ((e.target as HTMLElement).style.color = 'white')}
          onMouseLeave={(e) => ((e.target as HTMLElement).style.color = 'rgba(255, 255, 255, 0.6)')}
        >
          <svg style={{ width: '1.25rem', height: '1.25rem' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => setShowLabels(!showLabels)}
            style={{
              color: 'rgba(255, 255, 255, 0.6)',
              fontSize: '0.875rem',
              fontWeight: '300',
              background: 'none',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '0.25rem',
              padding: '0.25rem 0.5rem',
              cursor: 'pointer',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem'
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.color = 'white';
              (e.target as HTMLElement).style.borderColor = 'rgba(255, 255, 255, 0.4)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.color = 'rgba(255, 255, 255, 0.6)';
              (e.target as HTMLElement).style.borderColor = 'rgba(255, 255, 255, 0.2)';
            }}
            title={isMobile ? (showLabels ? 'Hide Labels' : 'Show Labels') : undefined}
          >
            <svg style={{ width: '1rem', height: '1rem' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {!isMobile && (showLabels ? 'Hide Labels' : 'Show Labels')}
          </button>
          <button
            onClick={exportGraph}
            style={{
              color: 'rgba(255, 255, 255, 0.6)',
              fontSize: '0.875rem',
              fontWeight: '300',
              background: 'none',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '0.25rem',
              padding: '0.25rem 0.5rem',
              cursor: 'pointer',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem'
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.color = 'white';
              (e.target as HTMLElement).style.borderColor = 'rgba(255, 255, 255, 0.4)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.color = 'rgba(255, 255, 255, 0.6)';
              (e.target as HTMLElement).style.borderColor = 'rgba(255, 255, 255, 0.2)';
            }}
            title={isMobile ? 'Export PNG' : undefined}
          >
            <svg style={{ width: '1rem', height: '1rem' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {!isMobile && 'Export PNG'}
          </button>
          <div style={{
            color: 'rgba(255, 255, 255, 0.4)',
            fontSize: '0.875rem',
            fontWeight: '300'
          }}>
            {nodes.length} files · {edges.length} relationships
          </div>
          {/* {session && (
            <button
              onClick={() => signOut()}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: 'white',
                padding: '0.25rem 0.5rem',
                borderRadius: '0.25rem',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                fontSize: '0.875rem',
                fontWeight: '300',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              Sign Out
            </button>
          )} */}
        </div>
      </motion.div>

      {/* Graph */}
      <div ref={graphRef} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: 'black' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          defaultEdgeOptions={{
            type: 'straight',
            style: { stroke: 'rgba(255, 255, 255, 0.8)', strokeWidth: 0.5 },
            animated: false,
          }}
          fitView
          fitViewOptions={{ padding: 0.05 }}
          minZoom={0.05}
          maxZoom={2}
          attributionPosition="bottom-left"
          proOptions={{ hideAttribution: true }}
          style={{ backgroundColor: 'black' }}
        >
          <Background color="rgba(255, 255, 255, 0.08)" gap={16} />
          <Controls 
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '0.5rem'
            }}
            className="react-flow-controls"
          />
          <MiniMap 
            style={{
              backgroundColor: 'rgba(0, 0, 0, 0.8)',
              border: '1px solid rgba(255, 255, 255, 0.2)'
            }}
            nodeColor="rgba(255, 255, 255, 0.8)"
            nodeStrokeColor="rgba(255, 255, 255, 1)"
            nodeStrokeWidth={1}
            maskColor="rgba(0, 0, 0, 0.7)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
