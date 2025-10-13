import { Edge } from '@xyflow/react';
import { WorkflowNode } from '../types';

const NODE_WIDTH = 320;
const VERTICAL_SPACING = 200; // Space between levels
const HORIZONTAL_SPACING = 50; // Space between nodes at same level
const PARENT_SPACING = 80; // Space between multiple parents

interface NodeLevel {
  nodes: WorkflowNode[];
  level: number;
  parentNodes: WorkflowNode[];
}

export function positionWorkflowNodes(nodes: WorkflowNode[], edges: Edge[]): WorkflowNode[] {
  if (nodes.length === 0) return nodes;

  // Create a map for quick node lookup
  const nodeMap = new Map<string, WorkflowNode>();
  nodes.forEach(node => nodeMap.set(node.id, node));

  // Build hierarchy levels
  const levels: NodeLevel[] = [];
  const processedNodes = new Set<string>();

  // Find root nodes (nodes with no incoming edges)
  const rootNodes = nodes.filter(node => !edges.some(edge => edge.target === node.id));

  // Process each root node and its descendants
  rootNodes.forEach(rootNode => {
    if (!processedNodes.has(rootNode.id)) {
      processNodeHierarchy(rootNode, nodeMap, edges, levels, processedNodes, 0);
    }
  });

  // Position nodes within each level
  levels.forEach((level, levelIndex) => {
    const y = levelIndex * VERTICAL_SPACING;

    if (level.nodes.length === 1) {
      // Single node - center it
      level.nodes[0].position = { x: 0, y };
    } else {
      // Multiple nodes - distribute horizontally
      const totalWidth = (level.nodes.length - 1) * (NODE_WIDTH + HORIZONTAL_SPACING);
      const startX = -totalWidth / 2;

      level.nodes.forEach((node, index) => {
        node.position = {
          x: startX + index * (NODE_WIDTH + HORIZONTAL_SPACING),
          y,
        };
      });
    }
  });

  // Handle multiple parents by adjusting positions
  adjustMultipleParentsPositions(nodes, edges);

  return nodes;
}

function processNodeHierarchy(
  node: WorkflowNode,
  nodeMap: Map<string, WorkflowNode>,
  edges: Edge[],
  levels: NodeLevel[],
  processedNodes: Set<string>,
  level: number,
) {
  if (processedNodes.has(node.id)) return;

  processedNodes.add(node.id);

  // Ensure we have enough levels
  while (levels.length <= level) {
    levels.push({ nodes: [], level: levels.length, parentNodes: [] });
  }

  // Add node to current level
  levels[level].nodes.push(node);

  // Find child nodes
  const childEdges = edges.filter(edge => edge.source === node.id);
  const childNodes = childEdges
    .map(edge => nodeMap.get(edge.target))
    .filter((childNode): childNode is WorkflowNode => childNode !== undefined);

  // Process each child
  childNodes.forEach(childNode => {
    processNodeHierarchy(childNode, nodeMap, edges, levels, processedNodes, level + 1);
  });
}

function adjustMultipleParentsPositions(nodes: WorkflowNode[], edges: Edge[]) {
  // Group nodes by their target (children with multiple parents)
  const childrenWithMultipleParents = new Map<string, WorkflowNode[]>();

  edges.forEach(edge => {
    if (!childrenWithMultipleParents.has(edge.target)) {
      childrenWithMultipleParents.set(edge.target, []);
    }
    const parentNode = nodes.find(node => node.id === edge.source);
    if (parentNode) {
      childrenWithMultipleParents.get(edge.target)!.push(parentNode);
    }
  });

  // Adjust positions for nodes with multiple parents
  childrenWithMultipleParents.forEach((parentNodes, childId) => {
    if (parentNodes.length > 1) {
      // Find the child node
      const childNode = nodes.find(node => node.id === childId);
      if (!childNode) return;

      // Calculate the center position of all parents
      const parentXPositions = parentNodes.map(node => node.position.x);
      const minX = Math.min(...parentXPositions);
      const maxX = Math.max(...parentXPositions);
      const centerX = (minX + maxX) / 2;

      // Position the child at the center of its parents
      childNode.position.x = centerX;

      // Ensure parents are evenly distributed
      const totalWidth = (parentNodes.length - 1) * (NODE_WIDTH + PARENT_SPACING);
      const startX = centerX - totalWidth / 2;

      parentNodes.forEach((parentNode, index) => {
        parentNode.position.x = startX + index * (NODE_WIDTH + PARENT_SPACING);
      });
    }
  });
}
