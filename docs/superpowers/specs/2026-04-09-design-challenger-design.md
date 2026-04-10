# Design Challenger — v1 Spec

## Purpose

A standalone CLI tool that orchestrates two Claude Code agents (Writer + Challenger) to produce higher-quality design specs and implementation plans. It automates the "double-check the design" loop that humans currently do manually.

The human sets the goal and approves the output. Everything in between is autonomous.

## Roles

| Role | Description |
|------|-------------|
| **Writer** | Brainstorms, researches, writes specs and plans. Uses superpowers skills. |
| **Challenger** | Independently explores the codebase and web, then adversarially reviews the Writer's output. |
| **Orchestrator** | Node.js script that manages the Writer-Challenger flow, routes messages, enforces termination. |
| **User** | Sets the design goal. Reviews and approves at gates. Does not participate in the agent loop. |

## Architecture

```
User
  │
  ▼
Orchestrator (Node.js CLI)
  ├── Writer Agent (Claude Code SDK session)
  │     └── Has: file tools, git, bash, web search, superpowers skills
  └── Challenger Agent (Claude Code SDK session)
        └── Has: file tools, git, bash, web search (read-only — no writes)
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

Both the Writer and Challenger maintain **one persistent session each** across the entire run. This is critical:

- The Challenger explores the codebase in Stage 1 and carries that knowledge into Stages 2 and 3. It does not re-explore — it builds on what it already knows.
- Each review round adds to the Challenger's context, making it sharper with each iteration.
- With the 1M context window, the Challenger can accumulate deep knowledge about the codebase, project patterns, git history, and web research across all stages and rounds.
- The Writer similarly accumulates all brainstorming context, Challenger feedback, and user direction across the entire flow.

Both agents get smarter as the run progresses — they never start from zero.

## Flow

### Stage 1: Brainstorming

```
Orchestrator
  ├── Starts Writer: "Brainstorm a design for <topic>"
  │     Writer researches the web + codebase, generates clarifying questions,
  │     answers them itself using project context
  │
  ├── Starts Challenger (parallel): "Explore this codebase for context relevant to <topic>"
  │     Challenger reads CLAUDE.md, greps implementations, checks git history,
  │     researches web for best practices and alternative approaches
  │
  ├── When both finish:
  │     Feeds Challenger's findings into Writer session
  │     Writer addresses all Challenger concerns
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
  ├── Continues Challenger session: "Review this spec against the codebase"
  │     Challenger attacks the spec — already has full codebase context from Stage 1
  │
  ├── Review cycle (max 3 rounds):
  │     Writer addresses CRITICAL + IMPORTANT findings
  │     Challenger re-reviews (with accumulated context from all prior rounds)
  │     Repeat until pass or max rounds
  │
  └── GATE 2 → User sees: spec file path, review summary, any unresolved concerns
        [Approve / Request changes / Abort]
```

### Stage 3: Plan Writing

```
Orchestrator
  ├── Continues Writer session: "Write the implementation plan"
  │     Writer produces detailed plan
  │
  ├── Continues Challenger session: "Review this plan against the codebase"
  │     Same structured review cycle — Challenger now has context from brainstorming + spec review
  │
  └── GATE 3 → User sees: plan file path, review summary
        [Approve / Request changes / Abort]
```

## Challenger Behavior

### Phase 1: Explore

The Challenger independently investigates before reviewing anything:

1. Read CLAUDE.md and any project documentation
2. Grep for existing implementations relevant to the topic
3. Check git history for related past decisions and patterns
4. Web research — best practices, known pitfalls, alternative approaches for the problem domain

### Phase 2: Attack

Every finding is severity-tagged:

| Severity | Meaning | Writer must address? |
|----------|---------|---------------------|
| **CRITICAL** | Design will break something or miss a hard requirement | Yes |
| **IMPORTANT** | Gap or inconsistency that will cause problems | Yes |
| **MINOR** | Improvement that can wait | No (optional) |

The Challenger prompt instructs it to be adversarial but constructive — find real problems, not stylistic nitpicks. It must cite evidence from the codebase or web research to support each finding.

### Termination

- Max 3 review rounds per stage
- A round passes when the Challenger reports no remaining CRITICAL or IMPORTANT findings
- If max rounds reached with unresolved concerns, those are surfaced to the user at the gate with the Challenger's reasoning

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
```

## Output

### File Locations

Default (follows superpowers convention in the target repo):
- Specs: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Plans: `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`

Overridable with `--output-dir`.

### Git

Specs and plans are committed to the target repo at each gate after user approval.

## Terminal UX

### Streaming Output

- **Writer** output: cyan
- **Challenger** output: yellow
- **Orchestrator** status: white/bold
- Phase indicator: `[Spec Review · Round 2/3]`
- Challenger findings printed as discovered with severity badges
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
    orchestrator.ts        # Manages the 3-stage flow
    agents/
      writer.ts            # Writer session management
      challenger.ts        # Challenger session management
    prompts/
      writer-system.md             # Writer system prompt
      challenger-system.md         # Challenger system prompt
      challenger-spec-review.md    # Prompt template for spec review
      challenger-plan-review.md    # Prompt template for plan review
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
- `config.ts` centralizes all defaults — one place to add new CLI flags

## Extensibility

v1 is intentionally scoped, but the architecture supports evolution:

- **New injection points**: The orchestrator loop is stage-based. Adding a stage (e.g., "after code generation") means adding one more iteration to the flow.
- **New notification channels**: `ui/notifications.ts` is the only place that handles notifications. Adding Telegram/Slack means adding an adapter there.
- **Custom Challenger prompts**: Prompts are markdown files. Users can eventually provide their own via `--challenger-prompt <path>`.
- **Multiple Challengers**: The orchestrator can spawn N challengers in parallel. The architecture doesn't assume a single Challenger.
- **Different models per agent**: Already supported via config. Writer and Challenger can use different models.

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

## Deferred to Future Versions

Not rejected — deferred. The architecture supports all of these without rewrites:

- **Notification channels** (Telegram, Slack) — add adapters in `ui/notifications.ts`
- **Custom Challenger prompts** — load user-provided markdown via `--challenger-prompt`
- **Multiple Challengers** — spawn N in parallel, merge findings
- **Web UI / dashboard** — the orchestrator can emit events to a web frontend
- **CI/CD integration** — run headless with `--quiet` and exit codes
- **Cost tracking** — aggregate SDK usage data across agents
