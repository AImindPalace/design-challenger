export type Stage = "brainstorming" | "spec_writing" | "plan_writing" | "complete" | "aborted";
export type Severity = "CRITICAL" | "IMPORTANT" | "MINOR";
export type FindingDisposition = "addressed" | "rejected";
export type GateAction = "approve" | "request_changes" | "abort";

export interface RunConfig {
  topic: string;
  repoPath: string;
  writerModel: string;
  challengerModel: string;
  judgeModel: string;
  maxRounds: number;
  budget: number;
  writerBudget: number;
  challengerBudget: number;
  judgeBudget: number;
  verifierBudget: number;
  outputDir: string;
  quiet: boolean;
  skipBrainstorm: boolean;
  existingSpecPath?: string;
  resumeRunId?: string;
}

export interface RunState {
  runId: string;
  topic: string;
  config: RunConfig;
  currentStage: Stage;
  currentRound: number;
  writerSessionId?: string;
  challengerSessionId?: string;
  gateOutcomes: GateOutcome[];
  tokenUsage: TokenUsage;
  startedAt: string;
  lastCheckpoint: string;
}

export interface GateOutcome {
  stage: Stage;
  action: GateAction;
  userDirection?: string;
  timestamp: string;
}

export interface TokenUsage {
  writer: { input: number; output: number };
  challenger: { input: number; output: number };
  judge: { input: number; output: number };
  verifier: { input: number; output: number };
}

export interface Evidence {
  type: "file" | "url" | "git_commit";
  location: string;
  lines?: string;
  summary: string;
}

export interface Finding {
  id: number;
  summary: string;
  severity: Severity;
  assumption_id?: number;
  counter_design_divergence: boolean;
  upstream_issue: boolean;
  upstream_source?: string;
  evidence: Evidence[];
  evidence_type: "codebase" | "external";
  evidence_verified?: boolean;
  recommendation: string;
}

export interface WriterDispositionEntry {
  finding_id: number;
  disposition: FindingDisposition;
  detail: string;
}

export interface Assumption {
  id: number;
  text: string;
  source: string;
  status: "verified" | "falsified" | "untested";
  evidence: string;
}

export interface ExternalClaim {
  text: string;
  source: string;
}

export interface VerificationResult {
  claim: string;
  verified: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string;
  source_checked: string;
}

export interface EvidenceEntry {
  id: string;
  type: "file" | "url" | "git_commit";
  location: string;
  lines?: string;
  summary: string;
  cited_by: string[];
}

export interface GateSummary {
  stage: Stage;
  round: number;
  findingsForwarded: number;
  findingsFiltered: number;
  findingsAddressed: number;
  findingsRejected: number;
  assumptionsSurvived: number;
  assumptionsFalsified: number;
  specDiffLines: number;
  artifactPath: string;
  unresolvedConcerns: string[];
}

export interface MetricsSummary {
  assumptionSurvivalRate: number;
  findingResolutionRate: number;
  findingRejectionRate: number;
  judgeFilterRate: number;
  counterDesignImpact: number;
  preReviewRefutationRate: number;
  upstreamIssueRate: number;
  externalEvidenceVerificationRate: number;
  checklistRePromptRate: number;
  specDiffSize: number;
  totalCostUsd: number;
  durationMs: number;
  roundsUsed: number[];
}

export interface ArtifactPaths {
  spec?: string;
  plan?: string;
  ddl?: string;
  summary?: string;
}
