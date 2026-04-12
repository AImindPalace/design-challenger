import type { FindingDisposition, WriterDispositionEntry } from "../types.js";

interface FindingStatus {
  disposition?: FindingDisposition;
  detail?: string;
}

export class FindingChecklist {
  private findings = new Map<number, FindingStatus>();

  loadFindings(forwardedIds: number[]): void {
    this.findings.clear();
    for (const id of forwardedIds) {
      this.findings.set(id, {});
    }
  }

  recordDisposition(findingId: number, disposition: FindingDisposition, detail: string): void {
    if (this.findings.has(findingId)) {
      this.findings.set(findingId, { disposition, detail });
    }
  }

  isComplete(): boolean {
    for (const status of this.findings.values()) {
      if (!status.disposition) return false;
    }
    return true;
  }

  getMissingIds(): number[] {
    const missing: number[] = [];
    for (const [id, status] of this.findings) {
      if (!status.disposition) missing.push(id);
    }
    return missing;
  }

  getRePrompt(): string {
    const missing = this.getMissingIds();
    return `You did not address findings [${missing.join(", ")}]. Provide a disposition for each: addressed (with what changed) or rejected (with reasoning). Emit a JSON array of dispositions.`;
  }

  getDispositions(): WriterDispositionEntry[] {
    const entries: WriterDispositionEntry[] = [];
    for (const [id, status] of this.findings) {
      if (status.disposition) {
        entries.push({
          finding_id: id,
          disposition: status.disposition,
          detail: status.detail ?? "",
        });
      }
    }
    return entries;
  }
}
