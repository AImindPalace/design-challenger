# Design Challenger — Agent Handoff

## What This Is

A standalone CLI tool that orchestrates two Claude Code agents (Writer + Challenger) to produce higher-quality design specs and implementation plans for any codebase. It replaces the human in the "double-check the design" loop.

## The Problem It Solves

When using Claude Code with superpowers skills (brainstorming → writing-plans → implementation), the design phase has a known weakness: single-pass designs always have gaps. The current workflow requires the human to manually ask "go back and double-check" — every time they do, the agent finds something it missed. The human is acting as a quality gate that could be automated.

The existing superpowers review templates (spec-document-reviewer-prompt.md, plan-document-reviewer-prompt.md) only check document quality (TBDs, placeholders, consistency). They don't challenge the architecture against the actual codebase, integration points, or project-specific gotchas.

## What Was Decided

These decisions were made during brainstorming. Don't re-ask them.

### Architecture: Orchestrator + Writer + Challenger

- **Orchestrator**: A Node.js script (Claude Code SDK) that manages the flow
- **Writer Agent**: A Claude Code process that runs brainstorming, writes specs, writes plans (using superpowers skills)
- **Challenger Agent**: A separate Claude Code process (Opus-level) that independently explores the codebase and adversarially attacks the design
- Both agents have full CLI tool access (file read, grep, git, bash) — same as a human using Claude Code

### Challenger Behavior: Explore First, Then Attack

The Challenger agent:
1. Reads CLAUDE.md (or whatever project instructions exist)
2. Greps the codebase for relevant existing implementations
3. Checks git history for context
4. THEN reviews the spec/plan with full project awareness
5. Is genuinely adversarial — finds gaps, contradictions, missing integrations, forgotten edge cases

This was chosen over injecting CLAUDE.md contents into the prompt (Option A) or a curated summary file (Option B) because it's the most thorough — the agent discovers context the same way a new team member would.

### Three Injection Points

The Challenger participates at three stages, not just at the end:

1. **During brainstorming Q&A** — Challenger explores the codebase in the background while Writer asks the user clarifying questions. When done, Challenger surfaces its own questions/concerns. Writer must address them.

2. **After spec is written** — Challenger reviews the spec against the codebase. Writer fixes gaps. Challenger re-reviews. Must pass to proceed.

3. **After implementation plan is written** — Same review/fix/re-review cycle.

### Notification

The user wants visible notification when the Challenger is working and when it finds issues. Could be terminal output, could be Telegram, but it must be obvious — not silent.

### Project-Agnostic

This is NOT a UT-specific tool. It runs against any repo:
```
design-challenger "add user authentication" --repo /path/to/any/project
```

It reads whatever CLAUDE.md exists in that repo, explores that codebase. No hardcoded project knowledge.

## Technical Approach

### Claude Code SDK

```javascript
import { Claude } from "@anthropic-ai/claude-code";

// Writer session — persistent across the brainstorming flow
const writer = await Claude.query({
  prompt: "Use brainstorming skill to design: <topic>",
  workingDirectory: repoPath,
  options: { model: "opus" }
});

// Challenger session — fresh agent, independent exploration
const challenger = await Claude.query({
  prompt: challengerPrompt,
  workingDirectory: repoPath,
  options: { model: "opus" }
});

// Feed challenger concerns back to writer (same session)
const fix = await Claude.query({
  prompt: `Challenger found these issues:\n${challenger.result}\nAddress every one.`,
  workingDirectory: repoPath,
  sessionId: writer.sessionId
});
```

Key: `sessionId` lets you continue a writer's conversation — the challenger's feedback arrives as if the user typed it.

### Open Questions (For You To Design)

1. **User interaction model** — Does the user participate in the brainstorming Q&A (approve answers, add context), or does the orchestrator handle everything and present the final spec for approval? The original user wants to stay in the loop for clarifying questions.

2. **Termination condition** — How many challenger review cycles before forcing a pass? (Suggest: max 3 rounds, then surface remaining concerns to user for judgment)

3. **Challenger prompt engineering** — The challenger prompt is the most critical piece. It needs to be adversarial without being destructive, project-aware without being project-specific. This needs careful design.

4. **Output format** — Where do specs/plans get saved? Follow superpowers convention (`docs/superpowers/specs/`, `docs/superpowers/plans/`) or let the user configure?

5. **Streaming/UX** — Does the user see the writer/challenger working in real-time, or just get notified at gates?

## Repo Structure (Suggested)

```
design-challenger/
  package.json
  src/
    index.js          # CLI entry point
    orchestrator.js   # Manages writer/challenger flow
    writer.js         # Writer agent session management
    challenger.js     # Challenger agent session management
    prompts/
      challenger-spec-review.md    # Prompt for spec review
      challenger-plan-review.md    # Prompt for plan review
      challenger-exploration.md    # Prompt for initial codebase exploration
  README.md
```

## Context From the Session

- The user (Brandon) uses Claude Code daily with superpowers for UT (autonomous trading system) and other projects
- He's experienced the pattern where every manual re-review catches something new
- He explicitly said "Replace me with an opus agent" — he wants to be removed from the double-check loop, not just assisted
- He does NOT want CLAUDE.md polluted with review instructions — this must be a standalone tool
- He runs Claude Code on Windows (primary dev machine) and SSH into a DGX Spark (Linux)
- The tool should work on both platforms

## Dependencies

- `@anthropic-ai/claude-code` SDK
- Node.js 18+
- Claude Code CLI installed on the machine where this runs
