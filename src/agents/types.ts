import type { Finding, Assumption, Evidence, Severity } from "../types.js";

export interface CounterDesign {
  summary: string;
  divergence_points: DivergencePoint[];
  writer_strengths: string;
}

export interface DivergencePoint {
  id: number;
  writer_choice: string;
  challenger_alternative: string;
  reasoning: string;
}

export type ProtocolPhase = "exploration" | "counter_design_hypothesis_tester" | "skeptical_verifier" | "pre_mortem";

export interface ChallengerOutput {
  round: number;
  protocol_phase: ProtocolPhase;
  counter_design?: CounterDesign;
  steelman?: string;
  assumptions: Assumption[];
  findings: Finding[];
  pass: boolean;
}

export interface OrchestratorToJudge {
  stage: string;
  round: number;
  challenger_findings: Finding[];
  writer_spec_path: string;
  instruction: string;
}

export interface ForwardedFinding {
  original_id: number;
  adjusted_severity: Severity;
  rationale: string;
}

export interface FilteredFinding {
  original_id: number;
  reason: string;
  rationale: string;
}

export interface JudgeOutput {
  forwarded_findings: ForwardedFinding[];
  filtered_findings: FilteredFinding[];
}

export interface OrchestratorToWriter {
  challenger_round: number;
  findings_to_address: FindingWithContext[];
  counter_design_summary?: string;
  instruction: string;
}

export interface FindingWithContext extends Finding {
  counter_design_context?: string;
}

export interface OrchestratorToChallenger {
  round: number;
  protocol_phase: ProtocolPhase;
  previous_findings_addressed: number[];
  previous_findings_rejected: number[];
  previous_findings_filtered_by_judge: number[];
  updated_artifact_path: string;
  instruction: string;
}

export interface AgentResponse {
  result: string;
  sessionId: string;
}
