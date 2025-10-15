import { Node, Edge } from '@xyflow/react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceX, forceY } from 'd3-force';

export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'LR'
) {
  // Force-directed layout for optimal edge distances
  const width = 800;
  const height = 600;

  // Create nodes with consistent initial positions (circular)
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(200, nodes.length * 5);

  const simulationNodes = nodes.map((node, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    return {
      ...node,
      x,
      y,
      fx: null,
      fy: null,
    };
  });

  // Create links
  const simulationLinks = edges.map(edge => ({
    source: simulationNodes.find(n => n.id === edge.source)!,
    target: simulationNodes.find(n => n.id === edge.target)!,
  })).filter(link => link.source && link.target);

  // Run force simulation
  const simulation = forceSimulation(simulationNodes)
    .force('link', forceLink(simulationLinks).distance(50))
    .force('charge', forceManyBody().strength(-200))
    .force('center', forceCenter(width / 2, height / 2))
    .force('x', forceX(width / 2).strength(0.1))
    .force('y', forceY(height / 2).strength(0.1))
    .stop();

  // Run simulation for a few ticks
  for (let i = 0; i < 100; i++) {
    simulation.tick();
  }

  const layoutedNodes: Node[] = simulationNodes.map((node) => ({
    ...node,
    type: 'customNode',
    position: { x: node.x || 0, y: node.y || 0 },
    data: {
      label: (node.data as { label?: string }).label || '', // Preserve the original label
    },
  }));

  const layoutedEdges: Edge[] = edges.map((edge) => ({
    ...edge,
    type: 'straight',
    animated: false,
    style: {
      stroke: 'rgba(255, 255, 255, 0.8)',
      strokeWidth: 0.5,
    },
  }));

  return { nodes: layoutedNodes, edges: layoutedEdges };
}
