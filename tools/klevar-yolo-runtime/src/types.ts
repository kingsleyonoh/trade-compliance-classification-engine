export type YoloScope =
  | { mode: "full"; target?: string }
  | { mode: "phase"; target: string }
  | { mode: "count"; target: string }
  | { mode: "items"; target: string }
  | { mode: "parallel"; target: string }
  | { mode: "resume"; target?: string };

export type AgentRole = "master" | "knowledge" | "inbox" | "implement" | "validate" | "journal" | "audit" | "bugfix" | "adjudicate";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ResultStatus = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" | "BUG_FOUND" | "INVALID_RESULT";

export interface AgentBudgetConfig {
  staleMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxToolCalls?: number;
  maxEstimatedCost?: number;
}

export interface ModelRoute {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  timeoutSeconds?: number;
  budget?: AgentBudgetConfig;
}

export interface RuntimeConfig {
  schemaVersion: number;
  maxBatchSize: number;
  reinforcementThreshold: number;
  worktrees: { enabled: boolean; keepOnFailure: boolean };
  retention: { keepSuccessfulWorktrees: number; keepFailedWorktrees: boolean };
  policy: { blockedPaths: string[]; protectedPaths: string[]; allowedGeneratedPaths: string[]; localOnlyPaths: string[]; allowExternalMutations?: boolean };
  models: Record<AgentRole, ModelRoute>;
  recovery?: {
    maxBugfixAttempts: number;
    retryJournalOnce: boolean;
  };
  collaboration?: {
    enabled: boolean;
    claimsDir: string;
    staleClaimHours: number;
    maxParallelAgents: number;
  };
  frontend?: {
    impeccableCommand: string;
    failOnDetectorFindings: boolean;
    detectorTimeoutMs: number;
  };
  gates: {
    requireTdd: boolean;
    requireE2eForEntrypoints: boolean;
    requireWiring: boolean;
    requireAdversarialValidation: boolean;
    requireProjectLocalChecks: boolean;
    requireBusinessLogicEvidence: boolean;
    requireArtifactUniqueness: boolean;
    requireFrontendImpeccable: boolean;
    requireProductQuality: boolean;
  };
}

export interface ProgressItem {
  raw: string;
  tag: string;
  title: string;
  phase: string;
  checked: boolean;
  details?: string[];
  affectedFiles?: string[];
  claim?: string;
}

export interface Batch {
  number: number;
  items: ProgressItem[];
  type: "implement" | "audit";
  supportKind?: "modularity" | "validate-prd" | "security-audit";
  supportScope?: string;
}

export interface SubagentInvocation {
  id: string;
  role: AgentRole;
  promptFile: string;
  context: string;
  outputBase: string;
  cwd: string;
  route: ModelRoute;
  telemetryRoot?: string;
  promptVars?: Record<string, string>;
}

export interface TestEvidence {
  command: string;
  exitCode: number;
  evidence: string;
}

export interface BatchResult {
  schemaVersion: number;
  agent: AgentRole;
  batch: number;
  status: ResultStatus;
  itemsCompleted: string[];
  filesChanged: string[];
  tests?: { red?: TestEvidence; green?: TestEvidence; regression?: TestEvidence; e2e?: TestEvidence & { required: boolean } };
  wiring?: { required: boolean; entrypoints: Array<{ type: string; path: string; verifiedBy: string }> };
  projectLocalChecks?: { evaluated: number; triggered: string[]; notes?: string };
  businessLogic?: { rule: string; sourceOfTruth: string; observablePaths: string[]; test: string };
  artifacts?: Array<{ path: string; description?: string }>;
  localOnlyFiles?: string[];
  inbox?: { handledTitles: string[] };
  failureType?: string;
  flags: string[];
  commit?: string | null;
}

export interface GateResult {
  name: string;
  passed: boolean;
  flags: string[];
}
