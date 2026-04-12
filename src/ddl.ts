import { writeFile } from "node:fs/promises";
import type { Evidence, Finding } from "./types.js";

interface Decision {
  title: string;
  context: string;
  writerProposal: string;
  challengerConcern: string;
  counterDesignAlternative?: string;
  resolution: string;
  evidence: Evidence[];
  round: string;
  judgeAssessment?: string;
}

export class DDLGenerator {
  private decisions: Decision[] = [];
  private filteredFindings: { finding: Finding; judgeRationale: string }[] = [];
  private topic = "";

  setTopic(topic: string): void {
    this.topic = topic;
  }

  addDecision(decision: Decision): void {
    this.decisions.push(decision);
  }

  addFilteredFinding(finding: Finding, judgeRationale: string): void {
    this.filteredFindings.push({ finding, judgeRationale });
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# Design Decisions -- ${this.topic}\n`);

    for (let i = 0; i < this.decisions.length; i++) {
      const d = this.decisions[i];
      lines.push(`## Decision ${i + 1}: ${d.title}`);
      lines.push(`- **Context**: ${d.context}`);
      lines.push(`- **Writer proposed**: ${d.writerProposal}`);
      if (d.counterDesignAlternative) {
        lines.push(`- **Challenger counter-design**: ${d.counterDesignAlternative}`);
      }
      lines.push(`- **Challenger concern**: ${d.challengerConcern}`);
      lines.push(`- **Resolution**: ${d.resolution}`);
      if (d.evidence.length > 0) {
        lines.push(`- **Evidence**: ${d.evidence.map(e => `${e.location}${e.lines ? `:${e.lines}` : ""}`).join(", ")}`);
      }
      lines.push(`- **Round**: ${d.round}`);
      if (d.judgeAssessment) {
        lines.push(`- **Judge assessment**: ${d.judgeAssessment}`);
      }
      lines.push("");
    }

    if (this.filteredFindings.length > 0) {
      lines.push(`## Filtered (Judge removed -- not actionable)\n`);
      for (const { finding, judgeRationale } of this.filteredFindings) {
        lines.push(`- Finding ${finding.id}: ${finding.summary} -- ${judgeRationale}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  async save(outputPath: string): Promise<void> {
    await writeFile(outputPath, this.render());
  }
}
