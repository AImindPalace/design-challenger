import type { RunState, EvidenceEntry, Evidence } from "./types.js";
import type { ContextThresholds } from "./config.js";
import { DEFAULTS } from "./config.js";

export type ContextAction = "none" | "mask" | "summarize" | "alert";

export class ContextManager {
  private usage: Record<string, { input: number; output: number }> = {
    writer: { input: 0, output: 0 },
    challenger: { input: 0, output: 0 },
  };
  private thresholds: ContextThresholds;
  private postCompactionFlags = new Set<string>();

  constructor(thresholds?: ContextThresholds) {
    this.thresholds = thresholds ?? DEFAULTS.contextThresholds;
  }

  // Sets absolute totals (not deltas) -- the orchestrator passes cumulative agent totals
  setUsage(agent: "writer" | "challenger", input: number, output: number): void {
    this.usage[agent].input = input;
    this.usage[agent].output = output;
  }

  checkThreshold(agent: "writer" | "challenger"): ContextAction {
    const total = this.usage[agent].input + this.usage[agent].output;
    if (total >= this.thresholds.alert) return "alert";
    if (total >= this.thresholds.activeSummarization) return "summarize";
    if (total >= this.thresholds.observationMasking) return "mask";
    return "none";
  }

  getUsage(agent: "writer" | "challenger"): { current: number; threshold: string } {
    const total = this.usage[agent].input + this.usage[agent].output;
    const action = this.checkThreshold(agent);
    return { current: total, threshold: action };
  }

  markPostCompaction(sessionId: string): void {
    this.postCompactionFlags.add(sessionId);
  }

  needsPostCompactionInjection(sessionId: string): boolean {
    return this.postCompactionFlags.has(sessionId);
  }

  clearPostCompactionFlag(sessionId: string): void {
    this.postCompactionFlags.delete(sessionId);
  }

  buildMaskedPrompt(basePrompt: string, evidenceIndex: EvidenceIndex): string {
    const entries = evidenceIndex.getAll();
    const evidenceSummary = entries.map(e => `- [${e.id}] ${e.type}: ${e.location} -- ${e.summary}`).join("\n");
    return `Previous exploration results have been summarized. Key findings and evidence are preserved below. Do not re-read files you've already analyzed.\n\n## Evidence Index\n${evidenceSummary}\n\n---\n\n${basePrompt}`;
  }

  generateSummaryPrompt(state: RunState, evidenceIndex: EvidenceIndex): string {
    const entries = evidenceIndex.getAll();
    return `## Context Summary (Active Summarization)\n\nCurrent stage: ${state.currentStage}\nCurrent round: ${state.currentRound}\n\n### Evidence Index\n${entries.map(e => `- [${e.id}] ${e.location}: ${e.summary}`).join("\n")}\n\nPlease acknowledge this context summary before continuing. Reply with "Context acknowledged" and then proceed with the task.`;
  }
}

export class EvidenceIndex {
  private entries: EvidenceEntry[] = [];
  private nextId = 1;

  add(evidence: Evidence, citedBy: string[]): string {
    const id = `e${this.nextId++}`;
    this.entries.push({
      id,
      type: evidence.type,
      location: evidence.location,
      lines: evidence.lines,
      summary: evidence.summary,
      cited_by: citedBy,
    });
    return id;
  }

  getAll(): EvidenceEntry[] {
    return [...this.entries];
  }

  async save(runDir: string): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(runDir, { recursive: true });
    await writeFile(`${runDir}/evidence-index.json`, JSON.stringify({ evidence: this.entries }, null, 2));
  }

  async load(runDir: string): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    try {
      const data = JSON.parse(await readFile(`${runDir}/evidence-index.json`, "utf-8"));
      this.entries = data.evidence ?? [];
      this.nextId = this.entries.length + 1;
    } catch {
      // No existing index
    }
  }
}
