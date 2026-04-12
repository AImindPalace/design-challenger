import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunConfig, ExternalClaim, VerificationResult, Finding } from "../types.js";
import { validateMessage, verificationResultSchema } from "./schemas.js";
import type { TerminalUI } from "../ui/terminal.js";

export class VerifierAgent {
  constructor(
    private config: RunConfig,
    private ui: TerminalUI,
  ) {}

  async verify(claim: ExternalClaim): Promise<VerificationResult> {
    const prompt = `Verify this claim: "${claim.text}"\nSource cited: ${claim.source}\nCheck the actual documentation, SDK types, or web resources. Is this claim accurate?`;

    const gen = query({
      prompt,
      options: {
        model: this.config.judgeModel, // Haiku -- lightweight, fast
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
        maxBudgetUsd: 0.50, // hard cap per verification
        outputFormat: {
          type: "json_schema" as const,
          schema: verificationResultSchema as Record<string, unknown>,
        },
      } as any,
    });

    let structuredOutput: unknown;
    let rawResult = "";
    for await (const msg of gen) {
      if (msg.type === "result" && msg.subtype === "success") {
        structuredOutput = (msg as any).structured_output;
        rawResult = (msg as any).result ?? "";
      }
    }

    if (structuredOutput) {
      return validateMessage<VerificationResult>("verification_result", structuredOutput);
    }
    const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Verifier output contained no JSON");
    return validateMessage<VerificationResult>("verification_result", JSON.parse(jsonMatch[0]));
  }

  async verifyAssumptions(assumptions: { text: string; source: string }[]): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const assumption of assumptions) {
      results.push(await this.verify(assumption));
    }
    return results;
  }

  async verifyEvidence(findings: Finding[]): Promise<Map<number, VerificationResult>> {
    const results = new Map<number, VerificationResult>();
    for (const finding of findings) {
      if (finding.evidence_type === "external") {
        for (const ev of finding.evidence) {
          if (ev.type === "url") {
            const result = await this.verify({ text: ev.summary, source: ev.location });
            results.set(finding.id, result);
            break; // one verification per finding
          }
        }
      }
    }
    return results;
  }
}
