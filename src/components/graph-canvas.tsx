"use client";

import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  Position,
} from "reactflow";
import dagre from "@dagrejs/dagre";

import type {
  GraphView,
  FileNode,
  FileEdge,
  FunctionNode,
  FunctionEdge,
} from "@/lib/types";

import "reactflow/dist/style.css";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const FILE_COLOR = "#38bdf8";
const FUNCTION_COLOR = "#f471b5";
const DIRECTORY_COLOR = "#a855f7";

const EDGE_COLORS: Record<string, string> = {
  imports: "#f97316",
  reexports: "#34d399",
  invokes: "#facc15",
  "llm-reference": "#22d3ee",
};

type SupportedNode = FileNode | FunctionNode;
type SupportedEdge = FileEdge | FunctionEdge;

type GraphCanvasProps = {
  graph: GraphView<SupportedNode, SupportedEdge> | null | undefined;
  emptyMessage?: string;
  kind?: "files" | "functions";
};

export function GraphCanvas({ graph, emptyMessage, kind = "files" }: GraphCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    if (!graph || !graph.nodes.length) {
      return { nodes: [] as Node[], edges: [] as Edge[] };
    }

    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    dagreGraph.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 96, marginx: 32, marginy: 32 });

    graph.nodes.forEach((node) => {
      dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    });

    graph.edges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const styledNodes: Node[] = graph.nodes.map((node) => {
      const layout = dagreGraph.node(node.id);
      const x = layout ? layout.x - NODE_WIDTH / 2 : Math.random() * 400;
      const y = layout ? layout.y - NODE_HEIGHT / 2 : Math.random() * 400;

      const accent =
        kind === "files"
          ? node.kind === "directory"
            ? DIRECTORY_COLOR
            : FILE_COLOR
          : FUNCTION_COLOR;
      const secondary = (() => {
        if (kind === "functions" && "exportName" in node && node.exportName) {
          return `from ${node.filePath} · export ${node.exportName}`;
        }
        if ("kind" in node && node.kind === "directory") {
          if (node.path === ".") return "/";
          return node.path;
        }
        if ("path" in node) return node.path;
        if ("filePath" in node) return node.filePath;
        return undefined;
      })();

      return {
        id: node.id,
        data: {
          label: (
            <div className="flex h-full flex-col justify-center gap-1">
              <span className="text-sm font-semibold text-slate-100">{node.label}</span>
              {secondary ? <span className="text-xs text-slate-400">{secondary}</span> : null}
            </div>
          ),
        },
        position: { x, y },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          borderRadius: 16,
          border: `1px solid ${accent}40`,
          background: "rgba(15, 23, 42, 0.9)",
          boxShadow: `0 10px 30px -15px ${accent}66`,
          padding: 16,
        },
      } satisfies Node;
    });

    const styledEdges: Edge[] = graph.edges.map((edge) => {
      const color = EDGE_COLORS[edge.kind] ?? "#e2e8f0";
      const confidenceLabel = edge.sourceType === "llm" && edge.confidence ? ` (${edge.confidence})` : "";
      const label = `${edge.kind}${confidenceLabel}`.toUpperCase();
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label,
        markerEnd: { type: MarkerType.ArrowClosed, color },
        type: "smoothstep",
        animated: edge.sourceType === "llm",
        style: {
          stroke: color,
          strokeWidth: edge.sourceType === "llm" ? 1.2 : 1.6,
          strokeDasharray: edge.sourceType === "llm" ? "6 4" : undefined,
        },
        labelStyle: {
          fill: color,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
      } satisfies Edge;
    });

    return { nodes: styledNodes, edges: styledEdges };
  }, [graph, kind]);

  if (!graph || !graph.nodes.length) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-2xl border border-slate-800/70 bg-slate-950/60 text-sm text-slate-500">
        {emptyMessage ?? "Upload a repository to explore its structure."}
      </div>
    );
  }

  return (
    <div className="h-[560px] overflow-hidden rounded-2xl border border-slate-800/70 bg-slate-950/60">
      <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.1} maxZoom={1.75} proOptions={{ hideAttribution: true }}>
        <Background color="rgba(148, 163, 184, 0.2)" size={1} />
        <MiniMap
          zoomable
          pannable
          maskColor="rgba(2,6,23,0.8)"
          nodeStrokeColor={(node) =>
            node.id.startsWith("dir:") ? DIRECTORY_COLOR : kind === "files" ? FILE_COLOR : FUNCTION_COLOR
          }
          nodeColor={(node) =>
            node.id.startsWith("dir:")
              ? "rgba(168,85,247,0.2)"
              : kind === "files"
              ? "rgba(56,189,248,0.2)"
              : "rgba(244,113,181,0.2)"
          }
        />
        <Controls />
      </ReactFlow>
    </div>
  );
}
