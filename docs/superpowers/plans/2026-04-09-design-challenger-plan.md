# Design Challenger — Implementation Plan

**Design spec**: `docs/superpowers/specs/2026-04-09-design-challenger-design.md`
**Target**: Fully functional CLI tool with Writer + Challenger + Judge agent orchestration

---

## Prerequisites

Before starting implementation:

1. Verify `@anthropic-ai/claude-agent-sdk` is available on npm and confirm the `query()` API surface (options shape, session resume, streaming events, token usage reporting)
2. Verify `ANTHROPIC_API_KEY` env var is set in the dev environment
3. Have a target repo available for end-to-end testing (this repo itself works)
4. Verify model IDs resolve correctly: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (Haiku requires the date suffix)

---

## Step 1: Project Scaffolding

**Files**: `package.json`, `tsconfig.json`, `.gitignore`

### 1.1 Initialize the project

```bash
npm init -y
npm install typescript @types/node --save-dev
npm install @anthropic-ai/claude-agent-sdk commander chalk ajv
npx tsc --init
```

### 1.2 Configure `tsconfig.json`

- Target: `ES2022` (Node 18+)
- Module: `Node16` (ESM with `.js` extensions in imports)
- `outDir`: `dist/`
- `rootDir`: `src/`
- Strict mode enabled
- `resolveJsonModule: true` (for loading JSON schemas)

### 1.3 Configure `package.json`

- `"type": "module"` for ESM
- `"bin": { "design-challenger": "./dist/cli.js" }`
- Scripts: `build`, `dev` (ts-node or tsx), `lint`
- Engine: `"node": ">=18"`

### 1.4 Update `.gitignore`

Add: `dist/`, `node_modules/`, `.design-challenger/` (run state in target repos)

**Verification**: `npm run build` compiles with zero errors. `npx design-challenger --help` prints usage.

**Dependencies**: None — this is the foundation for everything else.

---

## Step 2: Shared Types and Inter-Agent Message Schemas

**Files**: `src/types.ts`, `src/agents/types.ts`, `src/agents/schemas.ts`

This step defines the data contracts that every other module depends on. Build it first so all downstream code has stable types to import.

### 2.1 `src/types.ts` — Shared project types

```typescript
// RunConfig — parsed CLI options
interface RunConfig {
  topic: string;
  repoPath: string;
  writerModel: string;
  challengerModel: string;
  maxRounds: number;
  budget: number;
  outputDir: string;
  quiet: boolean;
  skipBrainstorm: boolean;
  existingSpecPath?: string;
  resumeRunId?: string;
}

// RunState — checkpoint state
interface RunState {
  runId: string;
  topic: string;
  config: RunConfig;
  currentStage: Stage;
  currentRound: number;
  writerSessionId?: string;
  challengerSessionId?: string;
  // No judgeSessionId — Judge is ephemeral (new session per evaluation, no persistence)
  gateOutcomes: GateOutcome[];
  tokenUsage: TokenUsage;
  startedAt: string;
  lastCheckpoint: string;
}

type Stage = "brainstorming" | "spec_writing" | "plan_writing" | "complete" | "aborted";

interface GateOutcome {
  stage: Stage;
  action: "approve" | "request_changes" | "abort";
  userDirection?: string;
  timestamp: string;
}

interface TokenUsage {
  writer: { input: number; output: number };
  challenger: { input: number; output: number };
  judge: { input: number; output: number };
  verifier: { input: number; output: number };
}

// Severity and Finding types
type Severity = "CRITICAL" | "IMPORTANT" | "MINOR";

interface Evidence {
  type: "file" | "url" | "git_commit";
  location: string;  // file path, URL, or commit hash
  lines?: string;    // e.g., "42-58"
  summary: string;
}

interface Finding {
  id: number;
  summary: string;
  severity: Severity;
  assumption_id?: number;
  counter_design_divergence: boolean;
  upstream_issue: boolean;
  upstream_source?: string;      // file path of upstream doc if upstream_issue is true
  evidence: Evidence[];
  evidence_type: "codebase" | "external";
  evidence_verified?: boolean;   // set by Verifier agent for external evidence
  recommendation: string;
}

type FindingDisposition = "addressed" | "rejected";

interface WriterDispositionEntry {
  finding_id: number;
  disposition: FindingDisposition;
  detail: string;  // what changed (addressed) or why rejected (rejected)
}

interface Assumption {
  id: number;
  text: string;
  source: string;
  status: "verified" | "falsified" | "untested";
  evidence: string;
}
```

### 2.2 `src/agents/types.ts` — Inter-agent message types

Define TypeScript interfaces for every message type shown in the design spec's "Inter-Agent Message Format" section:

- `ChallengerOutput` — round, protocol_phase, counter_design, steelman, assumptions, findings, pass
- `OrchestratorToJudge` — stage, round, challenger_findings, writer_spec_path, instruction
- `JudgeOutput` — forwarded_findings, filtered_findings (no ddl_only — all actionable findings are forwarded regardless of severity)
- `OrchestratorToWriter` — challenger_round, findings_to_address, counter_design_summary, instruction
- `OrchestratorToChallenger` — round, protocol_phase, previous_findings_addressed/deferred/filtered, updated_artifact_path, instruction

### 2.3 `src/agents/schemas.ts` — JSON schemas for validation

Create JSON Schema objects (compatible with `ajv`) for each inter-agent message type. These are used by the Orchestrator to validate agent outputs before routing.

- Export a `validateMessage<T>(type: string, data: unknown): T` function that validates and returns typed data, or throws with a descriptive error including the schema definition (for retry prompts).
- Export individual schemas so they can be embedded in retry prompts to agents.

**Verification**: Unit tests that validate known-good and known-bad message payloads against each schema.

**Dependencies**: None — pure data definitions.

---

## Step 3: Configuration

**Files**: `src/config.ts`

### 3.1 Define defaults

```typescript
const DEFAULTS = {
  writerModel: "claude-opus-4-6",
  challengerModel: "claude-opus-4-6",
  judgeModel: "claude-haiku-4-5-20251001",  // Haiku requires date suffix
  maxRounds: 3,
  budget: 20,  // USD total across all agents
  writerBudgetShare: 0.40,      // 40% of total → $8 default
  challengerBudgetShare: 0.40,  // 40% of total → $8 default
  judgeBudgetShare: 0.10,       // 10% of total → $2 default
  verifierBudgetShare: 0.10,   // 10% of total → $2 default (many small Haiku calls)
  outputDir: "docs/superpowers",  // relative to target repo
  quiet: false,
  contextThresholds: {
    observationMasking: 150_000,
    activeSummarization: 250_000,
    alert: 500_000,
  },
  maxSchemaRetries: 2,
  exitCodes: {
    success: 0,
    aborted: 1,
    error: 2,
    budgetExceeded: 3,
  },
};
```

### 3.2 `loadConfig(cliArgs): RunConfig`

Merges CLI args over defaults. Resolves `repoPath` to absolute. Validates budget > 0, maxRounds >= 1. Generates `runId` (timestamp + short random suffix). Computes per-agent budgets from total budget × share percentages.

**Verification**: Call with various arg combos, assert correct merging and validation errors.

**Dependencies**: Step 2 (imports `RunConfig` type).

---

## Step 4: Terminal UI

**Files**: `src/ui/terminal.ts`, `src/ui/notifications.ts`

Build UI early so all subsequent steps can emit visible output during development.

### 4.1 `src/ui/terminal.ts`

- `streamWriter(text: string)` — prints in cyan
- `streamChallenger(text: string)` — prints in yellow
- `streamJudge(text: string)` — prints in dim/gray
- `status(text: string)` — prints in white/bold
- `phaseIndicator(stage: string, round: number, maxRounds: number, phase: string)` — renders `[Spec Review · Round 2/3 · Skeptical Verifier]`
- `contextBudget(agent: string, tokens: number, max: number)` — renders `[Challenger: 142K/500K tokens]`
- `renderFindings(findings: Finding[])` — prints findings with severity badges (colored)
- `renderAssumptions(assumptions: Assumption[])` — prints assumption list
- `renderJudgeResult(forwarded: number, filtered: number)` — e.g., `Judge: 5 findings → 4 forwarded, 1 filtered`
- `renderGate(stage: string, summary: GateSummary): Promise<GateAction>` — bordered gate with action prompts, reads user input (approve/changes/abort)
- `renderCounterDesign(counterDesign: CounterDesign)` — displays the Challenger's alternative approach

All functions check a `quiet` flag and skip streaming output when true (gates always show).

### 4.2 `src/ui/notifications.ts`

- `notifyGate(stage: string, summary: string)` — for now, just calls terminal rendering
- Exported as an interface so Telegram/Slack adapters can be added later without touching other code

**Verification**: Manual — run each render function with sample data, visually inspect output.

**Dependencies**: Step 2 (imports `Finding`, `Assumption`, `Severity` types).

---

## Step 5: Agent Wrappers

**Files**: `src/agents/writer.ts`, `src/agents/challenger.ts`, `src/agents/judge.ts`

These wrap the Claude Agent SDK and expose a clean interface to the Orchestrator.

### 5.1 SDK Session Model

**Critical**: `query()` is one-shot — it returns an `AsyncGenerator<SDKMessage>` and terminates. There is no `.continue()` method. Multi-turn conversations use repeated `query()` calls with `resume: sessionId`.

```typescript
// Turn 1: start a new session
const gen1 = query({ prompt: "Brainstorm...", options: { ... } });
let sessionId: string;
for await (const msg of gen1) {
  if (msg.type === "result") sessionId = msg.session_id;
}

// Turn 2: continue the same session
const gen2 = query({ prompt: "Now write the spec", options: { resume: sessionId, ... } });
for await (const msg of gen2) { ... }
```

Both Writer and Challenger agent wrappers follow this pattern: capture `session_id` from the `result` message on the first call, then pass it as `resume:` on all subsequent calls.

### 5.2 `src/agents/writer.ts`

```typescript
class WriterAgent {
  private sessionId?: string;
  private tokenUsage = { input: 0, output: 0 };

  constructor(
    private config: RunConfig,
    private ui: TerminalUI,
    private hooks?: HookConfig
  ) {}

  // First call — starts a new session, captures sessionId
  async send(prompt: string): Promise<AgentResponse> {
    const options: QueryOptions = {
      cwd: this.config.repoPath,
      model: this.config.writerModel,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep",
                     "WebSearch", "WebFetch", "Agent"],
      maxBudgetUsd: this.config.writerBudget,
      systemPrompt: this.systemPrompt,
      settingSources: ["project"],
      ...(this.sessionId && { resume: this.sessionId }),
      ...(this.hooks && { hooks: this.hooks }),
    };

    const gen = query({ prompt, options });
    return this.consumeStream(gen);
  }

  // Get session ID for checkpointing
  getSessionId(): string | undefined { return this.sessionId; }
  getTokenUsage(): { input: number; output: number } { return this.tokenUsage; }

  private async consumeStream(gen: AsyncGenerator<SDKMessage>): Promise<AgentResponse> {
    let result: string = "";
    for await (const msg of gen) {
      if (msg.type === "assistant" && !this.config.quiet) {
        this.ui.streamWriter(msg.content);
      }
      if (msg.type === "result") {
        this.sessionId = msg.session_id;
        result = msg.result;
        // Accumulate token usage from msg.usage
        this.tokenUsage.input += msg.usage.input_tokens;
        this.tokenUsage.output += msg.usage.output_tokens;
      }
    }
    return { result, sessionId: this.sessionId! };
  }
}
```

Key points:
- `allowDangerouslySkipPermissions: true` is **required** alongside `bypassPermissions` — without it the SDK rejects the call
- `allowedTools` here is an auto-approval list, not a restriction — under `bypassPermissions` all tools are already approved, so this is documentation-in-code of the Writer's expected tool surface
- `resume: sessionId` is set on all calls after the first, maintaining the persistent session
- Hooks (for PreCompact/PostCompact) are passed via `options.hooks` at call time

### 5.3 `src/agents/challenger.ts`

```typescript
class ChallengerAgent {
  private sessionId?: string;
  private tokenUsage = { input: 0, output: 0 };

  constructor(
    private config: RunConfig,
    private ui: TerminalUI,
    private hooks?: HookConfig
  ) {}

  async send(prompt: string): Promise<ChallengerOutput> {
    const options: QueryOptions = {
      cwd: this.config.repoPath,
      model: this.config.challengerModel,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Read-only enforcement: disallowedTools blocks write access even under bypassPermissions
      disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
      maxBudgetUsd: this.config.challengerBudget,
      systemPrompt: this.systemPrompt,
      settingSources: ["project"],
      // Use SDK's native structured output for reliable JSON
      outputFormat: {
        type: "json_schema",
        schema: challengerOutputSchema,  // from schemas.ts
      },
      ...(this.sessionId && { resume: this.sessionId }),
      ...(this.hooks && { hooks: this.hooks }),
    };

    const gen = query({ prompt, options });
    return this.consumeAndParse(gen);
  }

  private async consumeAndParse(gen: AsyncGenerator<SDKMessage>): Promise<ChallengerOutput> {
    let structuredOutput: unknown;
    for await (const msg of gen) {
      if (msg.type === "assistant" && !this.config.quiet) {
        this.ui.streamChallenger(msg.content);
      }
      if (msg.type === "result" && msg.subtype === "success") {
        this.sessionId = msg.session_id;
        structuredOutput = msg.structured_output;
        this.tokenUsage.input += msg.usage.input_tokens;
        this.tokenUsage.output += msg.usage.output_tokens;
      }
    }
    // Validate with ajv as a safety net (SDK enforces schema but validate anyway)
    return validateMessage<ChallengerOutput>("challenger_output", structuredOutput);
  }
}
```

Key differences from Writer:
- `disallowedTools` enforces read-only (not `allowedTools` — that's auto-approval only)
- `outputFormat` with `json_schema` uses the SDK's native structured output, returning parsed JSON in `result.structured_output` — eliminates ad-hoc JSON extraction from free text
- Still validates with `ajv` as a defense-in-depth check

### 5.4 `src/agents/judge.ts`

```typescript
class JudgeAgent {
  constructor(private config: RunConfig, private ui: TerminalUI) {}

  // Ephemeral — new session per call, no persistence, no sessionId stored
  async evaluate(input: OrchestratorToJudge): Promise<JudgeOutput> {
    const gen = query({
      prompt: JSON.stringify(input),
      options: {
        model: this.config.judgeModel,  // claude-haiku-4-5-20251001
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: this.systemPrompt,
        maxBudgetUsd: this.config.judgeBudget,
        outputFormat: {
          type: "json_schema",
          schema: judgeOutputSchema,
        },
      },
    });

    for await (const msg of gen) {
      if (msg.type === "assistant" && !this.config.quiet) {
        this.ui.streamJudge(msg.content);
      }
      if (msg.type === "result" && msg.subtype === "success") {
        this.config.addJudgeCost(msg.usage);
        return validateMessage<JudgeOutput>("judge_output", msg.structured_output);
      }
    }
    throw new Error("Judge session ended without result");
  }
}
```

- No `cwd`, no file tools — pure text-in, structured-JSON-out
- Uses `outputFormat` for reliable structured output (same as Challenger)
- No `sessionId` stored — ephemeral by design

### 5.5 Response parsing with `outputFormat` (primary) and fallback

The Challenger and Judge use `outputFormat: { type: "json_schema", schema }` to get structured output via `result.structured_output`. This eliminates the fragile pattern of extracting JSON from free text.

**Fallback**: If `structured_output` is undefined (SDK bug or version mismatch):
1. Fall back to extracting JSON from `result.result` text
2. Validate with `ajv` against the schema
3. On failure: issue a new `query()` call with `resume:` including the schema in the prompt (max 2 retries)
4. On second failure: throw with raw output for error reporting

The Writer does NOT use `outputFormat` — its primary output is markdown files written via the Write tool, not structured JSON. The Orchestrator extracts the Writer's artifact path by watching for Write tool calls in the message stream (see Step 12).

### 5.6 `src/agents/verifier.ts`

```typescript
class VerifierAgent {
  constructor(private config: RunConfig, private ui: TerminalUI) {}

  // Verify a single external claim (assumption or evidence citation)
  async verify(claim: ExternalClaim): Promise<VerificationResult> {
    const gen = query({
      prompt: `Verify this claim: "${claim.text}"\nSource cited: ${claim.source}\nCheck the actual documentation, SDK types, or web resources. Is this claim accurate?`,
      options: {
        model: this.config.judgeModel,  // Haiku — lightweight, fast
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ["WebSearch", "WebFetch", "Read", "Glob", "Grep"],
        disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
        maxBudgetUsd: 0.50,  // hard cap per verification
        outputFormat: {
          type: "json_schema",
          schema: verificationResultSchema,
        },
      },
    });

    for await (const msg of gen) {
      if (msg.type === "result" && msg.subtype === "success") {
        return validateMessage<VerificationResult>("verification_result", msg.structured_output);
      }
    }
    throw new Error("Verifier session ended without result");
  }

  // Batch-verify all external assumptions from a Writer artifact
  async verifyAssumptions(assumptions: ExternalAssumption[]): Promise<VerificationResult[]>

  // Verify external evidence cited by the Challenger
  async verifyEvidence(findings: Finding[]): Promise<Map<number, VerificationResult>>
}

interface ExternalClaim {
  text: string;
  source: string;  // URL, package name, doc reference
}

interface VerificationResult {
  claim: string;
  verified: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string;  // what was found
  source_checked: string;  // where it was checked
}
```

- Ephemeral — new session per claim, no persistence
- Read-only tools + web access for checking external docs
- Hard budget cap per verification ($0.50) prevents runaway checks
- Results feed back to the Orchestrator, which either fixes (pre-review assumptions) or annotates findings (Challenger evidence)

### 5.7 `src/agents/checklist.ts`

```typescript
class FindingChecklist {
  private findings: Map<number, FindingStatus>;

  // Initialize with forwarded finding IDs from Judge output
  loadFindings(forwardedIds: number[]): void

  // Record Writer's disposition for a finding
  recordDisposition(findingId: number, disposition: FindingDisposition, detail: string): void

  // Check if all findings have dispositions
  isComplete(): boolean

  // Get IDs of findings missing dispositions
  getMissingIds(): number[]

  // Get re-prompt message for the Writer
  getRePrompt(): string  // "You did not address findings [3, 7, 12]. Provide a disposition for each."

  // Get all dispositions for metrics and DDL
  getDispositions(): WriterDispositionEntry[]
}
```

This is pure Orchestrator logic — no LLM calls. It mechanically tracks whether every finding ID has a corresponding Writer disposition. The Orchestrator calls `isComplete()` after each Writer response; if false, it re-prompts the Writer with `getRePrompt()` before advancing the round.

**Verification**: 
- Mock SDK responses, verify session ID capture from result message and resume on subsequent calls
- Test `outputFormat` → `structured_output` path with valid payloads
- Test fallback path with missing `structured_output`
- Test retry logic with malformed responses
- Verify ChallengerAgent passes `disallowedTools` and Writer does not
- Test VerifierAgent with mock external claims, verify structured output parsing
- Test FindingChecklist: loadFindings → partial dispositions → isComplete returns false → getMissingIds correct → recordDisposition → isComplete returns true

**Dependencies**: Step 2 (types/schemas), Step 3 (config), Step 4 (UI for streaming).

---

## Step 6: System Prompts

**Files**: `src/prompts/writer-system.md`, `src/prompts/challenger-system.md`, `src/prompts/judge-system.md`, `src/prompts/challenger-exploration.md`, `src/prompts/challenger-spec-review.md`, `src/prompts/challenger-plan-review.md`

### 6.1 `writer-system.md`

Embed the Writer's full methodology directly in the system prompt (design spec line 111-117):

- **Brainstorming section**: Explore context (CLAUDE.md, codebase, git history, web), generate clarifying questions, self-answer them using project context, propose approaches with trade-offs
- **Spec-writing section**: Architecture, components, data flow, error handling, integration points, assumptions
- **Plan-writing section**: Ordered steps, dependencies between steps, verification criteria per step, file paths
- **Self-sufficiency instruction**: "You have full access to the codebase. When you have a clarifying question, answer it yourself by reading files, checking git history, or searching the web. Do not wait for human input."
- **Output format instruction**: "When you produce a spec or plan, write it as a markdown file using the Write tool. When you produce structured output for the orchestrator, emit valid JSON."
- **Assumption listing instruction**: "At the end of every spec or plan, include an `## Assumptions` section. For each assumption, mark it as `internal` (derivable from the codebase) or `external` (depends on libraries, APIs, platforms, or services you haven't verified). External assumptions will be verified before review begins."
- **Disposition instruction**: "When addressing Challenger findings, respond with a JSON block listing your disposition for EVERY finding ID: `{ finding_id, disposition: 'addressed'|'rejected', detail: '...' }`. Missing dispositions will be flagged."
- **Artifact path instruction**: "After writing a spec or plan file, state the file path on its own line: `ARTIFACT_PATH: <path>`"

### 6.2 `challenger-system.md`

Embed the full escalating review protocol with dialectical inquiry (design spec lines 217-294):

- **Identity**: "You are an adversarial design reviewer. You explore and analyze. You do not modify any files."
- **Phase 1 (Explore)**: Read CLAUDE.md, grep implementations, read git history from Orchestrator-provided `git-log.txt` (Challenger has no Bash — `.git` objects are binary and not greppable), web research
- **Phase 2 (Escalating Review)**:
  - Round 1: Counter-design sketch → steelman → extract assumptions → falsify
  - Round 2: Skeptical verification — re-read artifact, verify fixes, find new issues
  - Round 3: Pre-mortem — imagine failure in 6 months, trace through design
- **Findings format**: Exact structure from design spec (FINDING, SEVERITY, ASSUMPTION, COUNTER_DESIGN_DIVERGENCE, EVIDENCE, RECOMMENDATION)
- **Output format**: "Emit your findings as a JSON object matching this schema: {schema}"
- **Evidence requirement**: "Every finding MUST cite specific evidence — file paths with line numbers, URLs, or git commits. Findings without evidence will be filtered."
- **Upstream issue detection**: "If a finding is caused by a bug in an upstream document (e.g., the design spec contains a wrong API reference that the plan faithfully implements), set `upstream_issue: true` and `upstream_source` to the upstream file path. The Writer will fix both documents."
- **Evidence type tagging**: "For each finding, set `evidence_type` to `codebase` if the primary evidence comes from the repo, or `external` if it comes from SDK docs, web resources, or API references. External evidence will be independently verified."

### 6.3 `judge-system.md`

Embed the actionability filter criteria (design spec lines 321-327):

- **Identity**: "You evaluate Challenger findings for actionability. You are a noise filter, not a reviewer."
- **Criteria**: Actionable? Won't-change-the-decision? Duplicate? Proportionate?
- **Output format**: JSON with forwarded_findings (all severities), filtered_findings (non-actionable/duplicate only)
- **Instruction**: "Be aggressive about filtering. A finding that won't change an architectural decision is noise regardless of severity."

### 6.4 Round-specific prompt templates

- `challenger-exploration.md` — Stage 1 prompt: "Explore this codebase for context relevant to: {topic}"
- `challenger-spec-review.md` — Template with placeholders for round number, protocol phase, previous findings status, artifact path
- `challenger-plan-review.md` — Same structure, adapted for plan review context

Each template uses `{placeholder}` syntax that the ChallengerAgent fills at runtime. **These are NOT system prompt modifications** — they are passed as the `prompt` argument to `challenger.send()`, which means they arrive as user messages in the resumed session. The Challenger's system prompt (`challenger-system.md`) is static and set once at session creation. Phase-specific instructions (which round, what to focus on, what was addressed) are delivered per-turn via these templates.

**Verification**: Read each prompt, verify it covers all behaviors specified in the design spec. No automated test — these are evaluated by running the full system.

**Dependencies**: None — these are static markdown files. But they should be written after Step 2 (schemas) so the JSON output format instructions reference the actual schema shapes.

---

## Step 7: Context Management

**Files**: `src/context.ts`

### 7.1 Token budget tracker

```typescript
class ContextManager {
  private thresholds: ContextThresholds;
  
  // Called after every agent interaction
  updateUsage(agent: "writer" | "challenger", input: number, output: number): void
  
  // Returns the intervention needed (if any) for the given agent
  checkThreshold(agent: "writer" | "challenger"): "none" | "mask" | "summarize" | "alert"
  
  // Get current usage for display
  getUsage(agent: "writer" | "challenger"): { current: number; threshold: string }
}
```

### 7.2 Observation masking (150K threshold)

**Mechanism**: The SDK does not support modifying in-flight session message history. Observation masking is implemented via the Orchestrator's inter-turn prompts:

1. When an agent crosses 150K tokens, the Orchestrator sets a `maskMode` flag
2. On the next `send()` call, the prompt includes a preamble: "Previous exploration results have been summarized. Key findings and evidence are preserved below. Do not re-read files you've already analyzed."
3. The Orchestrator appends a condensed context block: active findings, assumption statuses, and evidence index entries — all from the side-channel `evidence-index.json`
4. This leverages the SDK's natural context management (auto-compaction) but supplements it with structured re-injection

- `buildMaskedPrompt(basePrompt: string, runState: RunState, evidenceIndex: EvidenceIndex): string`
- Preserves: findings, assumptions, evidence references, counter-design content
- Discards: raw file contents, grep results, web search results (the agent has already processed these)

### 7.3 Active summarization (250K threshold)

- `generateSummaryPrompt(runState: RunState): string` — creates a structured context summary that the Orchestrator injects as a message, asking the agent to acknowledge before continuing
- Includes: active findings list, assumption tracker, evidence index, counter-design divergence points

### 7.4 Alert (500K threshold)

- `shouldAlert(agent: "writer" | "challenger"): boolean`
- The Orchestrator handles the actual pause/notify logic — ContextManager just signals

### 7.5 Evidence index

```typescript
class EvidenceIndex {
  add(evidence: Evidence, citedBy: string[]): void
  getAll(): EvidenceEntry[]
  save(runDir: string): Promise<void>
  load(runDir: string): Promise<void>
}
```

Maintains `evidence-index.json` in the run directory. Updated whenever the Orchestrator processes Challenger findings.

### 7.6 PreCompact / PostCompact hooks

Hooks are passed via `options.hooks` in the `query()` call (see Step 5). The ContextManager exports hook factory functions:

```typescript
function createCompactionHooks(stateManager: StateManager, contextManager: ContextManager): HookConfig {
  return {
    PreCompact: [{
      hooks: [async (input) => {
        // Archive full transcript before SDK compaction
        const messages = await getSessionMessages(input.session_id);
        await stateManager.archiveTranscript(input.session_id, messages);
      }]
    }],
    PostCompact: [{
      hooks: [async (input) => {
        // Re-inject critical structured context after compaction
        // The PostCompact hook's compact_summary contains the SDK's summary.
        // We supplement it by prepending structured context to the next prompt
        // (handled in the Orchestrator's send() wrapper, not here — hooks
        // cannot inject messages, only observe).
        contextManager.markPostCompaction(input.session_id);
      }]
    }]
  };
}
```

**Important**: SDK hooks cannot inject messages into the conversation. `PreCompact` uses `getSessionMessages()` to capture the full transcript before the SDK summarizes it. `PostCompact` sets a flag so the Orchestrator's next `send()` call includes structured context re-injection (findings, assumptions, evidence index, counter-design divergences) as a preamble in the prompt.

**Verification**: Unit tests for threshold detection, observation masking prompt building, evidence index CRUD, hook factory output shape.

**Dependencies**: Step 2 (types), Step 3 (config for thresholds), Step 8 (StateManager for transcript archiving).

---

## Step 8: State Management

**Files**: `src/state.ts`

### 8.1 Checkpointing

```typescript
class StateManager {
  private runDir: string;  // .design-challenger/runs/<run-id>/
  
  constructor(runId: string, repoPath: string)
  
  // Save state after every significant event
  async checkpoint(state: RunState): Promise<void>
  
  // Save inter-agent messages for DDL generation
  async saveMessage(stage: Stage, round: number, message: any): Promise<void>
  
  // Save artifact snapshots at each checkpoint
  async saveArtifact(name: string, content: string): Promise<void>
  
  // Archive full transcript before compaction
  async archiveTranscript(agent: string, transcript: string): Promise<void>
  
  // Load state for resume
  async loadState(runId: string, repoPath: string): Promise<RunState | null>
  
  // List all messages for DDL generation
  async getMessages(stage?: Stage): Promise<SavedMessage[]>
}
```

### 8.2 Directory structure

Creates `.design-challenger/runs/<run-id>/` in the target repo with subdirectories: `messages/`, `artifacts/`, `transcripts/`.

### 8.3 Resume logic

- `loadState()` reads `state.json` and returns the RunState
- The Orchestrator uses the stored `writerSessionId` / `challengerSessionId` to attempt SDK resume
- If SDK resume fails, the Orchestrator falls back to semantic resume (Step 10 handles this)

**Verification**: Unit tests — checkpoint → load roundtrip, verify file structure creation, verify message persistence.

**Dependencies**: Step 2 (types), Step 3 (config).

---

## Step 9: Metrics Collection

**Files**: `src/metrics.ts`

### 9.1 Metrics collector

```typescript
class MetricsCollector {
  // Called by Orchestrator as events occur
  recordAssumption(id: number, status: "verified" | "falsified"): void
  recordFinding(id: number, severity: Severity, disposition: FindingDisposition): void
  recordFindingRejection(findingId: number, reasoning: string): void
  recordJudgeDecision(findingId: number, decision: "forwarded" | "filtered"): void
  recordCounterDesignFinding(findingId: number): void
  recordPreReviewRefutation(assumptionText: string): void
  recordUpstreamIssue(findingId: number, upstreamSource: string): void
  recordExternalEvidenceVerification(findingId: number, verified: boolean): void
  recordChecklistRePrompt(stage: Stage, round: number, missingIds: number[]): void
  recordGateOutcome(stage: Stage, outcome: GateAction): void
  recordCost(agent: string, inputTokens: number, outputTokens: number): void
  recordRound(stage: Stage, round: number): void
  recordSpecDiff(stage: Stage, round: number, beforeContent: string, afterContent: string): void
  
  // Computed metrics
  getAssumptionSurvivalRate(): number          // % verified
  getFindingResolutionRate(): number           // % all findings with disposition (should be 100%)
  getFindingRejectionRate(): number            // % rejected vs. addressed
  getJudgeFilterRate(): number                 // % filtered (non-actionable or duplicate)
  getCounterDesignImpact(): number             // % forwarded from counter-design
  getPreReviewRefutationRate(): number         // % external assumptions refuted before review
  getUpstreamIssueRate(): number               // % findings flagged as upstream issues
  getExternalEvidenceVerificationRate(): number // % external claims verified vs. refuted
  getChecklistRePromptRate(): number           // % rounds requiring disposition re-prompt
  getSpecDiffSize(): number                    // total lines changed across all rounds
  
  // Output
  getSummary(): MetricsSummary
  save(runDir: string): Promise<void>
}
```

### 9.2 Cost calculation

Estimate USD from token counts using published pricing. Accept model name to look up per-token rates. Store rates as a config constant (easy to update when pricing changes).

**Verification**: Unit tests with known inputs, verify computed rates match expected values.

**Dependencies**: Step 2 (types).

---

## Step 10: Design Decision Log Generator

**Files**: `src/ddl.ts`

### 10.1 DDL generator

```typescript
class DDLGenerator {
  // Add a decision from the debate
  addDecision(decision: Decision): void
  
  // Add a filtered finding (Judge removed — captured for the record)
  addFilteredFinding(finding: Finding, judgeRationale: string): void
  
  // Render to markdown
  render(): string
  
  // Save to file
  save(outputPath: string): Promise<void>
}

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
```

The Orchestrator calls `addDecision()` whenever:
- A Challenger finding causes the Writer to change the design
- The Writer explicitly rejects a Challenger concern
- The user provides direction at a gate
- The Judge filters a finding as non-actionable (captured with rationale for the record)

**Verification**: Unit test — add decisions, render markdown, verify structure matches the format in design spec lines 446-470.

**Dependencies**: Step 2 (types).

---

## Step 11: Run Summary Generator

**Files**: `src/summary.ts`

### 11.1 Summary generator

```typescript
function generateRunSummary(
  config: RunConfig,
  state: RunState,
  metrics: MetricsSummary,
  stageDetails: StageDetail[],
  artifactPaths: ArtifactPaths
): string
```

Renders the markdown summary format from design spec lines 585-627. Includes:
- Header with date, duration, cost, models
- Per-stage breakdown (exploration stats, rounds, findings, gate outcomes)
- Quality metrics section
- Artifact file paths

**Verification**: Unit test with mock data, verify output format.

**Dependencies**: Step 9 (metrics), Step 2 (types).

---

## Step 12: Orchestrator

**Files**: `src/orchestrator.ts`

This is the core — it ties everything together. Build it last because it depends on all other modules.

### 12.1 `Orchestrator` class

```typescript
class Orchestrator {
  private writer: WriterAgent;
  private challenger: ChallengerAgent;
  private judge: JudgeAgent;
  private verifier: VerifierAgent;
  private state: StateManager;
  private context: ContextManager;
  private metrics: MetricsCollector;
  private ddl: DDLGenerator;
  private ui: TerminalUI;
  
  constructor(config: RunConfig)
  
  // Main entry point
  async run(): Promise<void>
  
  // Individual stages
  private async brainstorm(): Promise<void>
  private async writeSpec(): Promise<void>
  private async writePlan(): Promise<void>
  
  // Pre-review assumption verification
  private async verifyExternalAssumptions(artifactPath: string): Promise<void>
  
  // Review cycle (used by spec and plan stages)
  private async reviewCycle(
    stage: Stage,
    artifactPath: string,
    challengerPromptTemplate: string
  ): Promise<void>
  
  // Gate — present to user, get decision
  private async gate(stage: Stage, summary: GateSummary): Promise<GateAction>
  
  // Resume from checkpoint
  async resume(runId: string): Promise<void>
}
```

### 12.2 Initialization

Before starting the main flow, the Orchestrator performs setup:

1. **Generate git log for Challenger**: Run `git log --oneline -100` and `git log --all --oneline --graph -50` via `child_process.execSync` in the target repo, write output to `.design-challenger/runs/<run-id>/git-log.txt`. The Challenger system prompt instructs it to read this file for git history (since it has no Bash access and `.git` objects are binary).

2. **Wire compaction hooks**: Create hooks via `createCompactionHooks()` (Step 7.6) and pass them to WriterAgent and ChallengerAgent constructors.

3. **Compute per-agent budgets**: `writerBudget = config.budget * config.writerBudgetShare`, etc.

### 12.3 `run()` flow

```
1. Initialize all components (see 12.2)
2. If --skip-brainstorm, skip to step 5
3. If --spec provided, skip to step 8

4. STAGE 1: Brainstorming
   a. Start Writer: "Brainstorm a design for {topic}"
   b. Start Challenger (parallel): "Explore this codebase for context relevant to {topic}.
      Git history is available at .design-challenger/runs/<run-id>/git-log.txt"
   c. Wait for both to finish
   d. Challenger output is already parsed via outputFormat/structured_output (Step 5.3)
   e. Run Judge on Challenger findings
   f. Feed Judge-filtered findings to Writer via writer.send() (uses resume: sessionId)
   g. Writer addresses all findings
   h. Checkpoint state
   i. GATE 1: Present summary, get user decision
   j. If abort → generate summary, exit with code 1
   k. If request_changes → feed user direction to Writer, loop back to (f)

5. STAGE 2: Spec Writing
   a. Continue Writer session via writer.send(): "Write the design spec.
      Write it as a markdown file using the Write tool. Include an Assumptions
      section at the end, tagging each as internal or external."
   b. Capture artifact path from Writer response (see 12.5)
   c. Snapshot artifact content for spec diff metric
   d. Run verifyExternalAssumptions(specPath):
      - Parse the Assumptions section from the artifact
      - For each external assumption, spawn VerifierAgent.verify()
      - Feed refuted assumptions back to Writer for fixing before review
      - Record pre-review refutation rate in metrics
   e. Run reviewCycle(spec_writing, specPath, challenger-spec-review.md)
   f. Checkpoint state
   g. GATE 2: Present summary (includes finding completion checklist)
   h. Handle gate outcome same as above

6. STAGE 3: Plan Writing
   a. Continue Writer session: "Write the implementation plan.
      Include an Assumptions section, tagging each as internal or external."
   b. Capture artifact path (same mechanism as 5b)
   c. Run verifyExternalAssumptions(planPath) — same as 5d
   d. Run reviewCycle(plan_writing, planPath, challenger-plan-review.md)
   e. Checkpoint state
   f. GATE 3: Present summary (includes finding completion checklist)

7. Generate DDL file, run summary, metrics.json
8. Auto-commit artifacts to git (after each gate approval)
9. Exit with code 0 (success)
```

### 12.4 `reviewCycle()` detail

```
For round = 1 to maxRounds:
  1. Determine protocol phase:
     round 1 → counter_design_hypothesis_tester
     round 2 → skeptical_verifier
     round 3 → pre_mortem

  2. Build Challenger prompt by filling the phase template (challenger-spec-review.md or
     challenger-plan-review.md) with: round number, phase name, previous findings status,
     artifact path. This filled template is passed as the `prompt` argument to
     challenger.send() — it becomes a user message in the resumed session, NOT a system
     prompt change. The system prompt (challenger-system.md) is static and set once at
     session creation.

  3. Send to Challenger via challenger.send(filledPrompt) — uses resume: sessionId
  4. Challenger output arrives as structured_output via outputFormat (Step 5.3)
  5. If structured_output is missing: fallback extraction + retry (max 2), then surface error

  --- EXTERNAL EVIDENCE VERIFICATION ---
  6. For findings with evidence_type: "external":
     a. Spawn VerifierAgent.verify() for each external evidence citation
     b. Verified claims → mark finding.evidence_verified = true
     c. Unverifiable claims → flag for Writer ("evidence could not be independently confirmed")
     d. Refuted claims → remove finding, log in DDL as "Challenger error — evidence refuted"
     e. Record external evidence verification rate in metrics

  7. Run Judge on Challenger findings (after verification annotations)
  8. Update metrics (assumptions, findings, judge decisions, counter-design impact)
  9. Update evidence index with all newly cited evidence
  10. Check context thresholds for both agents; if masking needed, set flag for next prompt
  11. If no findings of any severity after Judge filter → break (early termination)

  --- WRITER RESPONSE ---
  12. Snapshot current artifact content (for spec diff metric)
  13. Initialize FindingChecklist with forwarded finding IDs
  14. Build Writer prompt with:
      - Judge-filtered findings (with severity, evidence, and verification status)
      - Counter-design context (what the Challenger proposed differently)
      - Explicit instruction: "Address EVERY finding. For each, either update the artifact
        OR reject with reasoning. Emit a JSON disposition block for every finding ID."
  15. Send to Writer via writer.send(writerPrompt) — uses resume: sessionId
  16. Parse Writer response for finding dispositions → feed to FindingChecklist

  --- CHECKLIST ENFORCEMENT ---
  17. If !checklist.isComplete():
      a. Re-prompt Writer with checklist.getRePrompt() (lists missing finding IDs)
      b. Parse new response, update checklist
      c. If still incomplete after 2 re-prompts: surface missing IDs to user at gate
      d. Record checklist re-prompt in metrics

  --- UPSTREAM PROPAGATION ---
  18. For findings with upstream_issue: true and disposition "addressed":
      a. Verify the Writer modified the upstream_source file (not just the current artifact)
      b. If upstream file was NOT modified: re-prompt Writer to fix the upstream doc too
      c. Record upstream fix in DDL with cross-reference to both documents
      d. Record upstream issue rate in metrics

  19. Capture artifact path from Writer response (see 12.5)
  20. Read updated artifact, compute diff against snapshot → recordSpecDiff()
  21. Capture decisions for DDL (addressed → Decision with changes, rejected → Decision
      with Writer's rejection reasoning)
  22. Checkpoint state
  23. Update Orchestrator→Challenger inter-round message:
      previous_findings_addressed = checklist IDs with disposition "addressed"
      previous_findings_rejected = checklist IDs with disposition "rejected"
      previous_findings_filtered_by_judge = Judge filtered IDs

If max rounds reached with unresolved findings:
  → Surface all remaining findings to user at gate with Challenger reasoning and evidence
  → Include checklist completion status in gate summary
```

### 12.5 Artifact path capture

The Orchestrator needs the file path of specs and plans written by the Writer. Two mechanisms, used in order of preference:

1. **Writer system prompt instruction**: The Writer's system prompt (Step 6.1) includes: "After writing a spec or plan file, state the file path on its own line in the format: `ARTIFACT_PATH: <path>`". The Orchestrator scans the Writer's `result.result` text for this pattern.

2. **Fallback — scan for Write tool calls**: If the `ARTIFACT_PATH:` pattern is not found, the Orchestrator iterates the message stream looking for `tool_use` messages with `tool_name === "Write"` and extracts the `file_path` parameter from the most recent Write call that targets a `.md` file under the output directory.

3. **Last resort**: If neither works, prompt the Writer explicitly: "What is the file path of the spec/plan you just wrote? Respond with just the path."

### 12.6 Writer finding disposition detection

To populate the DDL and enforce completeness, the Orchestrator needs structured feedback from the Writer. The Writer prompt (Step 12.4, step 14) instructs it to emit a JSON disposition block for every finding ID.

The Orchestrator parses the Writer's response for the disposition JSON array:

```typescript
// WriterDispositionEntry is defined in types.ts (Step 2.1)
// { finding_id, disposition: "addressed"|"rejected", detail: string }
```

**Primary path**: Extract JSON array from Writer's response text. Feed each entry to `FindingChecklist.recordDisposition()`. The checklist tracks completeness.

**If JSON extraction fails**: Re-prompt the Writer: "Emit a JSON array of dispositions for findings [list all IDs]. Format: `[{ finding_id: N, disposition: 'addressed'|'rejected', detail: '...' }]`"

**There is no optimistic fallback.** Missing dispositions trigger re-prompts via the checklist (Step 12.4, step 17). There is no "deferred" disposition — every finding is either addressed or rejected with reasoning. The checklist mechanically prevents the Writer from skipping findings regardless of severity.

### 12.7 Resume logic

```
1. Load state from checkpoint
2. Try SDK session resume (use stored sessionIds)
3. If SDK resume fails:
   a. Create fresh Writer and Challenger sessions
   b. Inject structured summary of all prior state:
      - Current stage and round
      - All findings and their resolution status
      - All assumptions and their verification status
      - Evidence index
      - Current artifact content (re-read from disk)
      - DDL so far
   c. Continue from where the run left off
```

### 12.8 Git auto-commit

After each gate approval:
1. `git add` the artifact files (spec, plan, DDL, summary)
2. `git commit -m "design-challenger: {stage} approved for {topic}"`

Use the Writer agent's Bash access for this (it has Bash in allowedTools), or shell out directly from the Orchestrator via Node's `child_process`.

**Verification**: 
- Integration test: run the full flow against this repo with a simple topic, verify all artifacts are produced
- Unit test: reviewCycle with mocked agents, verify round progression, early termination, and error handling
- Test resume: checkpoint mid-run, kill, resume, verify continuation

**Dependencies**: Steps 2-11 (everything).

---

## Step 13: CLI Entry Point

**Files**: `src/cli.ts`

### 13.1 Argument parsing with Commander

```typescript
program
  .argument("<topic>", "Design topic to explore")
  .option("--repo <path>", "Target repository", process.cwd())
  .option("--writer-model <name>", "Writer model", DEFAULTS.writerModel)
  .option("--challenger-model <name>", "Challenger model", DEFAULTS.challengerModel)
  .option("--max-rounds <n>", "Max review rounds per stage", String(DEFAULTS.maxRounds))
  .option("--budget <usd>", "Max spend in USD", String(DEFAULTS.budget))
  .option("--output-dir <path>", "Output directory for specs/plans")
  .option("--quiet", "Only show gates and errors")
  .option("--skip-brainstorm", "Skip brainstorming stage")
  .option("--spec <path>", "Existing spec, skip to plan writing")
  .option("--resume <run-id>", "Resume an interrupted run")
  .action(async (topic, options) => {
    const config = loadConfig(topic, options);
    const orchestrator = new Orchestrator(config);
    if (config.resumeRunId) {
      await orchestrator.resume(config.resumeRunId);
    } else {
      await orchestrator.run();
    }
  });
```

### 13.2 Error handling and exit codes

All exit paths use defined exit codes from `DEFAULTS.exitCodes`:

| Code | Meaning |
|------|---------|
| 0 | Success — all gates approved |
| 1 | Aborted — user chose abort at a gate |
| 2 | Error — unrecoverable failure (SDK error, auth failure, network) |
| 3 | Budget exceeded — cost limit hit before completion |

- Catch unhandled errors at the top level → exit code 2
- On SDK auth failure: print clear message about `ANTHROPIC_API_KEY` → exit code 2
- On budget exceeded: print cost summary, offer to resume with higher budget → exit code 3
- On network failure: checkpoint state, print resume command → exit code 2
- On user abort at gate → exit code 1

### 13.3 Shebang and bin

Add `#!/usr/bin/env node` to the compiled output. Ensure `package.json` `bin` field points to `dist/cli.js`.

**Verification**: `npx design-challenger --help` shows all options. `npx design-challenger "test topic" --repo .` starts a run.

**Dependencies**: Step 3 (config), Step 12 (orchestrator).

---

## Step 14: End-to-End Testing

### 14.1 Self-test

Run design-challenger against its own repo:
```bash
npx design-challenger "add a --dry-run flag" --repo . --budget 5 --max-rounds 1
```

Verify:
- Writer brainstorms and writes a spec
- Challenger explores the codebase and produces findings
- Judge filters findings
- Writer addresses feedback
- Gates appear and accept input
- All 4 artifacts are produced
- Metrics are reasonable
- Resume works after interruption

### 14.2 Cross-repo test

Run against a different repo to verify project-agnostic behavior:
```bash
npx design-challenger "add caching layer" --repo ~/some-other-project --budget 5
```

---

## Implementation Order Summary

```
Step 1:  Scaffolding (package.json, tsconfig)                    — foundation
Step 2:  Types + Schemas                                          — data contracts
Step 3:  Config                                                   — CLI defaults
Step 4:  Terminal UI                                              — visible output
Step 5:  Agent Wrappers (Writer, Challenger, Judge, Verifier,    — SDK integration +
         Checklist)                                                 enforcement logic
Step 6:  System Prompts                                           — agent behavior
Step 7:  Context Management                                       — token budgets
Step 8:  State Management                                         — checkpointing
Step 9:  Metrics                                                  — quality signals
Step 10: DDL Generator                                            — decision capture
Step 11: Run Summary                                              — process record
Step 12: Orchestrator (includes assumption verification,          — ties it all together
         checklist enforcement, upstream propagation,
         external evidence verification)
Step 13: CLI Entry Point                                          — user interface
Step 14: End-to-End Testing                                       — validation
```

Steps 2 and 3 can be parallelized (no cross-dependencies).
Step 4 depends on Step 2 (imports Finding, Assumption, Severity types).
Steps 7-11 can be parallelized (all depend only on Step 2; Step 7 also needs Step 8 for hooks).
Step 5 depends on Steps 2, 3, 4.
Step 6 depends on Step 2 (schema shapes for output format instructions).
Step 12 depends on everything.
Step 13 depends on Steps 3, 12.

---

## Critical Risks

1. **SDK API surface drift** — The SDK is actively evolving (V2 preview exists alongside stable V1). API options like `outputFormat`, `resume`, `disallowedTools`, and `hooks` must be verified at implementation time against the installed SDK version. **Mitigation**: Step 5 starts with a minimal SDK smoke test (single `query()` call with all required options) before building the full wrappers.

2. **Structured output via `outputFormat`** — The SDK's `outputFormat: { type: "json_schema" }` feature is the primary path for reliable Challenger and Judge JSON output. If it produces unexpected behavior (partial output, schema violations), the fallback is ad-hoc JSON extraction from `result.result` + ajv validation + retries (max 2). **Mitigation**: Both paths are implemented; `outputFormat` is preferred, text extraction is the fallback.

3. **Context budget tracking accuracy** — Token counts from SDK `result.usage` may not perfectly match the model's actual context usage. **Mitigation**: Conservative thresholds with wide margins (150K/250K/500K).

4. **Session resume reliability** — SDK session resume via `resume: sessionId` may fail (session expired, corrupted, cross-host). **Mitigation**: Semantic fallback (fresh session + state injection from checkpoint) is the backup path; both paths are implemented in Step 12.7.

5. **Cost overruns** — Parallel Writer + Challenger + 3 review rounds + Judge + Verifier calls can exceed budget. **Mitigation**: Budget is split across agents via share percentages (45/45/10 default). Verifier calls are capped at $0.50 each and use Haiku. Orchestrator tracks cumulative cost and can halt the run.

6. **Writer disposition detection** — The Orchestrator needs to know which Challenger findings the Writer addressed vs. rejected, but the Writer's primary output is free text + file writes. **Mitigation**: Writer is prompted to emit structured disposition JSON (Step 12.6). FindingChecklist mechanically enforces completeness — no optimistic fallback, missing dispositions trigger re-prompts.

7. **Verifier false negatives** — The Verifier agent may fail to find documentation for a valid claim (e.g., undocumented SDK behavior that works in practice). **Mitigation**: Unverifiable claims are flagged as "could not confirm" rather than "refuted." Only claims actively contradicted by documentation are removed.

8. **Upstream propagation scope** — When the Writer fixes an upstream doc, those changes might invalidate other parts of the current artifact that reference the now-changed upstream sections. **Mitigation**: The Challenger's next round (skeptical verifier) re-reads both artifacts and will catch cascading inconsistencies.

---

## Design Spec Errata

Issues in the design spec that this plan corrects. These should be back-ported to the spec:

1. **Missing `allowDangerouslySkipPermissions: true`** — Required companion field for `permissionMode: "bypassPermissions"`. SDK rejects the call without it. All three SDK examples in the spec (Writer, Challenger, Judge) need this added.

2. **`allowedTools` semantics** — The spec uses `allowedTools` as if it restricts the tool surface. Under `bypassPermissions`, `allowedTools` is only an auto-approval list (all tools are already approved). To actually restrict the tool surface, use the `tools` option. The Challenger's read-only enforcement works because `disallowedTools` is respected regardless, but the Writer's `allowedTools` list is documentation-in-code, not enforcement.

3. **Challenger git history access** — The spec says "Git history is accessible via Grep on `.git` metadata." This is incorrect — `.git` objects are binary (pack files, commit objects). The Orchestrator must pre-generate a `git-log.txt` file for the Challenger to read.

4. **Session continuation model** — The spec implies persistent sessions with continued interaction. The stable SDK's `query()` is one-shot (returns AsyncGenerator). Multi-turn requires new `query()` calls with `resume: sessionId`. The V2 preview has `unstable_v2_createSession().send()` for native multi-turn, but it's alpha.

5. **Budget is per-agent, not total** — The spec says "$20 total" but sets `maxBudgetUsd: config.budget` on each agent. Each agent gets the full budget → actual max spend is 2× the stated budget. The plan splits the budget by share percentages.

6. **Judge model ID** — The spec uses `"claude-haiku-4-5"` but the correct model ID includes a date suffix: `"claude-haiku-4-5-20251001"`.
