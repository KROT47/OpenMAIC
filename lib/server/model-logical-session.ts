export const MODEL_LOGICAL_SESSION_KINDS = ['chat', 'agent-edit'] as const;

export type ModelLogicalSessionKind = (typeof MODEL_LOGICAL_SESSION_KINDS)[number];

export interface ModelLogicalSession {
  kind: ModelLogicalSessionKind;
  id: string;
}
