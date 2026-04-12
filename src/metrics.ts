import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Severity, FindingDisposition, Stage, GateAction, MetricsSummary } from "./types.js";
import { estimateCostUsd } from "./config.js";

export class MetricsCollector {
  private assumptions: Map<number, "verified" | "falsified"> = new Map();
  private findings: Map<number, { severity: Severity; disposition?: FindingDisposition }> = new Map();
  private judgeDecisions: Map<number, "forwarded" | "filtered"> = new Map();
  private counterDesignFindings = new Set<number>();
  private preReviewRefutations: string[] = [];
  private upstreamIssues: Map<number, string> = new Map();
  private externalEvidenceResults: Map<number, boolean> = new Map();
  private checklistRePrompts: { stage: Stage; round: number; missingIds: number[] }[] = [];
  private gateOutcomes: { stage: Stage; outcome: GateAction }[] = [];
  private costs: { agent: string; model: string; inputTokens: number; outputTokens: number }[] = [];
  private rounds: { stage: Stage; round: number }[] = [];
  private specDiffs: number[] = [];
  private startTime = Date.now();

  recordAssumption(id: number, status: "verified" | "falsified"): void {
    this.assumptions.set(id, status);
  }

  recordFinding(id: number, severity: Severity, disposition?: FindingDisposition): void {
    this.findings.set(id, { severity, disposition });
  }

  recordFindingDisposition(findingId: number, disposition: FindingDisposition): void {
    const existing = this.findings.get(findingId);
    if (existing) existing.disposition = disposition;
  }

  recordJudgeDecision(findingId: number, decision: "forwarded" | "filtered"): void {
    this.judgeDecisions.set(findingId, decision);
  }

  recordCounterDesignFinding(findingId: number): void {
    this.counterDesignFindings.add(findingId);
  }

  recordPreReviewRefutation(assumptionText: string): void {
    this.preReviewRefutations.push(assumptionText);
  }

  recordUpstreamIssue(findingId: number, upstreamSource: string): void {
    this.upstreamIssues.set(findingId, upstreamSource);
  }

  recordExternalEvidenceVerification(findingId: number, verified: boolean): void {
    this.externalEvidenceResults.set(findingId, verified);
  }

  recordChecklistRePrompt(stage: Stage, round: number, missingIds: number[]): void {
    this.checklistRePrompts.push({ stage, round, missingIds });
  }

  recordGateOutcome(stage: Stage, outcome: GateAction): void {
    this.gateOutcomes.push({ stage, outcome });
  }

  recordCost(agent: string, model: string, inputTokens: number, outputTokens: number): void {
    this.costs.push({ agent, model, inputTokens, outputTokens });
  }

  recordRound(stage: Stage, round: number): void {
    this.rounds.push({ stage, round });
  }

  recordSpecDiff(linesChanged: number): void {
    this.specDiffs.push(linesChanged);
  }

  // Computed metrics
  private rate(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
  }

  getAssumptionSurvivalRate(): number {
    const verified = [...this.assumptions.values()].filter(s => s === "verified").length;
    return this.rate(verified, this.assumptions.size);
  }

  getFindingResolutionRate(): number {
    const withDisposition = [...this.findings.values()].filter(f => f.disposition).length;
    return this.rate(withDisposition, this.findings.size);
  }

  getFindingRejectionRate(): number {
    const rejected = [...this.findings.values()].filter(f => f.disposition === "rejected").length;
    const total = [...this.findings.values()].filter(f => f.disposition).length;
    return this.rate(rejected, total);
  }

  getJudgeFilterRate(): number {
    const filtered = [...this.judgeDecisions.values()].filter(d => d === "filtered").length;
    return this.rate(filtered, this.judgeDecisions.size);
  }

  getCounterDesignImpact(): number {
    const forwarded = [...this.judgeDecisions.entries()].filter(([, d]) => d === "forwarded");
    const fromCD = forwarded.filter(([id]) => this.counterDesignFindings.has(id));
    return this.rate(fromCD.length, forwarded.length);
  }

  getPreReviewRefutationRate(): number {
    // We only have refutations, not total pre-review assumptions. Track externally.
    return this.preReviewRefutations.length;
  }

  getUpstreamIssueRate(): number {
    return this.rate(this.upstreamIssues.size, this.findings.size);
  }

  getExternalEvidenceVerificationRate(): number {
    const verified = [...this.externalEvidenceResults.values()].filter(v => v).length;
    return this.rate(verified, this.externalEvidenceResults.size);
  }

  getChecklistRePromptRate(): number {
    return this.rate(this.checklistRePrompts.length, this.rounds.length);
  }

  getSpecDiffSize(): number {
    return this.specDiffs.reduce((sum, n) => sum + n, 0);
  }

  getTotalCostUsd(): number {
    return this.costs.reduce((sum, c) => sum + estimateCostUsd(c.model, c.inputTokens, c.outputTokens), 0);
  }

  // Snapshot accessors for orchestrator's gate/stageDetail building
  getSnapshot() {
    return {
      findingsForwarded: [...this.judgeDecisions.values()].filter(d => d === "forwarded").length,
      findingsFiltered: [...this.judgeDecisions.values()].filter(d => d === "filtered").length,
      findingsAddressed: [...this.findings.values()].filter(f => f.disposition === "addressed").length,
      findingsRejected: [...this.findings.values()].filter(f => f.disposition === "rejected").length,
      findingsTotal: this.findings.size,
      assumptionsVerified: [...this.assumptions.values()].filter(s => s === "verified").length,
      assumptionsFalsified: [...this.assumptions.values()].filter(s => s === "falsified").length,
      assumptionsTotal: this.assumptions.size,
    };
  }

  getSummary(): MetricsSummary {
    return {
      assumptionSurvivalRate: this.getAssumptionSurvivalRate(),
      findingResolutionRate: this.getFindingResolutionRate(),
      findingRejectionRate: this.getFindingRejectionRate(),
      judgeFilterRate: this.getJudgeFilterRate(),
      counterDesignImpact: this.getCounterDesignImpact(),
      preReviewRefutationRate: this.getPreReviewRefutationRate(),
      upstreamIssueRate: this.getUpstreamIssueRate(),
      externalEvidenceVerificationRate: this.getExternalEvidenceVerificationRate(),
      checklistRePromptRate: this.getChecklistRePromptRate(),
      specDiffSize: this.getSpecDiffSize(),
      totalCostUsd: this.getTotalCostUsd(),
      durationMs: Date.now() - this.startTime,
      roundsUsed: [...new Set(this.rounds.map(r => r.stage))].map(stage =>
        this.rounds.filter(r => r.stage === stage).length
      ),
    };
  }

  async save(runDir: string): Promise<void> {
    await writeFile(join(runDir, "metrics.json"), JSON.stringify(this.getSummary(), null, 2));
  }
}
