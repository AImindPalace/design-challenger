# Design Challenger — v1 Spec

## Purpose

A standalone CLI tool that orchestrates three Claude Code agents (Writer + Challenger + Judge) to produce higher-quality design specs and implementation plans. It automates the "double-check the design" loop that humans currently do manually.

The human sets the goal and approves the output. Everything in between is autonomous.

## Roles

| Role | Description |
|------|-------------|
| **Writer** | Brainstorms, researches, writes specs and plans. Self-answers clarifying questions from codebase context. |
| **Challenger** | Independently explores the codebase and web, produces counter-designs, extracts assumptions, then rigorously tests them against evidence. Read-only — never modifies files. |
| **Judge** | Lightweight filter agent that evaluates Challenger findings for actionability before they reach the Writer. Removes noise, consolidates duplicates, applies the "won't change the decision" filter. |
| **Orchestrator** | Node.js script that manages the multi-agent flow, routes structured messages, validates message schemas, enforces termination, tracks context budgets, captures decisions, and collects quality metrics. |
| **User** | Sets the design goal. Reviews and approves at gates. Does not participate in the agent loop. |

## Architecture

```
User
  |
  v
Orchestrator (Node.js CLI)
  |-- Writer Agent (Claude Code SDK session -- persistent)
  |     \-- Has: file tools, git, bash, web search
  |-- Challenger Agent (Claude Code SDK session -- persistent)
  |     \-- Has: file tools, web search (NO bash, NO write/edit)
  |-- Judge Agent (Claude Code SDK -- ephemeral per evaluation)
  |     \-- Filters findings for actionability before forwarding to Writer
  |-- State Manager
  |     \-- Checkpoints run state for resume, captures DDL
  |-- Context Manager
  |     \-- Tracks token budgets, triggers observation masking, manages compaction hooks
  \-- Metrics Collector
        \-- Logs assumption survival rate, finding resolution, cost, quality signals
```

Both Writer and Challenger run against the **target repo** (any codebase). The Orchestrator runs from the design-challenger installation; agents run with `cwd` set to the target repo.

### SDK Integration

Uses `@anthropic-ai/claude-agent-sdk`. Authentication requires an `ANTHROPIC_API_KEY` environment variable (or Bedrock/Vertex credentials).

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Writer session -- persistent across the entire flow
const writerSession = query({
  prompt: writerPrompt,
  options: {
    cwd: targetRepoPath,
    model: config.writerModel,  // default: "claude-opus-4-6"
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"],
    permissionMode: "bypassPermissions",
    maxBudgetUsd: config.budget,  // default: 20
    includePartialMessages: true,
    systemPrompt: writerSystemPrompt,
    settingSources: ["project"],  // loads target repo's CLAUDE.md
  }
});

// Challenger session -- persistent across the entire flow
// Read-only enforced via disallowedTools (bypassPermissions overrides allowedTools,
// so allowedTools alone is NOT sufficient to restrict tool access)
const challengerSession = query({
  prompt: challengerPrompt,
  options: {
    cwd: targetRepoPath,
    model: config.challengerModel,  // default: "claude-opus-4-6"
    allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
    permissionMode: "bypassPermissions",
    maxBudgetUsd: config.budget,
    includePartialMessages: true,
    systemPrompt: challengerSystemPrompt,
    settingSources: ["project"],
  }
});

// Judge -- ephemeral, one call per evaluation
const judgeResult = query({
  prompt: judgePrompt,
  options: {
    model: "claude-haiku-4-5",  // fast and cheap for filtering
    systemPrompt: judgeSystemPrompt,
  }
});
```

Session continuation uses the `resume` option with the session ID captured from the `system` init message.

### Why `disallowedTools` on the Challenger

`permissionMode: "bypassPermissions"` approves ALL tools regardless of `allowedTools`. This means `allowedTools` alone cannot restrict the Challenger from writing files. The `disallowedTools` list explicitly blocks Write, Edit, NotebookEdit, and Bash. Bash is excluded because system prompt instructions are an unreliable enforcement mechanism — agents disobey task constraints in documented multi-agent failure modes. Glob + Grep + Read + WebSearch + WebFetch cover all read-only exploration needs.

### Session Persistence

Both the Writer and Challenger maintain **one persistent session each** across the entire run:

- The Challenger explores the codebase in Stage 1 and carries that knowledge into Stages 2 and 3. It does not re-explore — it builds on what it already knows.
- Each review round adds to the Challenger's context, making it sharper with each iteration.
- The Writer similarly accumulates all brainstorming context, Challenger feedback, and user direction across the entire flow.

Both agents get smarter as the run progresses — they never start from zero. However, context growth is actively managed (see Context Management).

### System Prompt Design

The Writer and Challenger system prompts embed their methodology directly — no dependency on external plugins or skills being installed on the target machine.

**Writer system prompt includes:**
- Brainstorming methodology (explore context, generate questions, propose approaches)
- Spec-writing structure (architecture, components, data flow, error handling)
- Plan-writing structure (ordered steps, dependencies, verification)
- Explicit instruction to self-answer clarifying questions using CLAUDE.md and codebase context rather than waiting for human input
- Instruction to output structured artifacts that the Orchestrator can parse

**Challenger system prompt includes:**
- The full escalating review protocol with dialectical inquiry (see Challenger Behavior below)
- Instruction to output structured findings in the inter-agent format
- Read-only constraint: "You explore and analyze. You do not modify any files."

**Judge system prompt includes:**
- The actionability filter criteria (see Judge Behavior below)
- Instruction to output filtered findings in the inter-agent format

### Heterogeneous Model Support

Using different models for Writer and Challenger is a **recommended configuration**, not just supported. Research on multi-agent debate is unambiguous: same-model debate amplifies shared biases because all agents reason with the same training priors. Heterogeneous models (different providers or capability tiers) introduce genuine perspective diversity.

Recommended configurations:

| Writer | Challenger | Trade-off |
|--------|-----------|-----------|
| Claude Opus 4.6 | Claude Opus 4.6 | Default. Strongest reasoning on both sides, but shared blind spots. |
| Claude Sonnet 4.6 | Claude Opus 4.6 | Cheaper Writer for creative generation, full Opus reasoning for adversarial review. |
| Claude Opus 4.6 | Different provider | Maximum perspective diversity. Eliminates shared training biases. Requires separate API key config. |

The CLI exposes `--writer-model` and `--challenger-model` as first-class options (see CLI Interface).

## Flow

### Stage 1: Brainstorming

```
Orchestrator
  |-- Starts Writer: "Brainstorm a design for <topic>"
  |     Writer researches the web + codebase, generates clarifying questions,
  |     answers them itself using project context (CLAUDE.md, existing code, git history)
  |
  |-- Starts Challenger (parallel): "Explore this codebase for context relevant to <topic>"
  |     Challenger reads CLAUDE.md, greps implementations, checks git history via Read/Glob/Grep,
  |     researches web for best practices and alternative approaches
  |
  |-- When both finish:
  |     Orchestrator validates Challenger output against JSON schema
  |     Judge filters Challenger findings for actionability
  |     Orchestrator feeds filtered findings to Writer as structured input
  |     Writer addresses all Challenger concerns
  |     Orchestrator captures decisions to DDL
  |
  \-- GATE 1 -> User sees: brainstorming summary, key decisions, Challenger findings
        [Approve / Request changes / Abort]
        "Request changes" -> User provides direction, Writer resumes with that input
```

### Stage 2: Spec Writing

```
Orchestrator
  |-- Continues Writer session: "Write the design spec"
  |     Writer produces full spec document
  |
  |-- Continues Challenger session: "Review this spec"
  |     Challenger runs the escalating review protocol (see below):
  |       1. Produces counter-design sketch (dialectical inquiry)
  |       2. Identifies divergence points
  |       3. Runs hypothesis testing on divergences and assumptions
  |     Challenger re-reads the ARTIFACT ITSELF each round, not the Writer's explanation
  |
  |-- Review cycle (max 3 rounds):
  |     Round 1: Counter-design + hypothesis testing
  |     Round 2: Skeptical verification of fixes + new issues
  |     Round 3: Pre-mortem -- imagine failure, trace through design
  |
  |     Each round:
  |       Orchestrator validates Challenger output against JSON schema
  |       Judge filters findings (removes noise, applies "won't change the decision" filter)
  |       Orchestrator tells Writer which findings to address
  |       Orchestrator tells Challenger which findings were addressed between rounds
  |       Orchestrator captures all decisions to DDL
  |       Orchestrator checks context budgets, triggers masking if needed
  |       Exit early if no remaining CRITICAL or IMPORTANT findings
  |
  \-- GATE 2 -> User sees: spec file path, review summary, assumption list,
        metrics snapshot, any unresolved concerns
        [Approve / Request changes / Abort]
```

### Stage 3: Plan Writing

```
Orchestrator
  |-- Continues Writer session: "Write the implementation plan"
  |     Writer produces detailed plan
  |
  |-- Continues Challenger session: "Review this plan"
  |     Same escalating review protocol (counter-design + hypothesis + skeptical + pre-mortem)
  |     Challenger now has context from brainstorming + spec review
  |     Orchestrator captures decisions to DDL
  |
  \-- GATE 3 -> User sees: plan file path, review summary, final metrics
        [Approve / Request changes / Abort]
```

## Challenger Behavior

### Phase 1: Explore (Stage 1 only)

The Challenger independently investigates before reviewing anything:

1. Read CLAUDE.md and any project documentation (loaded via `settingSources: ["project"]`)
2. Grep for existing implementations relevant to the topic
3. Check git history for related past decisions and patterns (via Read on git log output files, or Grep on commit messages)
4. Web research — best practices, known pitfalls, alternative approaches for the problem domain

### Phase 2: Escalating Review Protocol with Dialectical Inquiry

The Challenger's review intensifies across rounds. Each round attacks from a different cognitive angle to systematically eliminate blind spots. The addition of counter-design generation (dialectical inquiry) forces genuine divergent thinking — research shows pure critique produces "cognitive bolstering of the initial viewpoint" rather than authentic challenge.

#### Round 1 — Counter-Design + Hypothesis Tester

1. **Counter-design sketch**: Before critiquing the Writer's design, the Challenger independently proposes what it would have designed instead. This is brief (2-4 paragraphs covering key architectural decisions), not a full spec. The purpose is to force genuinely independent thinking before the Writer's framing anchors the Challenger's reasoning.

   ```
   COUNTER-DESIGN:
     Architecture: <brief alternative approach>
     Key differences from Writer's design:
       1. <divergence point> — Why I would choose differently: <reasoning>
       2. <divergence point> — Why I would choose differently: <reasoning>
     What the Writer's design gets right that mine doesn't: <honest assessment>
   ```

2. **Steelman**: Demonstrate understanding of the Writer's design by restating its strongest form. "The design proposes X because Y, which addresses Z." This forces deep engagement before critique.

3. **Extract assumptions**: List every implicit assumption as a numbered, testable hypothesis:
   ```
   ASSUMPTION #1: The existing auth middleware supports JWT tokens
     Source: Spec section 3, line "integrate with current auth"
     Testable by: Checking src/middleware/auth.ts for JWT handling

   ASSUMPTION #7: The database handles 500 concurrent writes
     Source: Spec section 5, batch processing design
     Testable by: Checking DB config, connection pool limits
   ```

4. **Falsify**: Attempt to disprove each assumption against the codebase and web research. Prioritize assumptions where the counter-design diverges from the Writer's design — these are the highest-signal areas. Every finding must cite specific evidence (file paths, line numbers, git commits, URLs).

#### Round 2 — Skeptical Verifier

Prompt framing: *"The Writer claims to have fixed everything. Don't take their word for it — re-read the updated artifact and verify the actual changes. Also: what did you miss in Round 1? You are NOT bound by your previous assessments — redefine the problem space if needed."*

- Re-read the spec/plan file directly (not the Writer's explanation of changes)
- Verify each claimed fix by checking the actual text
- Revisit assumptions — were they truly addressed or just hand-waved?
- Look for new issues introduced by the fixes
- Revisit counter-design divergence points — did the Writer's fixes address or ignore them?

#### Round 3 — Pre-mortem

Prompt framing: *"It's 6 months from now. This implementation failed in production. What went wrong?"*

- Generate 3-5 specific, concrete failure scenarios
- Trace each scenario through the design step by step
- Identify where the design breaks under each scenario
- Focus on integration failures, operational issues, and edge cases that line-by-line review misses
- Reference the counter-design — would any of those alternative decisions have prevented the failure?

### Findings Format

Every Challenger finding follows this structure:

```
FINDING: <one-line summary>
SEVERITY: CRITICAL | IMPORTANT | MINOR
ASSUMPTION: #N (if tied to a specific assumption)
COUNTER_DESIGN_DIVERGENCE: true/false (whether this was surfaced by the counter-design analysis)
EVIDENCE:
  - <file path>:<line number> -- <what it shows>
  - <URL> -- <what it shows>
  - <git commit hash> -- <what it shows>
RECOMMENDATION: <specific action the Writer should take>
```

### Severity Levels

| Severity | Meaning | Writer must address? |
|----------|---------|---------------------|
| **CRITICAL** | Design will break something or miss a hard requirement | Yes |
| **IMPORTANT** | Gap or inconsistency that will cause problems | Yes |
| **MINOR** | Improvement that can wait | No — captured in DDL, not forwarded to Writer |

MINOR findings are logged in the Design Decision Log but not forwarded to the Writer. This prevents decision fatigue from low-signal feedback. If the user wants to see MINORs, they're in the DDL.

### Termination

- Max 3 review rounds per stage (one round per protocol phase)
- A stage passes early if the Challenger reports no remaining CRITICAL or IMPORTANT findings
- If max rounds reached with unresolved concerns, those are surfaced to the user at the gate with the Challenger's reasoning and evidence

## Judge Behavior

The Judge agent is a lightweight quality gate between the Challenger's raw output and what reaches the Writer. It runs on Haiku for speed and cost.

### Why a Judge

HubSpot's production AI code review agent found that adding a Judge Agent that filters findings before forwarding them was "arguably the single most important factor" in effectiveness. Without it, developers dismissed all feedback because it was noisy. The same dynamic applies here: a Writer drowning in low-signal findings produces defensive, over-engineered responses rather than targeted fixes.

### Judge Evaluation Criteria

For each Challenger finding, the Judge asks:

1. **Actionable?** — Does the finding point to a specific, fixable issue with enough evidence to act on? Vague concerns with no evidence are filtered.
2. **Won't change the decision?** — If addressing this finding would not change any architectural decision in the spec, it is demoted to DDL-only regardless of stated severity.
3. **Duplicate?** — Is this substantially the same issue as another finding, phrased differently? Consolidate into one.
4. **Proportionate?** — Is the severity appropriate given the evidence? A CRITICAL finding backed by one ambiguous code comment should be demoted to IMPORTANT.

### Judge Output

```json
{
  "forwarded_findings": [
    { "original_id": 1, "adjusted_severity": "CRITICAL", "rationale": "..." }
  ],
  "ddl_only_findings": [
    { "original_id": 4, "reason": "won't change architectural decision", "rationale": "..." }
  ],
  "filtered_findings": [
    { "original_id": 7, "reason": "not actionable — no evidence cited", "rationale": "..." }
  ]
}
```

The Orchestrator uses the Judge's output to route findings: forwarded findings go to the Writer, DDL-only findings go to the Design Decision Log, filtered findings are discarded (logged in run state for debugging).

## Inter-Agent Message Format

The Orchestrator routes structured messages between agents. All messages are validated against JSON schemas before routing — a parse or validation failure triggers a retry request to the producing agent (max 2 retries) before surfacing the error to the user.

### Schema Validation

The Orchestrator maintains JSON schemas for every inter-agent message type. Before routing any message:

1. Parse the agent's text output as JSON
2. Validate against the expected schema for the current phase
3. On failure: ask the agent to re-emit in the correct format (include the schema in the retry prompt)
4. On second failure: log the raw output, surface error to user, allow manual intervention or abort

This prevents mid-run failures from malformed JSON — an avoidable failure mode when relying on LLMs to produce structured output.

### Challenger -> Orchestrator

```json
{
  "round": 1,
  "protocol_phase": "counter_design_hypothesis_tester",
  "counter_design": {
    "summary": "Brief alternative architecture...",
    "divergence_points": [
      { "id": 1, "writer_choice": "...", "challenger_alternative": "...", "reasoning": "..." }
    ],
    "writer_strengths": "What the Writer's design gets right..."
  },
  "steelman": "The design proposes...",
  "assumptions": [
    { "id": 1, "text": "...", "source": "spec section 3", "status": "falsified", "evidence": "..." },
    { "id": 2, "text": "...", "source": "spec section 5", "status": "verified", "evidence": "..." }
  ],
  "findings": [
    { "id": 1, "summary": "...", "severity": "CRITICAL", "assumption_id": 1, "counter_design_divergence": true, "evidence": [...], "recommendation": "..." }
  ],
  "pass": false
}
```

### Orchestrator -> Judge

```json
{
  "stage": "spec_review",
  "round": 1,
  "challenger_findings": [...],
  "writer_spec_path": "docs/superpowers/specs/2026-04-09-websocket-design.md",
  "instruction": "Evaluate each finding for actionability. Filter noise. Consolidate duplicates."
}
```

### Judge -> Orchestrator

```json
{
  "forwarded_findings": [
    { "original_id": 1, "adjusted_severity": "CRITICAL", "rationale": "Backed by file evidence, would change auth architecture" }
  ],
  "ddl_only_findings": [
    { "original_id": 4, "reason": "won't change decision", "rationale": "Naming convention preference, not architectural" }
  ],
  "filtered_findings": [
    { "original_id": 7, "reason": "not actionable", "rationale": "No evidence cited, vague concern" }
  ]
}
```

### Orchestrator -> Writer (forwarding Judge-filtered findings)

```json
{
  "challenger_round": 1,
  "findings_to_address": [
    { "id": 1, "summary": "...", "severity": "CRITICAL", "evidence": "...", "recommendation": "...", "counter_design_context": "Challenger's alternative approach was..." }
  ],
  "counter_design_summary": "The Challenger independently proposed...",
  "instruction": "Address all CRITICAL and IMPORTANT findings. Consider the Challenger's alternative approach where relevant. Update the spec file."
}
```

### Orchestrator -> Challenger (between rounds)

```json
{
  "round": 2,
  "protocol_phase": "skeptical_verifier",
  "previous_findings_addressed": [1, 3, 5],
  "previous_findings_deferred": [2],
  "previous_findings_filtered_by_judge": [7],
  "updated_artifact_path": "docs/superpowers/specs/2026-04-09-websocket-design.md",
  "instruction": "Re-read the artifact. Verify fixes. Find what you missed. Revisit your counter-design divergences."
}
```

## Design Decision Log (DDL)

The Orchestrator captures every significant decision from the Writer-Challenger debate into a `design-decisions.md` artifact:

```markdown
# Design Decisions -- <topic>

## Decision 1: WebSocket over SSE
- **Context**: Spec requires bidirectional real-time communication
- **Writer proposed**: WebSocket for full-duplex messaging
- **Challenger counter-design**: SSE for server->client push (simpler, sufficient for most cases)
- **Challenger concern**: SSE is simpler and sufficient for server->client push (cited MDN docs)
- **Resolution**: WebSocket chosen -- requirement X needs client->server push during active sessions
- **Evidence**: src/api/realtime.ts:42 already uses WebSocket patterns
- **Round**: Spec Review, Round 1
- **Judge assessment**: Forwarded as CRITICAL -- would change transport architecture

## Decision 2: Connection pool size
- **Context**: Batch processing design implies high concurrent DB writes
- **Writer proposed**: Default pool of 10 connections
- **Challenger concern**: ASSUMPTION #7 falsified -- current pool is 5, and pgbouncer config caps at 20
- **Resolution**: Writer updated to use dynamic pool sizing based on pgbouncer limits
- **Evidence**: config/database.yml:18, infrastructure/pgbouncer.ini:3
- **Round**: Spec Review, Round 2

## DDL-Only (Minor findings captured for reference)
- **Naming**: Challenger suggested `ConnectionManager` over `PoolHandler` -- stylistic, no architectural impact
- **Docs**: Missing JSDoc on internal helper -- not blocking
```

This is generated automatically from the structured inter-agent messages. The Orchestrator extracts decisions whenever:
- A Challenger finding causes the Writer to change the design
- The Writer explicitly rejects a Challenger concern with reasoning
- The user provides direction at a gate
- The Judge demotes a finding to DDL-only (captured with rationale)

The DDL is saved alongside the spec and plan as a first-class output artifact.

## Context Management

### The Problem

LLMs exhibit a U-shaped attention curve: strong at the beginning and end of context, with a blind spot in the middle 40-60%. Performance drops exceeding 50% are documented at 100K+ tokens. Claude Code's auto-compaction is lossy — file paths, line numbers, and multi-step reasoning chains get compressed into generic summaries. A Challenger that reads 50+ files, does web searches, and runs through multiple review cycles will easily exceed 200K tokens by Stage 3.

### Strategy

The Orchestrator actively manages context rather than trusting 1M to be sufficient:

**Token Budget Tracking**

The Orchestrator estimates token usage per session by tracking:
- Cumulative input tokens from SDK message events
- Approximate output tokens from response lengths
- A running total per agent per stage

**Tiered Intervention**

| Threshold | Action |
|-----------|--------|
| 150K tokens | **Observation masking** — Replace old tool outputs (file contents, grep results) with one-line summaries in subsequent prompts. JetBrains research showed this cuts costs 50% and improves solve rates by 2.6%. |
| 250K tokens | **Active summarization** — Orchestrator injects a structured context summary and requests the agent acknowledge it before continuing. Key findings, assumptions, and evidence paths are preserved; raw exploration output is discarded. |
| 500K tokens | **Alert** — Something has gone wrong. Pause the run, notify the user, and offer to continue with a fresh session seeded from checkpoint state. |

**PreCompact / PostCompact Hooks**

The Orchestrator registers hooks with the SDK:
- **PreCompact**: Archive the full transcript to the run's checkpoint directory before the SDK summarizes it
- **PostCompact**: Re-inject critical structured context — active findings list, assumption tracker, evidence index, counter-design divergence points

**Evidence Index**

The Orchestrator maintains a side-channel `evidence-index.json` in the run directory:
- Every piece of evidence the Challenger cites (file paths, line numbers, URLs, git commits) is indexed here
- After compaction, the Challenger can re-access this index rather than re-exploring the codebase
- The Writer can reference it when addressing findings

```json
{
  "evidence": [
    { "id": "e1", "type": "file", "path": "src/auth/middleware.ts", "lines": "42-58", "summary": "JWT validation logic", "cited_by": ["assumption_1", "finding_3"] },
    { "id": "e2", "type": "url", "url": "https://...", "summary": "OWASP JWT best practices", "cited_by": ["finding_3"] }
  ]
}
```

## Quality Metrics

The Orchestrator collects metrics per run to measure whether the Challenger is adding value. Without measurement, you can't know if adversarial review is improving designs or just adding cost and latency.

### Metrics Collected

| Metric | What it measures | Healthy range |
|--------|-----------------|---------------|
| **Assumption survival rate** | % of extracted assumptions that survived falsification | 70-85%. Below 70% = Writer producing weak designs. Above 85% = Challenger not digging deep enough. |
| **Finding resolution rate** | % of CRITICAL/IMPORTANT findings resolved by Writer | >90%. Unresolved CRITICALs that reach the user are the clearest signal of system failure. |
| **Judge filter rate** | % of Challenger findings filtered or demoted by Judge | 20-40%. Below 20% = Challenger is already precise, Judge may be unnecessary. Above 40% = Challenger is too noisy. |
| **Counter-design divergence impact** | % of forwarded findings that originated from counter-design analysis | >30%. If counter-design never surfaces unique findings, dialectical inquiry isn't adding value. |
| **Spec diff size** | Lines changed between pre-review and post-review spec | Non-zero. If the Challenger drives zero substantive changes, it's rubber-stamping. |
| **Gate outcome** | User approved / requested changes / aborted at each gate | Track over time. Consistent approvals with no changes = gates aren't surfacing useful info OR system is working perfectly. |
| **Cost** | Total USD spent (input + output tokens across all agents) | Track per run for budgeting. |
| **Duration** | Wall-clock time per stage and total | Track for UX expectations. |
| **Rounds used** | How many review rounds per stage before passing | Avg 1.5-2.5 is healthy. Consistently 3 = Challenger may be too aggressive or Writer too weak. Consistently 1 = Challenger may be too lenient. |

### Where Metrics Go

Metrics are included in the run summary (see Output Artifacts) and stored in the checkpoint directory as `metrics.json` for programmatic access. Over time, aggregate metrics across runs reveal whether the system is well-calibrated or needs prompt tuning.

## Run State & Resume

### Checkpointing

The Orchestrator saves run state after every significant event:

```
.design-challenger/
  runs/
    <run-id>/
      state.json          # Current stage, round, session IDs, gate outcomes, token counts
      messages/           # Structured inter-agent messages (for DDL generation)
      artifacts/          # Copies of spec/plan at each checkpoint
      evidence-index.json # All cited evidence, indexed
      metrics.json        # Running quality metrics
      transcripts/        # Full transcripts archived before compaction
```

State is saved to the **target repo** under `.design-challenger/` (gitignored).

### Resume

If a run fails (network drop, token expiry, crash), resume from the last checkpoint:

```bash
design-challenger --resume <run-id>
```

**Primary path**: The Orchestrator restores session IDs and resumes the agents from where they left off using the SDK's `resume` option.

**Semantic fallback**: If SDK session resume fails (session expired, corrupted, cross-host), the Orchestrator creates fresh sessions and injects a structured summary of all prior state from checkpoint files — findings, assumptions, decisions, evidence index, and the current artifact state. This is more resilient than raw session resume because it doesn't depend on the SDK session being intact.

## Run Summary

After all gates pass (or on abort), the Orchestrator generates `design-run-summary.md`:

```markdown
# Run Summary -- <topic>
Date: 2026-04-09
Duration: 14m 32s
Cost: $8.42 (Writer: $4.20, Challenger: $3.80, Judge: $0.42)
Models: Writer=claude-opus-4-6, Challenger=claude-opus-4-6, Judge=claude-haiku-4-5

## Stage 1: Brainstorming
- Writer: explored 12 files, 3 web searches
- Challenger: explored 28 files, 5 web searches, surfaced 4 concerns
- Judge: forwarded 3, filtered 1 (not actionable)
- Gate: Approved

## Stage 2: Spec Review
- Round 1 (Counter-Design + Hypothesis Tester): 8 assumptions extracted, 2 falsified
    -> 3 CRITICAL, 1 IMPORTANT, 2 MINOR
    -> Judge forwarded 3 CRITICAL + 1 IMPORTANT, captured 2 MINOR in DDL
    -> 1 finding originated from counter-design divergence
- Round 2 (Skeptical Verifier): 1 fix inadequate, 1 new IMPORTANT found
    -> Judge forwarded all
- Round 3: Not needed -- passed after Round 2
- Gate: Approved

## Stage 3: Plan Review
- Round 1 (Counter-Design + Hypothesis Tester): 5 assumptions, all verified
    -> 0 CRITICAL, 2 IMPORTANT
    -> Judge forwarded both
- Round 2 (Skeptical Verifier): All addressed
- Gate: Approved

## Quality Metrics
- Assumption survival rate: 77% (10/13 verified)
- Finding resolution rate: 100% (all CRITICAL/IMPORTANT resolved)
- Judge filter rate: 25% (3/12 filtered or DDL-only)
- Counter-design divergence impact: 33% (2/6 forwarded findings from counter-design)
- Spec diff: 47 lines changed across 4 sections

## Artifacts
- Spec: docs/superpowers/specs/2026-04-09-websocket-design.md
- Plan: docs/superpowers/plans/2026-04-09-websocket-plan.md
- Decisions: docs/superpowers/specs/2026-04-09-websocket-decisions.md
- Summary: docs/superpowers/specs/2026-04-09-websocket-run-summary.md
```

## CLI Interface

```bash
# Basic usage
design-challenger "add WebSocket support" --repo /path/to/project

# Options
design-challenger <topic> [options]

Options:
  --repo <path>              Target repository (default: current directory)
  --writer-model <name>      Model for Writer agent (default: claude-opus-4-6)
  --challenger-model <name>  Model for Challenger agent (default: claude-opus-4-6)
  --max-rounds <n>           Max Challenger cycles per stage (default: 3)
  --budget <usd>             Max spend across all agents (default: 20)
  --output-dir <path>        Override output location for specs/plans
  --quiet                    Only show gate notifications, suppress streaming
  --skip-brainstorm          Skip brainstorming, start from spec writing
  --spec <path>              Provide existing spec, skip to plan writing
  --resume <run-id>          Resume a failed/interrupted run

# Examples
design-challenger "add user authentication" --repo ~/projects/myapp
design-challenger "migrate to event sourcing" --challenger-model claude-sonnet-4-6 --budget 10
design-challenger "WebSocket support" --quiet --max-rounds 2
```

## Output Artifacts

Every run produces up to 4 artifacts in the target repo:

| Artifact | Default Location | Description |
|----------|-----------------|-------------|
| **Spec** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | The design document |
| **Plan** | `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md` | The implementation plan |
| **DDL** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-decisions.md` | Why every decision was made (includes Judge-demoted findings) |
| **Summary** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-run-summary.md` | Process record with quality metrics |

All overridable with `--output-dir`. Auto-committed to git at each gate after user approval.

## Terminal UX

### Streaming Output

- **Writer** output: cyan
- **Challenger** output: yellow
- **Judge** output: dim/gray (lightweight, usually fast)
- **Orchestrator** status: white/bold
- Phase indicator: `[Spec Review . Round 2/3 . Skeptical Verifier]`
- Context budget: `[Challenger: 142K/500K tokens]`
- Challenger findings printed as discovered with severity badges
- Counter-design summary displayed before findings in Round 1
- Assumption list displayed when extracted
- Judge filtering displayed: `Judge: 5 findings -> 3 forwarded, 1 DDL-only, 1 filtered`
- Gates are visually distinct — bordered, with clear action prompts

### Quiet Mode

`--quiet` suppresses streaming and only shows:
- Phase transitions
- Gate summaries with approval prompts
- Context budget warnings
- Errors

## Project Structure

```
design-challenger/
  package.json
  tsconfig.json
  src/
    cli.ts                 # CLI entry point, argument parsing
    orchestrator.ts        # Manages the 3-stage flow, decision capture
    state.ts               # Run checkpointing and resume (primary + semantic fallback)
    context.ts             # Token budget tracking, observation masking, compaction hooks
    metrics.ts             # Quality metrics collection and aggregation
    agents/
      writer.ts            # Writer session management
      challenger.ts        # Challenger session management
      judge.ts             # Judge agent (ephemeral per evaluation)
      types.ts             # Inter-agent message types
      schemas.ts           # JSON schemas for message validation
    prompts/
      writer-system.md             # Writer system prompt (embeds methodology)
      challenger-system.md         # Challenger system prompt (embeds escalating protocol + dialectical inquiry)
      challenger-spec-review.md    # Prompt template for spec review rounds
      challenger-plan-review.md    # Prompt template for plan review rounds
      challenger-exploration.md    # Prompt template for codebase exploration
      judge-system.md              # Judge system prompt (actionability criteria)
    ui/
      terminal.ts          # Color-coded output, gate rendering, context budget display
      notifications.ts     # Gate notification handling
    config.ts              # CLI options, defaults, model configuration
    types.ts               # Shared TypeScript types
```

### Why This Structure

- `agents/` encapsulates all SDK interaction — swapping SDK versions or adding agent types doesn't touch orchestration logic
- `agents/schemas.ts` validates all inter-agent messages at the routing boundary — parse failures are caught before they propagate
- `agents/judge.ts` is a thin wrapper — the Judge is ephemeral (no persistent session), making it cheap and simple
- `prompts/` are markdown files loaded at runtime — editable without recompiling, easy to iterate on
- `ui/` is separate from orchestration — can add Telegram/Slack notifications later without touching the flow
- `state.ts` handles all checkpointing — resume logic is isolated from the flow
- `context.ts` owns all token budget and compaction concerns — the orchestrator calls it but doesn't implement the logic
- `metrics.ts` collects and persists quality signals — the orchestrator feeds it events, metrics handles aggregation
- `config.ts` centralizes all defaults — one place to add new CLI flags

## Extensibility

v1 is intentionally scoped, but the architecture supports evolution:

- **New injection points**: The orchestrator loop is stage-based. Adding a stage (e.g., "after code generation") means adding one more iteration to the flow.
- **New notification channels**: `ui/notifications.ts` is the only place that handles notifications. Adding Telegram/Slack means adding an adapter there.
- **Custom Challenger prompts**: Prompts are markdown files. Users can eventually provide their own via `--challenger-prompt <path>`.
- **Multiple Challengers**: The orchestrator can spawn N challengers in parallel. The architecture doesn't assume a single Challenger.
- **New review protocol phases**: The escalating protocol is round-based. Adding a new phase (e.g., "security audit") means adding one more round definition.
- **Blind re-derivation**: Challenger independently writes a full spec from the same topic, then diffs against the Writer's spec. The counter-design sketch in v1 is a lightweight version of this — full re-derivation is a natural escalation.
- **Cross-run analytics**: `metrics.json` files across runs can be aggregated to tune prompts, identify systematic blind spots, and calibrate severity thresholds.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude Code programmatic access
- `commander` — CLI argument parsing
- `chalk` — Terminal colors
- `ajv` — JSON schema validation for inter-agent messages
- Node.js 18+

## Assumptions

- The Claude Agent SDK package name is `@anthropic-ai/claude-agent-sdk` (verified on npm, v0.2.98+). The deprecated `@anthropic-ai/claude-code` package is the CLI, not the SDK.
- Authentication requires `ANTHROPIC_API_KEY` environment variable (or Bedrock/Vertex credentials). The SDK does NOT use the Claude Code CLI's login session.
- `permissionMode: "bypassPermissions"` approves all tools regardless of `allowedTools`. The Challenger's write restriction is enforced via `disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"]`, which is respected even under `bypassPermissions`.
- `settingSources: ["project"]` is required for agents to load the target repo's CLAUDE.md. Without it, the Agent SDK uses a minimal system prompt that does NOT include project-level configuration.
- Bash is excluded from the Challenger's tool set entirely. Read-only codebase exploration is covered by Glob (file discovery), Grep (content search), and Read (file contents). Git history is accessible via Grep on `.git` metadata or the Writer's Bash access.
- Both agents share the same filesystem (the target repo) but run in separate sessions with independent conversation context.
- The structured inter-agent JSON format is enforced via system prompts and validated by the Orchestrator against JSON schemas before routing. Validation failures trigger a retry (max 2) before surfacing to the user.
- The Judge agent runs on Haiku for cost and speed — it does not need Opus-level reasoning for actionability filtering. It is ephemeral (new session per evaluation, no persistence needed).
- `maxBudgetUsd` is set on both Writer and Challenger sessions to prevent runaway costs. The CLI default is $20 total.
- Context will be actively managed — the Orchestrator does not rely on 1M context being sufficient and implements tiered intervention at 150K, 250K, and 500K tokens.

## Deferred to Future Versions

Not rejected — deferred. The architecture supports all of these without rewrites:

- **Notification channels** (Telegram, Slack) — add adapters in `ui/notifications.ts`
- **Custom Challenger prompts** — load user-provided markdown via `--challenger-prompt`
- **Multiple Challengers** — spawn N in parallel, merge findings via Judge
- **Web UI / dashboard** — the orchestrator can emit events to a web frontend
- **CI/CD integration** — run headless with `--quiet` and exit codes
- **Cost tracking dashboard** — aggregate `metrics.json` across runs
- **Blind re-derivation** — full independent spec from Challenger, diff against Writer (v1's counter-design sketch is the lightweight version)
- **Cross-provider Challenger** — support non-Anthropic models for maximum perspective diversity (requires adapter in `agents/challenger.ts`)
- **Cross-run prompt tuning** — use aggregate metrics to automatically adjust Challenger aggressiveness and Judge filter thresholds
