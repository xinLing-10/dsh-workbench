/** Public DTOs only. Worker secrets, model credentials and filesystem paths never belong here. */
export type Capabilities = Record<string, boolean>;
export type User = { id: string; email: string; platformAdmin?: boolean };
export type Session = {
  user: User;
  csrfToken: string;
  capabilities: Capabilities;
};
export type Project = { id: string; name: string; notes?: string };
export type Operation = {
  task?: { id: string; title: string; kind: string } | null;
  id: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
};
export type Question = {
  id: string;
  question: string;
  detail?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
};
export type Interaction = {
  id: string;
  kind: string;
  prompt: string;
  expiresAt?: string;
  questions?: Question[];
};
export type Message = {
  clarification?: boolean;
  sources?: { url: string; title: string; sha256: string; fetchedAt: string }[];
  id: string | number;
  role: string;
  text: string;
  operationId?: string;
  task?: { id: string; title: string; kind: string } | null;
  context?: {
    refs: {
      id: string;
      type: string;
      path?: string;
      startLine?: number;
      endLine?: number;
      sha256?: string;
      eventId?: number;
    }[];
    truncated: boolean;
  };
  preview?: boolean;
  streamState?: string;
};
export type LearningPlan = {
  id: string;
  title: string;
  lessons: {
    id: string;
    title: string;
    objective: string;
    status: string;
    question: string;
    minutes: number;
  }[];
};
export type BusinessTask = {
  workflow?: boolean;
  id: string;
  title: string;
  kind: "work" | "learning";
  state: string;
  delivery: string;
  operations: { id: string; state: string }[];
  artifacts: {
    id: string;
    path: string;
    version: number;
    confirmed: boolean;
  }[];
  learning?: { plan: LearningPlan | null; revision: number };
};
export type Detail = {
  tasks?: BusinessTask[];
  project: Project;
  operations: Operation[];
  interactions: Interaction[];
  capabilities: Capabilities;
};
export type Artifact = {
  task?: { id: string; title: string; kind: string } | null;
  id: string;
  name: string;
  confirmed: boolean;
  sha256: string;
  version: number;
};
export type ArtifactView = {
  artifact: Artifact;
  text: string;
  truncated?: boolean;
};
export type ArtifactVersions = { versions: Artifact[]; latestId: string };
export type Source = { path: string; bytes: number; sha256?: string };
export type SourceCandidate = { path: string; content: string };
export type Policy = {
  scope: string;
  scopeId: string;
  limit: number;
  used: number;
  held: number;
  remaining: number;
  frozen: boolean;
  window: string;
  revision: number;
};
export type PendingCall = {
  id: string;
  kind?: string;
  state: string;
  reservation: number;
  actual: number | null;
  revision: number;
  evidence_json?: string;
  held?: number;
  used?: number;
};
export type Execution = {
  operation_id: string;
  project_id: string;
  state: string;
};
export type Audit = {
  at: string;
  action: string;
  target: string;
  actor: string;
  meta_json: string;
};
export type QueueRow = {
  id: string;
  state: string;
  projectName: string;
  actorEmail?: string;
  tenantName?: string;
  workerId?: string;
  updated_at: string;
};
export type Dashboard = {
  at: string;
  fixture?: boolean;
  paused: boolean;
  counts: Record<string, number>;
  model: { settledTokens: number; unknownRequests: number };
  totals: { users: number; tenants: number; projects: number };
  trend: { date: string; tokens: number; requests: number }[];
  process: {
    node: string;
    uptimeSeconds: number;
    memoryBytes: number;
    schema: number;
  };
  workers: {
    id: string;
    status: string;
    reported: boolean;
    connected: boolean;
    isolated: boolean;
    active: number;
    generation: number;
  }[];
  queue: QueueRow[];
  capabilities: { recovery: boolean };
};
export type Service = {
  enabled: boolean;
  environment: { workerReady: boolean; modelGateway: boolean };
  dashboard: Dashboard;
  authorization?: { tokenLimit: number; maxRequests: number };
  policies: Policy[];
  users: { id: string; email: string }[];
  projects: Project[];
  pending: PendingCall[];
  carryovers: PendingCall[];
  executions: Execution[];
  audit: Audit[];
};
export type Invitations = {
  enabled: boolean;
  tenants: { id: string; name: string }[];
  invitations: {
    id: string;
    tenantName: string;
    status: string;
    expiresAt: string;
    redeemedBy?: string;
  }[];
};
export type IssuedInvitation = {
  token: string;
  tenantName: string;
  expiresAt: string;
};
