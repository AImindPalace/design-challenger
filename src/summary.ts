import { writeFile } from "node:fs/promises";
import type { RunConfig, RunState, MetricsSummary, ArtifactPaths } from "./types.js";

interface StageDetail {
  stage: string;
  rounds: number;
  findingsTotal: number;
  findingsForwarded: number;
  findingsFiltered: number;
  findingsAddressed: number;
  findingsRejected: number;
  assumptionsExtracted: number;
  assumptionsFalsified: number;
  preReviewRefutations: number;
  upstreamIssues: number;
  gateOutcome: string;
}

export function generateRunSummary(
  config: RunConfig,
  _state: RunState,
  metrics: MetricsSummary,
  stageDetails: StageDetail[],
  artifactPaths: ArtifactPaths,
): string {
  const lines: string[] = [];
  const duration = formatDuration(metrics.durationMs);

  lines.push(`# Run Summary -- ${config.topic}`);
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Duration: ${duration}`);
  lines.push(`Cost: $${metrics.totalCostUsd.toFixed(2)}`);
  lines.push(`Models: Writer=${config.writerModel}, Challenger=${config.challengerModel}, Judge=${config.judgeModel}`);
  lines.push("");

  for (const detail of stageDetails) {
    const label = detail.stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`## ${label}`);
    lines.push(`- Rounds: ${detail.rounds}`);
    lines.push(`- Findings: ${detail.findingsTotal} total, ${detail.findingsForwarded} forwarded, ${detail.findingsFiltered} filtered`);
    lines.push(`- Addressed: ${detail.findingsAddressed} | Rejected: ${detail.findingsRejected}`);
    if (detail.assumptionsExtracted > 0) {
      lines.push(`- Assumptions: ${detail.assumptionsExtracted} extracted, ${detail.assumptionsFalsified} falsified`);
    }
    if (detail.preReviewRefutations > 0) {
      lines.push(`- Pre-review refutations: ${detail.preReviewRefutations}`);
    }
    if (detail.upstreamIssues > 0) {
      lines.push(`- Upstream issues: ${detail.upstreamIssues}`);
    }
    lines.push(`- Gate: ${detail.gateOutcome}`);
    lines.push("");
  }

  lines.push(`## Quality Metrics`);
  lines.push(`- Assumption survival rate: ${pct(metrics.assumptionSurvivalRate)}`);
  lines.push(`- Finding resolution rate: ${pct(metrics.findingResolutionRate)}`);
  lines.push(`- Finding rejection rate: ${pct(metrics.findingRejectionRate)}`);
  lines.push(`- Judge filter rate: ${pct(metrics.judgeFilterRate)}`);
  lines.push(`- Counter-design impact: ${pct(metrics.counterDesignImpact)}`);
  lines.push(`- External evidence verification rate: ${pct(metrics.externalEvidenceVerificationRate)}`);
  lines.push(`- Checklist re-prompt rate: ${pct(metrics.checklistRePromptRate)}`);
  lines.push(`- Spec diff: ${metrics.specDiffSize} lines changed`);
  lines.push("");

  lines.push(`## Artifacts`);
  if (artifactPaths.spec) lines.push(`- Spec: ${artifactPaths.spec}`);
  if (artifactPaths.plan) lines.push(`- Plan: ${artifactPaths.plan}`);
  if (artifactPaths.ddl) lines.push(`- Decisions: ${artifactPaths.ddl}`);
  if (artifactPaths.summary) lines.push(`- Summary: ${artifactPaths.summary}`);
  lines.push("");

  return lines.join("\n");
}

export async function saveRunSummary(outputPath: string, content: string): Promise<void> {
  await writeFile(outputPath, content);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export type { StageDetail };
