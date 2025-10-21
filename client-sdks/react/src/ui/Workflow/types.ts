import { SerializedStepFlowEntry, WorkflowStreamResult } from '@mastra/core/workflows';
import { Edge, Node } from '@xyflow/react';

export type WorkflowStatusType = 'running' | 'success' | 'failed' | 'suspended' | 'waiting' | 'idle';
export type WorkflowNode = Node<
  {
    // Workflow Domain related data
    step: SerializedStepFlowEntry;
    stepRun?: WorkflowStreamResult<any, any, any, any>['steps'][string];

    // Nodes related data
    parentNodes?: WorkflowNode[];

    // Useful to show the handles properly
    isLastStep: boolean;

    type?: StepMetadataType;
    nestedWorkflowNodes?: { nodes: WorkflowNode[]; edges: Edge[] };
  },
  'default' | 'group'
>;

export type StepMetadataType = 'conditional' | 'parallel';

export type StepWithMetadata = SerializedStepFlowEntry & {
  condition?: string;
};
