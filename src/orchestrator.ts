import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import type {
  RunConfig, RunState, Stage, Finding, GateAction,
  GateSummary, ArtifactPaths, WriterDispositionEntry,
} from "./types.js";
import type {
  ChallengerOutput, JudgeOutput, ProtocolPhase,
  OrchestratorToJudge, OrchestratorToWriter, OrchestratorToChallenger,
} from "./agents/types.js";
import { WriterAgent } from "./agents/writer.js";
import { ChallengerAgent } from "./agents/challenger.js";
import { JudgeAgent } from "./agents/judge.js";
import { VerifierAgent } from "./agents/verifier.js";
import { FindingChecklist } from "./agents/checklist.js";
import { validateMessage } from "./agents/schemas.js";
import { TerminalUI } from "./ui/terminal.js";
import { ContextManager, EvidenceIndex } from "./context.js";
import { StateManager } from "./state.js";
import { MetricsCollector } from "./metrics.js";
import { DDLGenerator } from "./ddl.js";
import { generateRunSummary, saveRunSummary } from "./summary.js";
import type { StageDetail } from "./summary.js";
import { generateRunId, DEFAULTS } from "./config.js";

export class Orchestrator {
  private writer!: WriterAgent;
  private challenger!: ChallengerAgent;
  private judge!: JudgeAgent;
  private verifier!: VerifierAgent;
  private state!: StateManager;
  private context!: ContextManager;
  private metrics!: MetricsCollector;
  private ddl!: DDLGenerator;
  private ui: TerminalUI;
  private evidenceIndex!: EvidenceIndex;
  private runState!: RunState;
  private artifactPaths: ArtifactPaths = {};
  private stageDetails: StageDetail[] = [];

  constructor(private config: RunConfig) {
    this.ui = new TerminalUI(config.quiet);
  }

  async run(): Promise<void> {
    const runId = generateRunId();
    await this.initialize(runId);

    this.ui.status(`\ndesign-challenger v0.1.0`);
    this.ui.status(`Topic: ${this.config.topic}`);
    this.ui.status(`Repo: ${this.config.repoPath}`);
    this.ui.status(`Models: Writer=${this.config.writerModel}, Challenger=${this.config.challengerModel}`);
    this.ui.status(`Budget: $${this.config.budget} | Max rounds: ${this.config.maxRounds}\n`);

    try {
      // Stage 1: Brainstorming
      if (!this.config.skipBrainstorm && !this.config.existingSpecPath) {
        await this.brainstorm();
      }

      // Stage 2: Spec Writing
      if (!this.config.existingSpecPath) {
        await this.writeSpec();
      } else {
        this.artifactPaths.spec = resolve(this.config.existingSpecPath);
      }

      // Stage 3: Plan Writing
      await this.writePlan();

      // Generate final artifacts
      await this.generateOutputArtifacts();

      this.runState.currentStage = "complete";
      await this.state.checkpoint(this.runState);
      this.ui.status("\nAll stages complete. Artifacts generated.");
    } catch (error) {
      this.runState.currentStage = "aborted";
      await this.state.checkpoint(this.runState);
      throw error;
    }
  }

  async resume(runId: string): Promise<void> {
    const mgr = await StateManager.findRun(runId, this.config.repoPath);
    if (!mgr) {
      throw new Error(`No run found with ID: ${runId}`);
    }
    this.state = mgr;
    const savedState = await this.state.loadState();
    if (!savedState) {
      throw new Error(`Failed to load state for run: ${runId}`);
    }
    this.runState = savedState;

    await this.initializeComponents(runId);

    this.ui.status(`Resuming run ${runId} from stage: ${this.runState.currentStage}`);

    // Resume from current stage
    switch (this.runState.currentStage) {
      case "brainstorming":
        await this.brainstorm();
        await this.writeSpec();
        await this.writePlan();
        break;
      case "spec_writing":
        await this.writeSpec();
        await this.writePlan();
        break;
      case "plan_writing":
        await this.writePlan();
        break;
      default:
        this.ui.status("Run already complete or aborted.");
        return;
    }

    await this.generateOutputArtifacts();
    this.runState.currentStage = "complete";
    await this.state.checkpoint(this.runState);
    this.ui.status("\nAll stages complete. Artifacts generated.");
  }

  // --- Initialization ---

  private async initialize(runId: string): Promise<void> {
    this.state = new StateManager(runId, this.config.repoPath);
    await this.state.initialize();

    await this.initializeComponents(runId);

    // Generate git log for Challenger
    await this.generateGitLog();

    // Initialize run state
    this.runState = {
      runId,
      topic: this.config.topic,
      config: this.config,
      currentStage: "brainstorming",
      currentRound: 0,
      gateOutcomes: [],
      tokenUsage: {
        writer: { input: 0, output: 0 },
        challenger: { input: 0, output: 0 },
        judge: { input: 0, output: 0 },
        verifier: { input: 0, output: 0 },
      },
      startedAt: new Date().toISOString(),
      lastCheckpoint: new Date().toISOString(),
    };

    await this.state.checkpoint(this.runState);
  }

  private async initializeComponents(runId: string): Promise<void> {
    this.context = new ContextManager();
    this.metrics = new MetricsCollector();
    this.ddl = new DDLGenerator();
    this.ddl.setTopic(this.config.topic);
    this.evidenceIndex = new EvidenceIndex();

    // Load prompts
    const writerPrompt = await this.loadPrompt("writer-system.md");
    const challengerPrompt = await this.loadPrompt("challenger-system.md");
    const judgePrompt = await this.loadPrompt("judge-system.md");

    // Create agents
    this.writer = new WriterAgent(this.config, this.ui, writerPrompt);
    this.challenger = new ChallengerAgent(this.config, this.ui, challengerPrompt);
    this.judge = new JudgeAgent(this.config, this.ui, judgePrompt);
    this.verifier = new VerifierAgent(this.config, this.ui);
  }

  private async loadPrompt(filename: string): Promise<string> {
    // Look for prompts relative to the package installation
    const paths = [
      join(import.meta.dirname ?? ".", "prompts", filename),
      join(process.cwd(), "src", "prompts", filename),
    ];
    for (const p of paths) {
      try {
        return await readFile(p, "utf-8");
      } catch { /* try next */ }
    }
    throw new Error(`Could not find prompt file: ${filename}`);
  }

  private async generateGitLog(): Promise<void> {
    try {
      const log = execSync("git log --oneline -100", {
        cwd: this.config.repoPath,
        encoding: "utf-8",
        timeout: 10_000,
      });
      const graph = execSync("git log --all --oneline --graph -50", {
        cwd: this.config.repoPath,
        encoding: "utf-8",
        timeout: 10_000,
      });
      const gitLogPath = join(this.state.getRunDir(), "git-log.txt");
      await writeFile(gitLogPath, `# Git Log (recent 100 commits)\n\n${log}\n\n# Git Graph\n\n${graph}`);
    } catch {
      // Not a git repo or git not available -- not fatal
    }
  }

  // --- Stage 1: Brainstorming ---

  private async brainstorm(): Promise<void> {
    this.runState.currentStage = "brainstorming";
    this.ui.status("\n--- STAGE 1: BRAINSTORMING ---\n");

    // Start Writer and Challenger in parallel
    const gitLogPath = join(this.state.getRunDir(), "git-log.txt");
    const explorationTemplate = await this.loadPrompt("challenger-exploration.md");
    const explorationPrompt = explorationTemplate
      .replace("{topic}", this.config.topic)
      .replace("{gitLogPath}", gitLogPath);

    const [writerResult, challengerResult] = await Promise.all([
      this.writer.send(`Brainstorm a design for: ${this.config.topic}\n\nExplore the codebase thoroughly. Answer your own clarifying questions using project context.`),
      this.challenger.send(explorationPrompt),
    ]);

    this.updateTokenUsage();
    this.runState.writerSessionId = this.writer.getSessionId();
    this.runState.challengerSessionId = this.challenger.getSessionId();

    // Run Judge on Challenger findings
    if (challengerResult.findings.length > 0) {
      const judgeInput: OrchestratorToJudge = {
        stage: "brainstorming",
        round: 0,
        challenger_findings: challengerResult.findings,
        writer_spec_path: "",
        instruction: "Evaluate each finding for actionability. Filter noise. Consolidate duplicates.",
      };
      const judgeResult = await this.judge.evaluate(judgeInput);

      this.recordJudgeMetrics(challengerResult.findings, judgeResult);

      // Feed filtered findings to Writer
      const forwardedFindings = this.getForwardedFindings(challengerResult.findings, judgeResult);
      if (forwardedFindings.length > 0) {
        this.ui.renderJudgeResult(judgeResult.forwarded_findings.length, judgeResult.filtered_findings.length);
        this.ui.renderFindings(forwardedFindings);

        const writerInstruction = this.buildWriterFindingsPrompt(forwardedFindings, challengerResult, 0);
        await this.writer.send(writerInstruction);
        this.updateTokenUsage();
      }
    }

    // Index Challenger evidence
    this.indexEvidence(challengerResult);

    await this.state.checkpoint(this.runState);

    // Gate 1
    const gateSummary = this.buildGateSummary("brainstorming", 0);
    const gateAction = await this.gate("brainstorming", gateSummary);
    if (gateAction === "abort") {
      this.runState.currentStage = "aborted";
      throw new Error("User aborted at brainstorming gate");
    }
    if (gateAction === "request_changes") {
      const direction = await this.ui.getUserDirection();
      await this.writer.send(`User feedback on brainstorming: ${direction}\n\nPlease address this feedback.`);
      this.updateTokenUsage();
    }

    this.stageDetails.push(this.buildStageDetail("brainstorming", gateAction));
  }

  // --- Stage 2: Spec Writing ---

  private async writeSpec(): Promise<void> {
    this.runState.currentStage = "spec_writing";
    this.ui.status("\n--- STAGE 2: SPEC WRITING ---\n");

    // Writer produces spec
    const writerResult = await this.writer.send(
      `Write the design spec for: ${this.config.topic}\n\n` +
      `Write it as a markdown file using the Write tool to ${this.config.outputDir}/specs/. ` +
      `Include an ## Assumptions section at the end, tagging each as internal or external. ` +
      `After writing the file, state the path: ARTIFACT_PATH: <path>`
    );
    this.updateTokenUsage();

    const specPath = this.extractArtifactPath(writerResult.result);
    this.artifactPaths.spec = specPath;

    // Pre-review assumption verification
    await this.verifyExternalAssumptions(specPath);

    // Review cycle
    const specReviewTemplate = await this.loadPrompt("challenger-spec-review.md");
    await this.reviewCycle("spec_writing", specPath, specReviewTemplate);

    await this.state.checkpoint(this.runState);

    // Gate 2
    const gateSummary = this.buildGateSummary("spec_writing", this.runState.currentRound);
    const gateAction = await this.gate("spec_writing", gateSummary);
    if (gateAction === "abort") {
      this.runState.currentStage = "aborted";
      throw new Error("User aborted at spec gate");
    }
    if (gateAction === "request_changes") {
      const direction = await this.ui.getUserDirection();
      await this.writer.send(`User feedback on spec: ${direction}\n\nPlease update the spec file.`);
      this.updateTokenUsage();
    }

    this.stageDetails.push(this.buildStageDetail("spec_writing", gateAction));

    // Auto-commit after gate approval
    this.autoCommit("spec", specPath);
  }

  // --- Stage 3: Plan Writing ---

  private async writePlan(): Promise<void> {
    this.runState.currentStage = "plan_writing";
    this.ui.status("\n--- STAGE 3: PLAN WRITING ---\n");

    const writerResult = await this.writer.send(
      `Write the implementation plan for: ${this.config.topic}\n\n` +
      `Write it as a markdown file using the Write tool to ${this.config.outputDir}/plans/. ` +
      `Include an ## Assumptions section at the end, tagging each as internal or external. ` +
      `After writing the file, state the path: ARTIFACT_PATH: <path>`
    );
    this.updateTokenUsage();

    const planPath = this.extractArtifactPath(writerResult.result);
    this.artifactPaths.plan = planPath;

    // Pre-review assumption verification
    await this.verifyExternalAssumptions(planPath);

    // Review cycle
    const planReviewTemplate = await this.loadPrompt("challenger-plan-review.md");
    await this.reviewCycle("plan_writing", planPath, planReviewTemplate, this.artifactPaths.spec);

    await this.state.checkpoint(this.runState);

    // Gate 3
    const gateSummary = this.buildGateSummary("plan_writing", this.runState.currentRound);
    const gateAction = await this.gate("plan_writing", gateSummary);
    if (gateAction === "abort") {
      this.runState.currentStage = "aborted";
      throw new Error("User aborted at plan gate");
    }
    if (gateAction === "request_changes") {
      const direction = await this.ui.getUserDirection();
      await this.writer.send(`User feedback on plan: ${direction}\n\nPlease update the plan file.`);
      this.updateTokenUsage();
    }

    this.stageDetails.push(this.buildStageDetail("plan_writing", gateAction));
    this.autoCommit("plan", planPath);
  }

  // --- Review Cycle (shared by Stages 2 and 3) ---

  private async reviewCycle(
    stage: Stage,
    artifactPath: string,
    challengerTemplate: string,
    specPath?: string,
  ): Promise<void> {
    const phases: ProtocolPhase[] = [
      "counter_design_hypothesis_tester",
      "skeptical_verifier",
      "pre_mortem",
    ];

    let addressedIds: number[] = [];
    let rejectedIds: number[] = [];
    let filteredIds: number[] = [];

    for (let round = 1; round <= this.config.maxRounds; round++) {
      this.runState.currentRound = round;
      const phase = phases[round - 1] ?? "pre_mortem";

      this.ui.phaseIndicator(stage, round, this.config.maxRounds, phase);
      this.metrics.recordRound(stage, round);

      // Build phase-specific instructions
      const phaseInstructions = this.getPhaseInstructions(phase);

      // Fill Challenger prompt template
      const challengerPrompt = challengerTemplate
        .replace("{round}", String(round))
        .replace("{maxRounds}", String(this.config.maxRounds))
        .replace("{protocolPhase}", phase)
        .replace("{artifactPath}", artifactPath)
        .replace("{specPath}", specPath ?? "N/A")
        .replace("{phaseInstructions}", phaseInstructions)
        .replace("{addressedIds}", addressedIds.join(", "))
        .replace("{rejectedIds}", rejectedIds.join(", "))
        .replace("{filteredIds}", filteredIds.join(", "));

      // Challenger review
      const challengerResult = await this.challenger.send(challengerPrompt);
      this.updateTokenUsage();

      // Snapshot artifact for diff metric
      let artifactBefore = "";
      try { artifactBefore = await readFile(artifactPath, "utf-8"); } catch { /* new file */ }

      // Record assumptions
      for (const a of challengerResult.assumptions) {
        this.metrics.recordAssumption(a.id, a.status as "verified" | "falsified");
      }

      // External evidence verification
      const externalFindings = challengerResult.findings.filter(f => f.evidence_type === "external");
      if (externalFindings.length > 0) {
        const verificationResults = await this.verifier.verifyEvidence(externalFindings);
        for (const [findingId, result] of verificationResults) {
          this.metrics.recordExternalEvidenceVerification(findingId, result.verified);
          const finding = challengerResult.findings.find(f => f.id === findingId);
          if (finding) {
            finding.evidence_verified = result.verified;
          }
        }
        // Remove findings with refuted evidence
        const validFindings = challengerResult.findings.filter(f => {
          if (f.evidence_type === "external" && f.evidence_verified === false) {
            this.ddl.addFilteredFinding(f, "Challenger error -- external evidence refuted by Verifier");
            return false;
          }
          return true;
        });
        challengerResult.findings = validFindings;
      }

      // Early termination if no findings
      if (challengerResult.findings.length === 0 || challengerResult.pass) {
        this.ui.status(`  Round ${round}: Challenger reports no remaining issues.`);
        break;
      }

      // Judge evaluation
      const judgeInput: OrchestratorToJudge = {
        stage,
        round,
        challenger_findings: challengerResult.findings,
        writer_spec_path: artifactPath,
        instruction: "Evaluate each finding for actionability. Filter noise. Consolidate duplicates.",
      };
      const judgeResult = await this.judge.evaluate(judgeInput);
      this.recordJudgeMetrics(challengerResult.findings, judgeResult);

      const forwardedFindings = this.getForwardedFindings(challengerResult.findings, judgeResult);
      this.ui.renderJudgeResult(judgeResult.forwarded_findings.length, judgeResult.filtered_findings.length);

      if (forwardedFindings.length === 0) {
        this.ui.status(`  Round ${round}: All findings filtered by Judge.`);
        break;
      }

      // Display counter-design on round 1
      if (round === 1 && challengerResult.counter_design) {
        this.ui.renderCounterDesign(challengerResult.counter_design);
      }
      this.ui.renderFindings(forwardedFindings);

      // Record counter-design findings
      for (const f of forwardedFindings) {
        if (f.counter_design_divergence) {
          this.metrics.recordCounterDesignFinding(f.id);
        }
        if (f.upstream_issue) {
          this.metrics.recordUpstreamIssue(f.id, f.upstream_source ?? "unknown");
        }
      }

      // Index evidence
      this.indexEvidence(challengerResult);

      // Check context thresholds
      this.checkContextBudgets();

      // --- Writer Response ---
      const checklist = new FindingChecklist();
      const forwardedIds = forwardedFindings.map(f => f.id);
      checklist.loadFindings(forwardedIds);

      const writerPrompt = this.buildWriterFindingsPrompt(forwardedFindings, challengerResult, round);
      const writerResponse = await this.writer.send(writerPrompt);
      this.updateTokenUsage();

      // Parse dispositions
      const dispositions = this.extractDispositions(writerResponse.result);
      for (const d of dispositions) {
        checklist.recordDisposition(d.finding_id, d.disposition, d.detail);
        this.metrics.recordFinding(d.finding_id, forwardedFindings.find(f => f.id === d.finding_id)?.severity ?? "MINOR", d.disposition);
        this.metrics.recordFindingDisposition(d.finding_id, d.disposition);

        // Capture decisions for DDL
        const finding = forwardedFindings.find(f => f.id === d.finding_id);
        if (finding) {
          this.ddl.addDecision({
            title: finding.summary,
            context: `${stage}, Round ${round}`,
            writerProposal: d.disposition === "addressed" ? d.detail : "Original design",
            challengerConcern: finding.recommendation,
            counterDesignAlternative: finding.counter_design_divergence ? challengerResult.counter_design?.summary : undefined,
            resolution: d.disposition === "addressed" ? `Addressed: ${d.detail}` : `Rejected: ${d.detail}`,
            evidence: finding.evidence,
            round: `${stage}, Round ${round}`,
            judgeAssessment: judgeResult.forwarded_findings.find(ff => ff.original_id === finding.id)?.rationale,
          });
        }
      }

      // Checklist enforcement (max 2 re-prompts)
      for (let attempt = 0; attempt < 2 && !checklist.isComplete(); attempt++) {
        this.metrics.recordChecklistRePrompt(stage, round, checklist.getMissingIds());
        this.ui.status(`  Checklist incomplete (attempt ${attempt + 1}/2). Re-prompting Writer for: ${checklist.getMissingIds().join(", ")}`);

        const rePromptResult = await this.writer.send(checklist.getRePrompt());
        this.updateTokenUsage();
        const extraDispositions = this.extractDispositions(rePromptResult.result);
        for (const d of extraDispositions) {
          checklist.recordDisposition(d.finding_id, d.disposition, d.detail);
          this.metrics.recordFindingDisposition(d.finding_id, d.disposition);
        }
      }

      // Upstream propagation -- verify both files modified
      for (const finding of forwardedFindings) {
        if (finding.upstream_issue && finding.upstream_source) {
          const disp = dispositions.find(d => d.finding_id === finding.id);
          if (disp?.disposition === "addressed") {
            this.ui.status(`  Upstream fix required: ${finding.upstream_source}`);
            // Verify the Writer modified the upstream file
            await this.writer.send(
              `Finding #${finding.id} is an upstream issue in ${finding.upstream_source}. ` +
              `Ensure you have also updated ${finding.upstream_source} (not just the current artifact). ` +
              `If you already did, confirm. If not, fix it now.`
            );
            this.updateTokenUsage();
          }
        }
      }

      // Compute spec diff
      try {
        const artifactAfter = await readFile(artifactPath, "utf-8");
        const diffLines = Math.abs(artifactAfter.split("\n").length - artifactBefore.split("\n").length);
        this.metrics.recordSpecDiff(diffLines);
      } catch { /* file may not exist yet */ }

      // Update IDs for next round
      addressedIds = dispositions.filter(d => d.disposition === "addressed").map(d => d.finding_id);
      rejectedIds = dispositions.filter(d => d.disposition === "rejected").map(d => d.finding_id);
      filteredIds = judgeResult.filtered_findings.map(f => f.original_id);

      await this.state.checkpoint(this.runState);
      await this.state.saveMessage(stage, round, { challengerResult, judgeResult, dispositions });
    }
  }

  // --- Assumption Verification ---

  private async verifyExternalAssumptions(artifactPath: string): Promise<void> {
    try {
      const content = await readFile(artifactPath, "utf-8");
      const assumptionSection = content.match(/## Assumptions\n([\s\S]*?)(?=\n## |$)/);
      if (!assumptionSection) return;

      const externalAssumptions: { text: string; source: string }[] = [];
      const lines = assumptionSection[1].split("\n");
      for (const line of lines) {
        const match = line.match(/\[external\]\s*(.*)/);
        if (match) {
          externalAssumptions.push({ text: match[1].trim(), source: "Writer artifact" });
        }
      }

      if (externalAssumptions.length === 0) return;

      this.ui.status(`  Verifying ${externalAssumptions.length} external assumptions...`);
      const results = await this.verifier.verifyAssumptions(externalAssumptions);

      const refuted = results.filter(r => !r.verified);
      if (refuted.length > 0) {
        this.ui.status(`  ${refuted.length} assumption(s) refuted. Writer will fix before review.`);
        for (const r of refuted) {
          this.metrics.recordPreReviewRefutation(r.claim);
        }

        const fixPrompt = `The following external assumptions were independently verified and found to be INCORRECT:\n\n` +
          refuted.map(r => `- "${r.claim}" -- ${r.evidence}`).join("\n") +
          `\n\nPlease update the artifact at ${artifactPath} to correct these assumptions before the Challenger reviews it.`;
        await this.writer.send(fixPrompt);
        this.updateTokenUsage();
      }
    } catch {
      // If we can't read the artifact, skip verification
    }
  }

  // --- Gate ---

  private async gate(stage: string, summary: GateSummary): Promise<GateAction> {
    const action = await this.ui.renderGate(stage, summary);
    this.runState.gateOutcomes.push({
      stage: stage as Stage,
      action,
      timestamp: new Date().toISOString(),
    });
    this.metrics.recordGateOutcome(stage as Stage, action);
    return action;
  }

  // --- Output Artifacts ---

  private async generateOutputArtifacts(): Promise<void> {
    const outputDir = this.config.outputDir;
    await mkdir(join(outputDir, "specs"), { recursive: true });

    // DDL
    const ddlPath = join(outputDir, "specs", `${new Date().toISOString().slice(0, 10)}-${slugify(this.config.topic)}-decisions.md`);
    await this.ddl.save(ddlPath);
    this.artifactPaths.ddl = ddlPath;

    // Run Summary
    const summaryPath = join(outputDir, "specs", `${new Date().toISOString().slice(0, 10)}-${slugify(this.config.topic)}-run-summary.md`);
    const summaryContent = generateRunSummary(
      this.config,
      this.runState,
      this.metrics.getSummary(),
      this.stageDetails,
      this.artifactPaths,
    );
    await saveRunSummary(summaryPath, summaryContent);
    this.artifactPaths.summary = summaryPath;

    // Save metrics
    await this.metrics.save(this.state.getRunDir());
    await this.evidenceIndex.save(this.state.getRunDir());

    this.ui.status(`\nArtifacts:`);
    if (this.artifactPaths.spec) this.ui.status(`  Spec: ${this.artifactPaths.spec}`);
    if (this.artifactPaths.plan) this.ui.status(`  Plan: ${this.artifactPaths.plan}`);
    this.ui.status(`  Decisions: ${ddlPath}`);
    this.ui.status(`  Summary: ${summaryPath}`);
  }

  // --- Helper Methods ---

  private getPhaseInstructions(phase: ProtocolPhase): string {
    switch (phase) {
      case "counter_design_hypothesis_tester":
        return "1. Sketch your counter-design (2-4 paragraphs)\n2. Steelman the Writer's design\n3. Extract testable assumptions\n4. Falsify each against the codebase and web research\nPrioritize assumptions where your counter-design diverges.";
      case "skeptical_verifier":
        return "The Writer claims to have fixed everything. Don't take their word for it.\n- Re-read the actual artifact (not the Writer's explanation)\n- Verify each claimed fix\n- Look for new issues introduced by fixes\n- Revisit counter-design divergence points";
      case "pre_mortem":
        return "It's 6 months from now. This implementation failed in production. What went wrong?\n- Generate 3-5 specific failure scenarios\n- Trace each through the design\n- Focus on integration failures and operational issues\n- Reference your counter-design alternatives";
      default:
        return "";
    }
  }

  private buildWriterFindingsPrompt(
    findings: Finding[],
    challengerOutput: ChallengerOutput,
    round: number,
  ): string {
    const findingsJson = JSON.stringify(findings, null, 2);
    const counterDesignSummary = challengerOutput.counter_design
      ? `\n\nChallenger's counter-design: ${challengerOutput.counter_design.summary}`
      : "";

    return `Challenger Round ${round} findings to address:\n\n${findingsJson}${counterDesignSummary}\n\n` +
      `Address EVERY finding. For each, either update the artifact OR reject with reasoning. ` +
      `Emit a JSON disposition block for every finding ID:\n` +
      `[{ "finding_id": N, "disposition": "addressed"|"rejected", "detail": "..." }]`;
  }

  private extractArtifactPath(writerOutput: string): string {
    // Primary: look for ARTIFACT_PATH pattern
    const pathMatch = writerOutput.match(/ARTIFACT_PATH:\s*(.+)/);
    if (pathMatch) {
      return pathMatch[1].trim();
    }

    // Fallback: look for Write tool file path patterns
    const writeMatch = writerOutput.match(/(?:Wrote|Created|wrote|created)\s+(?:file\s+)?(?:to\s+)?[`"]?([^\s`"]+\.md)[`"]?/);
    if (writeMatch) {
      return writeMatch[1];
    }

    // Last resort: construct a default path
    const slug = slugify(this.config.topic);
    const date = new Date().toISOString().slice(0, 10);
    return join(this.config.outputDir, "specs", `${date}-${slug}-design.md`);
  }

  private extractDispositions(writerOutput: string): WriterDispositionEntry[] {
    // Try to find JSON array in the output
    const jsonMatch = writerOutput.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return validateMessage<WriterDispositionEntry[]>("writer_dispositions", parsed);
      } catch { /* fall through */ }
    }

    // Try to find individual disposition objects
    const dispositions: WriterDispositionEntry[] = [];
    const objectMatches = writerOutput.matchAll(/\{[^}]*finding_id[^}]*\}/g);
    for (const match of objectMatches) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.finding_id && parsed.disposition) {
          dispositions.push(parsed as WriterDispositionEntry);
        }
      } catch { /* skip malformed */ }
    }
    return dispositions;
  }

  private getForwardedFindings(challengerFindings: Finding[], judgeResult: JudgeOutput): Finding[] {
    const forwardedIds = new Set(judgeResult.forwarded_findings.map(f => f.original_id));
    return challengerFindings
      .filter(f => forwardedIds.has(f.id))
      .map(f => {
        const judgeEntry = judgeResult.forwarded_findings.find(jf => jf.original_id === f.id);
        return { ...f, severity: judgeEntry?.adjusted_severity ?? f.severity };
      });
  }

  private recordJudgeMetrics(challengerFindings: Finding[], judgeResult: JudgeOutput): void {
    for (const ff of judgeResult.forwarded_findings) {
      this.metrics.recordJudgeDecision(ff.original_id, "forwarded");
      const finding = challengerFindings.find(f => f.id === ff.original_id);
      if (finding) this.metrics.recordFinding(ff.original_id, ff.adjusted_severity);
    }
    for (const ff of judgeResult.filtered_findings) {
      this.metrics.recordJudgeDecision(ff.original_id, "filtered");
      const finding = challengerFindings.find(f => f.id === ff.original_id);
      if (finding) this.ddl.addFilteredFinding(finding, ff.rationale);
    }
  }

  private indexEvidence(challengerResult: ChallengerOutput): void {
    for (const f of challengerResult.findings) {
      for (const e of f.evidence) {
        this.evidenceIndex.add(e, [`finding_${f.id}`]);
      }
    }
  }

  private updateTokenUsage(): void {
    const wu = this.writer.getTokenUsage();
    const cu = this.challenger.getTokenUsage();
    this.context.setUsage("writer", wu.input, wu.output);
    this.context.setUsage("challenger", cu.input, cu.output);
    this.metrics.recordCost("writer", this.config.writerModel, wu.input, wu.output);
    this.metrics.recordCost("challenger", this.config.challengerModel, cu.input, cu.output);
    this.runState.tokenUsage.writer = wu;
    this.runState.tokenUsage.challenger = cu;
  }

  private checkContextBudgets(): void {
    for (const agent of ["writer", "challenger"] as const) {
      const action = this.context.checkThreshold(agent);
      const usage = this.context.getUsage(agent);
      this.ui.contextBudget(agent, usage.current, DEFAULTS.contextThresholds.alert);

      if (action === "alert") {
        this.ui.status(`  WARNING: ${agent} context exceeded ${DEFAULTS.contextThresholds.alert} tokens!`);
      }
    }
  }

  private buildGateSummary(stage: string, round: number): GateSummary {
    const snap = this.metrics.getSnapshot();
    const summary = this.metrics.getSummary();
    return {
      stage: stage as Stage,
      round,
      findingsForwarded: snap.findingsForwarded,
      findingsFiltered: snap.findingsFiltered,
      findingsAddressed: snap.findingsAddressed,
      findingsRejected: snap.findingsRejected,
      assumptionsSurvived: snap.assumptionsVerified,
      assumptionsFalsified: snap.assumptionsFalsified,
      specDiffLines: summary.specDiffSize,
      artifactPath: (stage === "plan_writing" ? this.artifactPaths.plan : this.artifactPaths.spec) ?? "",
      unresolvedConcerns: [],
    };
  }

  private buildStageDetail(stage: string, gateOutcome: GateAction): StageDetail {
    const snap = this.metrics.getSnapshot();
    const summary = this.metrics.getSummary();
    return {
      stage,
      rounds: this.runState.currentRound,
      findingsTotal: snap.findingsTotal,
      findingsForwarded: snap.findingsForwarded,
      findingsFiltered: snap.findingsFiltered,
      findingsAddressed: snap.findingsAddressed,
      findingsRejected: snap.findingsRejected,
      assumptionsExtracted: snap.assumptionsTotal,
      assumptionsFalsified: snap.assumptionsFalsified,
      preReviewRefutations: summary.preReviewRefutationRate,
      upstreamIssues: summary.upstreamIssueRate > 0 ? 1 : 0,
      gateOutcome: gateOutcome,
    };
  }

  private autoCommit(stage: string, artifactPath: string): void {
    try {
      execSync(`git add "${artifactPath}"`, { cwd: this.config.repoPath, encoding: "utf-8" });
      execSync(`git commit -m "design-challenger: ${stage} approved for ${this.config.topic}"`, {
        cwd: this.config.repoPath,
        encoding: "utf-8",
      });
    } catch {
      // Not a git repo or nothing to commit
    }
  }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}
