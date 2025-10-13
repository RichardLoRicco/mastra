import { GetWorkflowResponse } from '@mastra/client-js';
import { Edge } from '@xyflow/react';
import { StepMetadataType, WorkflowNode } from '../types';
import { WorkflowStreamResult } from '@mastra/core/workflows';
import { positionWorkflowNodes } from './position-nodes';
import { StepWithMetadata } from '../types';

type WorkflowStepToNodeArgs = {
  id: string;
  step: StepWithMetadata;
  hasChild: boolean;
  stepRun?: WorkflowStreamResult<any, any, any, any>['steps'][string];
  parentNodes?: WorkflowNode[];
  type?: StepMetadataType;
};

const workflowStepToNode = ({
  id,
  step,
  hasChild,
  stepRun,
  parentNodes,
  type,
}: WorkflowStepToNodeArgs): WorkflowNode => {
  return {
    id,
    position: { x: 0, y: 0 }, // Will be overridden by positioning logic
    data: {
      step,
      stepRun,
      isLastStep: !hasChild,
      parentNodes,
      type,
    },
    type: 'step',
  };
};

export const buildNodes = (workflow: GetWorkflowResponse, workflowResult: WorkflowStreamResult<any, any, any, any>) => {
  const nodes: WorkflowNode[] = [];
  const edges: Edge[] = [];
  let currentParentNodes: WorkflowNode[] = [];

  for (let i = 0; i < workflow.stepGraph.length; i++) {
    const step = workflow.stepGraph[i];
    const childStep = workflow.stepGraph[i + 1];
    const hasChild = Boolean(childStep);
    const nodeId = String(i);

    const { nodes: nodesToAdd, edges: edgesToAdd } = createStepNode({
      id: nodeId,
      step,
      parentNodes: currentParentNodes,
      hasChild,
      workflowResult,
    });

    nodes.push(...nodesToAdd);
    edges.push(...edgesToAdd);

    currentParentNodes = nodesToAdd;
  }

  // Apply positioning to all nodes
  const positionedNodes = positionWorkflowNodes(nodes, edges);

  return { nodes: positionedNodes, edges };
};

type CreateStepNodeArgs = {
  id: string;
  step: StepWithMetadata;
  hasChild: boolean;
  workflowResult?: WorkflowStreamResult<any, any, any, any>;
  parentNodes?: WorkflowNode[];
  type?: StepMetadataType;
};
const createStepNode = ({
  id,
  step,
  hasChild,
  workflowResult,
  parentNodes,
  type,
}: CreateStepNodeArgs): { nodes: WorkflowNode[]; edges: Edge[] } => {
  const parents = parentNodes || [];
  const hasParents = parents.length > 0;

  switch (step.type) {
    case 'waitForEvent':
    case 'foreach':
    case 'loop':
    case 'step': {
      const node = workflowStepToNode({
        id,
        step,
        hasChild,
        stepRun: workflowResult?.steps[step.step.id],
        parentNodes,
        type,
      });

      const edges: Edge[] = [];
      if (hasParents) {
        edges.push(...parents.map(parentNode => buildEdge({ parentNode, node })));
      }
      return { nodes: [node], edges };
    }

    case 'sleepUntil':
    case 'sleep': {
      const node = workflowStepToNode({
        id,
        step,
        parentNodes,
        hasChild,
        stepRun: workflowResult?.steps[step.id],
        type,
      });

      const edges: Edge[] = [];

      if (hasParents) {
        edges.push(...parents.map(parentNode => buildEdge({ parentNode, node })));
      }

      return { nodes: [node], edges };
    }

    case 'conditional': {
      const nodes: WorkflowNode[] = [];
      const edges: Edge[] = [];

      step.steps.forEach((subStep, index) => {
        const node = createStepNode({
          id: `${id}-${index}`,
          step: { ...subStep, condition: step.serializedConditions[index]?.fn },
          parentNodes,
          hasChild,
          workflowResult,
          type: step.type,
        });

        nodes.push(...node.nodes);
        edges.push(...node.edges);
      });

      return { nodes, edges };
    }

    case 'parallel': {
      const nodes: WorkflowNode[] = [];
      const edges: Edge[] = [];

      step.steps.forEach((subStep, index) => {
        const node = createStepNode({
          id: `${id}-${index}`,
          step: subStep,
          parentNodes,
          hasChild,
          workflowResult,
          type: step.type,
        });

        nodes.push(...node.nodes);
        edges.push(...node.edges);
      });

      return { nodes, edges };
    }
  }
};

type BuildEdgeArgs = {
  parentNode: WorkflowNode;
  node: WorkflowNode;
};

const buildEdge = ({ parentNode, node }: BuildEdgeArgs): Edge => {
  const status = parentNode.data.stepRun?.status;

  return {
    id: `${parentNode.id}->${node.id}`,
    source: parentNode.id,
    target: node.id,
    style: {
      stroke: status === 'success' ? 'var(--color-accent1)' : undefined,
      strokeWidth: status === 'success' ? 2 : undefined,
      strokeDasharray: status === 'success' ? undefined : '5 5',
    },
  };
};
