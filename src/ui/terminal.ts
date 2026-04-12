import chalk from "chalk";
import { createInterface } from "node:readline";
import type { Finding, Assumption, GateSummary, GateAction, Stage } from "../types.js";
import type { CounterDesign } from "../agents/types.js";

export class TerminalUI {
  constructor(private quiet: boolean = false) {}

  streamWriter(text: string): void {
    if (!this.quiet) process.stdout.write(chalk.cyan(text));
  }

  streamChallenger(text: string): void {
    if (!this.quiet) process.stdout.write(chalk.yellow(text));
  }

  streamJudge(text: string): void {
    if (!this.quiet) process.stdout.write(chalk.gray(text));
  }

  status(text: string): void {
    console.log(chalk.white.bold(text));
  }

  phaseIndicator(stage: string, round: number, maxRounds: number, phase: string): void {
    // Renders: [Spec Review · Round 2/3 · Skeptical Verifier]
    const label = stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const phaseLabel = phase.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    console.log(chalk.blue(`\n[${label} · Round ${round}/${maxRounds} · ${phaseLabel}]`));
  }

  contextBudget(agent: string, tokens: number, max: number): void {
    // Renders: [Challenger: 142K/500K tokens]
    const k = (n: number) => `${Math.round(n / 1000)}K`;
    const pct = tokens / max;
    const colorFn = pct > 0.8 ? chalk.red : pct > 0.5 ? chalk.yellow : chalk.green;
    if (!this.quiet) console.log(colorFn(`[${agent}: ${k(tokens)}/${k(max)} tokens]`));
  }

  renderFindings(findings: Finding[]): void {
    if (findings.length === 0) return;
    console.log(chalk.bold(`\n  Findings (${findings.length}):`));
    for (const f of findings) {
      const badge = f.severity === "CRITICAL" ? chalk.red.bold("CRITICAL")
        : f.severity === "IMPORTANT" ? chalk.yellow.bold("IMPORTANT")
        : chalk.gray("MINOR");
      console.log(`  ${badge} #${f.id}: ${f.summary}`);
      if (f.evidence.length > 0) {
        for (const e of f.evidence) {
          console.log(chalk.dim(`    ${e.type === "file" ? `${e.location}${e.lines ? `:${e.lines}` : ""}` : e.location} -- ${e.summary}`));
        }
      }
      console.log(chalk.dim(`    → ${f.recommendation}`));
    }
  }

  renderAssumptions(assumptions: Assumption[]): void {
    if (assumptions.length === 0) return;
    console.log(chalk.bold(`\n  Assumptions (${assumptions.length}):`));
    for (const a of assumptions) {
      const statusIcon = a.status === "verified" ? chalk.green("✓")
        : a.status === "falsified" ? chalk.red("✗")
        : chalk.gray("?");
      console.log(`  ${statusIcon} #${a.id}: ${a.text}`);
      console.log(chalk.dim(`    Source: ${a.source} | Evidence: ${a.evidence}`));
    }
  }

  renderJudgeResult(forwarded: number, filtered: number): void {
    console.log(chalk.gray(`  Judge: ${forwarded + filtered} findings → ${forwarded} forwarded, ${filtered} filtered`));
  }

  renderCounterDesign(counterDesign: CounterDesign): void {
    console.log(chalk.yellow.bold("\n  Counter-Design:"));
    console.log(chalk.yellow(`  ${counterDesign.summary}`));
    if (counterDesign.divergence_points.length > 0) {
      console.log(chalk.yellow.bold("  Divergence Points:"));
      for (const dp of counterDesign.divergence_points) {
        console.log(chalk.yellow(`    ${dp.id}. Writer: ${dp.writer_choice}`));
        console.log(chalk.yellow(`       Challenger: ${dp.challenger_alternative}`));
        console.log(chalk.dim(`       Reasoning: ${dp.reasoning}`));
      }
    }
    console.log(chalk.yellow.dim(`  Writer strengths: ${counterDesign.writer_strengths}`));
  }

  async renderGate(stage: string, summary: GateSummary): Promise<GateAction> {
    // Always show gates, even in quiet mode
    const label = stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    console.log(chalk.white.bold("\n" + "═".repeat(60)));
    console.log(chalk.white.bold(`  GATE: ${label}`));
    console.log(chalk.white.bold("═".repeat(60)));
    console.log(`  Artifact: ${summary.artifactPath}`);
    console.log(`  Round: ${summary.round}`);
    console.log(`  Findings: ${summary.findingsForwarded} forwarded, ${summary.findingsFiltered} filtered`);
    console.log(`  Addressed: ${summary.findingsAddressed} | Rejected: ${summary.findingsRejected}`);
    console.log(`  Assumptions: ${summary.assumptionsSurvived} survived, ${summary.assumptionsFalsified} falsified`);
    if (summary.specDiffLines > 0) {
      console.log(`  Spec diff: ${summary.specDiffLines} lines changed`);
    }
    if (summary.unresolvedConcerns.length > 0) {
      console.log(chalk.yellow("\n  Unresolved concerns:"));
      for (const concern of summary.unresolvedConcerns) {
        console.log(chalk.yellow(`    - ${concern}`));
      }
    }
    console.log(chalk.white.bold("\n  [a]pprove  [c]hange  [x]abort"));

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      const ask = () => {
        rl.question(chalk.white.bold("  > "), (answer) => {
          const a = answer.trim().toLowerCase();
          if (a === "a" || a === "approve") { rl.close(); resolve("approve"); }
          else if (a === "c" || a === "change") { rl.close(); resolve("request_changes"); }
          else if (a === "x" || a === "abort") { rl.close(); resolve("abort"); }
          else { console.log(chalk.red("  Invalid choice. Enter a, c, or x.")); ask(); }
        });
      };
      ask();
    });
  }

  // Get user direction when they request changes
  async getUserDirection(): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(chalk.white.bold("  Enter direction: "), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
}
