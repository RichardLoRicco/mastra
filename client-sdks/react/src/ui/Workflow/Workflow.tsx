import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Edge,
  EdgeChange,
  NodeChange,
  NodeTypes,
  ReactFlow,
} from '@xyflow/react';
import { useState, useCallback, useEffect } from 'react';
import { DefaultNode } from './custom-nodes';
import { WorkflowStreamResult } from '@mastra/core/workflows';
import { GetWorkflowResponse } from '@mastra/client-js';
import { buildNodes } from './utils/build-nodes';
import { WorkflowNode } from './types';

export const DefaultNodeTypes: NodeTypes = {
  default: DefaultNode,
};

export interface WorkflowProps {
  nodeTypes?: NodeTypes;
  workflow: GetWorkflowResponse;
  workflowResult: WorkflowStreamResult<any, any, any, any>;
}

export const Workflow = ({ nodeTypes = DefaultNodeTypes, workflowResult, workflow }: WorkflowProps) => {
  const [{ nodes, edges }, setNodes] = useState(() => buildNodes(workflow, workflowResult));

  useEffect(() => {
    setNodes(buildNodes(workflow, workflowResult));
  }, [workflowResult, workflow]);

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowNode>[]) =>
      setNodes(nodesSnapshot => ({
        nodes: applyNodeChanges(changes, nodesSnapshot.nodes),
        edges: nodesSnapshot.edges,
      })),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) =>
      setNodes(nodesSnapshot => ({
        nodes: nodesSnapshot.nodes,
        edges: applyEdgeChanges(changes, nodesSnapshot.edges),
      })),
    [],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      nodeTypes={nodeTypes}
      minZoom={0.01}
      maxZoom={1}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
};
