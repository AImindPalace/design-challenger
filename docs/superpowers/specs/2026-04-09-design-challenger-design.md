# Design Challenger — v1 Spec

## Purpose

A standalone CLI tool that orchestrates two Claude Code agents (Writer + Challenger) to produce higher-quality design specs and implementation plans. It automates the "double-check the design" loop that humans currently do manually.

The human sets the goal and approves the output. Everything in between is autonomous.

## Roles

| Role | Description |
|------|-------------|
| **Writer** | Brainstorms, researches, writes specs and plans. Self-answers clarifying questions from codebase context. |
| **Challenger** | Independently explores the codebase and web, extracts assumptions, then rigorously tests them against evidence. |
| **Orchestrator** | Node.js script that manages the Writer-Challenger flow, routes structured messages, enforces termination, captures decisions. |
| **User** | Sets the design goal. Reviews and approves at gates. Does not participate in the agent loop. |

## Architecture

```
User
  │
  ▼
Orchestrator (Node.js CLI)
  ├── Writer Agent (Claude Code SDK session — persistent)
  │     └── Has: file tools, git, bash, web search
  ├── Challenger Agent (Claude Code SDK session — persistent)
  │     └── Has: file tools, git, bash, web search (read-only — no writes)
  └── State Manager
        └── Checkpoints run state for resume, captures DDL
```

Both agents run against the **target repo** (any codebase). The Orchestrator runs from the design-challenger installation; agents run with `cwd` set to the target repo.

### SDK Integration

Uses `@anthropic-ai/claude-agent-sdk`. Authentication uses the host machine's existing Claude Code login — no separate API keys or OAuth.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Writer session — persistent across the entire flow
const writerSession = query({
  prompt: writerPrompt,
  options: {
    cwd: targetRepoPath,
    model: "claude-opus-4-6",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    systemPrompt: writerSystemPrompt,
  }
});

// Challenger session — persistent across the entire flow (same as Writer)
const challengerSession = query({
  prompt: challengerPrompt,
  options: {
    cwd: targetRepoPath,
    model: "claude-opus-4-6",
    allowedTools: ["Read", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    systemPrompt: challengerSystemPrompt,
  }
});
```

Session continuation uses the `resume` option with the session ID captured from the `system` init message.

### Session Persistence

Both the Writer and Challenger maintain **one persistent session each** across the entire run:

- The Challenger explores the codebase in Stage 1 and carries that knowledge into Stages 2 and 3. It does not re-explore — it builds on what it already knows.
- Each review round adds to the Challenger's context, making it sharper with each iteration.
- With the 1M context window, the Challenger can accumulate deep knowledge about the codebase, project patterns, git history, and web research across all stages and rounds.
- The Writer similarly accumulates all brainstorming context, Challenger feedback, and user direction across the entire flow.

Both agents get smarter as the run progresses — they never start from zero.

### System Prompt Design

The Writer and Challenger system prompts embed their methodology directly — no dependency on external plugins or skills being installed on the target machine.

**Writer system prompt includes:**
- Brainstorming methodology (explore context, generate questions, propose approaches)
- Spec-writing structure (architecture, components, data flow, error handling)
- Plan-writing structure (ordered steps, dependencies, verification)
- Explicit instruction to self-answer clarifying questions using CLAUDE.md and codebase context rather than waiting for human input
- Instruction to output structured artifacts that the Orchestrator can parse

**Challenger system prompt includes:**
- The full escalating review protocol (see Challenger Behavior below)
- Instruction to output structured findings in the inter-agent format
- Read-only constraint: "You explore and analyze. You do not modify any files."

## Flow

### Stage 1: Brainstorming

```
Orchestrator
  ├── Starts Writer: "Brainstorm a design for <topic>"
  │     Writer researches the web + codebase, generates clarifying questions,
  │     answers them itself using project context (CLAUDE.md, existing code, git history)
  │
  ├── Starts Challenger (parallel): "Explore this codebase for context relevant to <topic>"
  │     Challenger reads CLAUDE.md, greps implementations, checks git history,
  │     researches web for best practices and alternative approaches
  │
  ├── When both finish:
  │     Orchestrator feeds Challenger's findings to Writer as structured input
  │     Writer addresses all Challenger concerns
  │     Orchestrator captures decisions to DDL
  │
  └── GATE 1 → User sees: brainstorming summary, key decisions, Challenger findings
        [Approve / Request changes / Abort]
        "Request changes" → User provides direction, Writer resumes with that input
```

### Stage 2: Spec Writing

```
Orchestrator
  ├── Continues Writer session: "Write the design spec"
  │     Writer produces full spec document
  │
  ├── Continues Challenger session: "Review this spec"
  │     Challenger runs the escalating review protocol (see below)
  │     Challenger re-reads the ARTIFACT ITSELF each round, not the Writer's explanation
  │
  ├── Review cycle (max 3 rounds):
  │     Round 1: Hypothesis testing — extract assumptions, falsify against evidence
  │     Round 2: Skeptical verification — verify fixes, find what was missed
  │     Round 3: Pre-mortem — imagine failure, trace scenarios through the design
  │     Orchestrator tells Challenger which findings were addressed between rounds
  │     Orchestrator captures all decisions to DDL
  │     Exit early if no remaining CRITICAL or IMPORTANT findings
  │
  └── GATE 2 → User sees: spec file path, review summary, assumption list, any unresolved concerns
        [Approve / Request changes / Abort]
```

### Stage 3: Plan Writing

```
Orchestrator
  ├── Continues Writer session: "Write the implementation plan"
  │     Writer produces detailed plan
  │
  ├── Continues Challenger session: "Review this plan"
  │     Same escalating review protocol
  │     Challenger now has context from brainstorming + spec review
  │     Orchestrator captures decisions to DDL
  │
  └── GATE 3 → User sees: plan file path, review summary
        [Approve / Request changes / Abort]
```

## Challenger Behavior

### Phase 1: Explore (Stage 1 only)

The Challenger independently investigates before reviewing anything:

1. Read CLAUDE.md and any project documentation
2. Grep for existing implementations relevant to the topic
3. Check git history for related past decisions and patterns
4. Web research — best practices, known pitfalls, alternative approaches for the problem domain

### Phase 2: Escalating Review Protocol

The Challenger's review intensifies across rounds. Each round attacks from a different cognitive angle to systematically eliminate blind spots.

#### Round 1 — Hypothesis Tester

1. **Steelman**: First, demonstrate understanding of the design by restating its strongest form. "The design proposes X because Y, which addresses Z." This forces deep engagement before critique.

2. **Extract assumptions**: List every implicit assumption as a numbered, testable hypothesis:
   ```
   ASSUMPTION #1: The existing auth middleware supports JWT tokens
     Source: Spec section 3, line "integrate with current auth"
     Testable by: Checking src/middleware/auth.ts for JWT handling
   
   ASSUMPTION #7: The database handles 500 concurrent writes
     Source: Spec section 5, batch processing design
     Testable by: Checking DB config, connection pool limits
   ```

3. **Falsify**: Attempt to disprove each assumption against the codebase and web research. Every finding must cite specific evidence (file paths, line numbers, git commits, URLs).

#### Round 2 — Skeptical Verifier

Prompt framing: *"The Writer claims to have fixed everything. Don't take their word for it — re-read the updated artifact and verify the actual changes. Also: what did you miss in Round 1? You are NOT bound by your previous assessments."*

- Re-read the spec/plan file directly (not the Writer's explanation of changes)
- Verify each claimed fix by checking the actual text
- Revisit assumptions — were they truly addressed or just hand-waved?
- Look for new issues introduced by the fixes

#### Round 3 — Pre-mortem

Prompt framing: *"It's 6 months from now. This implementation failed in production. What went wrong?"*

- Generate 3-5 specific, concrete failure scenarios
- Trace each scenario through the design step by step
- Identify where the design breaks under each scenario
- Focus on integration failures, operational issues, and edge cases that line-by-line review misses

### Findings Format

Every Challenger finding follows this structure:

```
FINDING: <one-line summary>
SEVERITY: CRITICAL | IMPORTANT | MINOR
ASSUMPTION: #N (if tied to a specific assumption)
EVIDENCE:
  - <file path>:<line number> — <what it shows>
  - <URL> — <what it shows>
  - <git commit hash> — <what it shows>
RECOMMENDATION: <specific action the Writer should take>
```

### Severity Levels

| Severity | Meaning | Writer must address? |
|----------|---------|---------------------|
| **CRITICAL** | Design will break something or miss a hard requirement | Yes |
| **IMPORTANT** | Gap or inconsistency that will cause problems | Yes |
| **MINOR** | Improvement that can wait | No (optional) |

### Termination

- Max 3 review rounds per stage (one round per protocol phase)
- A stage passes early if the Challenger reports no remaining CRITICAL or IMPORTANT findings
- If max rounds reached with unresolved concerns, those are surfaced to the user at the gate with the Challenger's reasoning and evidence

## Inter-Agent Message Format

The Orchestrator routes structured messages between agents, not raw text.

### Challenger → Writer (via Orchestrator)

```json
{
  "round": 1,
  "protocol_phase": "hypothesis_tester",
  "steelman": "The design proposes...",
  "assumptions": [
    { "id": 1, "text": "...", "source": "spec section 3", "status": "falsified", "evidence": "..." },
    { "id": 2, "text": "...", "source": "spec section 5", "status": "verified", "evidence": "..." }
  ],
  "findings": [
    { "summary": "...", "severity": "CRITICAL", "assumption_id": 1, "evidence": [...], "recommendation": "..." }
  ],
  "pass": false
}
```

### Orchestrator → Challenger (between rounds)

```json
{
  "round": 2,
  "protocol_phase": "skeptical_verifier",
  "previous_findings_addressed": [1, 3, 5],
  "previous_findings_deferred": [2],
  "updated_artifact_path": "docs/superpowers/specs/2026-04-09-websocket-design.md",
  "instruction": "Re-read the artifact. Verify fixes. Find what you missed."
}
```

### Orchestrator → Writer (forwarding Challenger findings)

```json
{
  "challenger_round": 1,
  "findings_to_address": [
    { "id": 1, "summary": "...", "severity": "CRITICAL", "evidence": "...", "recommendation": "..." }
  ],
  "findings_minor": [
    { "id": 4, "summary": "...", "severity": "MINOR" }
  ],
  "instruction": "Address all CRITICAL and IMPORTANT findings. Update the spec file. MINOR findings are optional."
}
```

## Design Decision Log (DDL)

The Orchestrator captures every significant decision from the Writer-Challenger debate into a `design-decisions.md` artifact:

```markdown
# Design Decisions — <topic>

## Decision 1: WebSocket over SSE
- **Context**: Spec requires bidirectional real-time communication
- **Writer proposed**: WebSocket for full-duplex messaging
- **Challenger concern**: SSE is simpler and sufficient for server→client push (cited MDN docs)
- **Resolution**: WebSocket chosen — requirement X needs client→server push during active sessions
- **Evidence**: src/api/realtime.ts:42 already uses WebSocket patterns
- **Round**: Spec Review, Round 1

## Decision 2: Connection pool size
- **Context**: Batch processing design implies high concurrent DB writes
- **Writer proposed**: Default pool of 10 connections
- **Challenger concern**: ASSUMPTION #7 falsified — current pool is 5, and pgbouncer config caps at 20
- **Resolution**: Writer updated to use dynamic pool sizing based on pgbouncer limits
- **Evidence**: config/database.yml:18, infrastructure/pgbouncer.ini:3
- **Round**: Spec Review, Round 2
```

This is generated automatically from the structured inter-agent messages. The Orchestrator extracts decisions whenever:
- A Challenger finding causes the Writer to change the design
- The Writer explicitly rejects a Challenger concern with reasoning
- The user provides direction at a gate

The DDL is saved alongside the spec and plan as a first-class output artifact.

## Run State & Resume

### Checkpointing

The Orchestrator saves run state after every significant event:

```
.design-challenger/
  runs/
    <run-id>/
      state.json          # Current stage, round, session IDs, gate outcomes
      messages/           # Structured inter-agent messages (for DDL generation)
      artifacts/          # Copies of spec/plan at each checkpoint
```

State is saved to the **target repo** under `.design-challenger/` (gitignored).

### Resume

If a run fails (network drop, token expiry, crash), resume from the last checkpoint:

```bash
design-challenger --resume <run-id>
```

The Orchestrator restores session IDs and resumes the agents from where they left off using the SDK's `resume` option.

## Run Summary

After all gates pass (or on abort), the Orchestrator generates `design-run-summary.md`:

```markdown
# Run Summary — <topic>
Date: 2026-04-09
Duration: 14m 32s

## Stage 1: Brainstorming
- Writer: explored 12 files, 3 web searches
- Challenger: explored 28 files, 5 web searches, surfaced 4 concerns
- Gate: Approved

## Stage 2: Spec Review
- Round 1 (Hypothesis Tester): 8 assumptions extracted, 2 falsified → 3 CRITICAL, 1 IMPORTANT
- Round 2 (Skeptical Verifier): 1 fix inadequate, 1 new IMPORTANT found
- Round 3: Not needed — passed after Round 2
- Gate: Approved

## Stage 3: Plan Review
- Round 1 (Hypothesis Tester): 5 assumptions, all verified → 0 CRITICAL, 2 IMPORTANT
- Round 2 (Skeptical Verifier): All addressed
- Gate: Approved

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
  --repo <path>          Target repository (default: current directory)
  --model <name>         Model for both agents (default: claude-opus-4-6)
  --max-rounds <n>       Max Challenger cycles per stage (default: 3)
  --output-dir <path>    Override output location for specs/plans
  --quiet                Only show gate notifications, suppress streaming
  --skip-brainstorm      Skip brainstorming, start from spec writing
  --spec <path>          Provide existing spec, skip to plan writing
  --resume <run-id>      Resume a failed/interrupted run
```

## Output Artifacts

Every run produces up to 4 artifacts in the target repo:

| Artifact | Default Location | Description |
|----------|-----------------|-------------|
| **Spec** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | The design document |
| **Plan** | `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md` | The implementation plan |
| **DDL** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-decisions.md` | Why every decision was made |
| **Summary** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-run-summary.md` | Process record |

All overridable with `--output-dir`. Auto-committed to git at each gate after user approval.

## Terminal UX

### Streaming Output

- **Writer** output: cyan
- **Challenger** output: yellow
- **Orchestrator** status: white/bold
- Phase indicator: `[Spec Review · Round 2/3 · Skeptical Verifier]`
- Challenger findings printed as discovered with severity badges
- Assumption list displayed when extracted
- Gates are visually distinct — bordered, with clear action prompts

### Quiet Mode

`--quiet` suppresses streaming and only shows:
- Phase transitions
- Gate summaries with approval prompts
- Errors

## Project Structure

```
design-challenger/
  package.json
  tsconfig.json
  src/
    cli.ts                 # CLI entry point, argument parsing
    orchestrator.ts        # Manages the 3-stage flow, decision capture
    state.ts               # Run checkpointing and resume
    agents/
      writer.ts            # Writer session management
      challenger.ts        # Challenger session management
      types.ts             # Inter-agent message types
    prompts/
      writer-system.md             # Writer system prompt (embeds methodology)
      challenger-system.md         # Challenger system prompt (embeds escalating protocol)
      challenger-spec-review.md    # Prompt template for spec review rounds
      challenger-plan-review.md    # Prompt template for plan review rounds
      challenger-exploration.md    # Prompt template for codebase exploration
    ui/
      terminal.ts          # Color-coded output, gate rendering
      notifications.ts     # Gate notification handling
    config.ts              # CLI options, defaults
    types.ts               # Shared TypeScript types
```

### Why This Structure

- `agents/` encapsulates all SDK interaction — swapping SDK versions or adding agent types doesn't touch orchestration logic
- `prompts/` are markdown files loaded at runtime — editable without recompiling, easy to iterate on
- `ui/` is separate from orchestration — can add Telegram/Slack notifications later without touching the flow
- `state.ts` handles all checkpointing — resume logic is isolated from the flow
- `config.ts` centralizes all defaults — one place to add new CLI flags

## Extensibility

v1 is intentionally scoped, but the architecture supports evolution:

- **New injection points**: The orchestrator loop is stage-based. Adding a stage (e.g., "after code generation") means adding one more iteration to the flow.
- **New notification channels**: `ui/notifications.ts` is the only place that handles notifications. Adding Telegram/Slack means adding an adapter there.
- **Custom Challenger prompts**: Prompts are markdown files. Users can eventually provide their own via `--challenger-prompt <path>`.
- **Multiple Challengers**: The orchestrator can spawn N challengers in parallel. The architecture doesn't assume a single Challenger.
- **Different models per agent**: Already supported via config. Writer and Challenger can use different models.
- **New review protocol phases**: The escalating protocol is round-based. Adding a new phase (e.g., "security audit") means adding one more round definition.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude Code programmatic access
- `commander` — CLI argument parsing
- `chalk` — Terminal colors
- Node.js 18+
- Claude Code CLI installed on the host machine

## Assumptions

- The Claude Agent SDK package name and API are based on current documentation. Will be verified during implementation setup. If the package is `@anthropic-ai/claude-code` instead, the API shape (query function, async generator, session resume) is the same.
- `permissionMode: "bypassPermissions"` allows fully autonomous operation without user approval prompts for tool use.
- The Challenger's read-only constraint is enforced by limiting its `allowedTools` (no Write, Edit) and its system prompt. Bash is included for read-only commands (git log, npm list, etc.) — the system prompt instructs it not to modify anything.
- Both agents share the same filesystem (the target repo) but run in separate sessions with independent conversation context.
- The structured inter-agent JSON format is enforced via system prompts instructing agents to output in the required format. The Orchestrator parses the agent's final text output.

## Deferred to Future Versions

Not rejected — deferred. The architecture supports all of these without rewrites:

- **Notification channels** (Telegram, Slack) — add adapters in `ui/notifications.ts`
- **Custom Challenger prompts** — load user-provided markdown via `--challenger-prompt`
- **Multiple Challengers** — spawn N in parallel, merge findings
- **Web UI / dashboard** — the orchestrator can emit events to a web frontend
- **CI/CD integration** — run headless with `--quiet` and exit codes
- **Cost tracking** — aggregate SDK usage data across agents
- **Dialectical inquiry** — Challenger produces a counter-design, Writer must justify or incorporate
- **Blind re-derivation** — Challenger independently designs, then diffs against Writer's design
