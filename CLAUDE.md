# Design Challenger

## Project Status (as of 2026-04-11)

This project is a Claude Code plugin that automatically runs adversarial design review whenever the user does design work in any project. It was originally scoped as a standalone TypeScript CLI; that implementation is complete in `src/` but **archived**, not deployed. The active path is the plugin.

**Active artifacts:**
- **Plugin code**: `plugin/` (being built per the implementation plan below)
- **Active spec**: `docs/superpowers/specs/2026-04-11-design-challenger-skill-design.md`
- **Active plan**: `docs/superpowers/plans/2026-04-11-design-challenger-skill-plan.md`
- **Install notes** (populated during Task 1): `plugin/INSTALL-NOTES.md`

**Archived (reference only, do NOT modify or extend):**
- `src/` — TypeScript CLI implementation (Steps 1-13 of the old plan)
- `docs/superpowers/specs/2026-04-09-design-challenger-design.md` — CLI spec v3
- `docs/superpowers/plans/2026-04-09-design-challenger-plan.md` — CLI plan (15 steps)
- `HANDOFF.md` — original design decisions
- `package.json`, `tsconfig.json`, `node_modules/`, `dist/` — CLI build artifacts

The CLI code is preserved because it documents the design decisions that informed the plugin architecture. Don't run it, don't modify it, don't reference it from the plugin.

## What the Plugin Does

Three read-only Challenger subagents stress-test your designs before they're finalized:
- **Counter-Design** (Round 1) — independent alternative architecture + assumption falsification
- **Skeptical** (Round 2) — re-reads the written artifact, verifies claimed fixes landed
- **Pre-mortem** (Round 3) — imagines 6-month failure scenarios

Two helper subagents:
- **Judge** — filters findings for actionability (Sonnet)
- **Verifier** — verifies external claims against docs (Sonnet)

Composes with `superpowers:brainstorming` and `superpowers:writing-plans`. Auto-activates on design intent; no slash command needed.

## Plugin Architecture

```
plugin/
  .claude-plugin/
    plugin.json                    # Plugin manifest
  skills/
    adversarial-review.md          # Mode A: full flow with adversarial review
    challenge-existing-spec.md     # Mode B: review an existing spec
    challenge-existing-plan.md     # Mode B: review an existing plan
  agents/
    counter-design.md              # Round 1 subagent (opus, read-only)
    skeptical.md                   # Round 2 subagent (opus, read-only)
    pre-mortem.md                  # Round 3 subagent (opus, read-only)
    judge.md                       # Actionability filter (sonnet)
    verifier.md                    # External claim verifier (sonnet)
  README.md
  INSTALL-NOTES.md                 # Empirical test results + install command
```

Three-stage flow: Brainstorming (with parallel counter-design) → Spec review cycle (up to 3 rounds) → Plan review cycle (up to 2 rounds). User gates between stages. Auto-apply IMPORTANT/MINOR findings, consult user on CRITICAL and architecture-affecting IMPORTANT.

## Tech Stack

- Pure markdown + YAML frontmatter (no compiled code, no npm install)
- Claude Code plugin system
- Requires: `superpowers >= 5.0` plugin (hard dependency)

## Plugin Conventions

- Subagent invocation format: `design-challenger:<agent-name>` (plugin-name prefix, bare agent name in frontmatter)
- Model values use attested plugin values: `opus`, `sonnet`, `haiku`, `inherit` (NOT literal model IDs like `claude-opus-4-6`)
- Plugin manifest lives at `.claude-plugin/plugin.json`
- Subagents ship with `tools:` frontmatter field for read-only enforcement (enforcement under plugins is **empirically unverified** — Task 5 in the plan validates this)

## Implementation Plan Progress

The plan has 18 tasks. Current progress:

- [ ] Task 1: Research plugin install mechanism
- [ ] Task 2: Plugin scaffold — directories and manifest
- [ ] Task 3: Agent — judge.md
- [ ] Task 4: Agent — counter-design.md
- [ ] Task 5: Empirical test — tools: enforcement (blocking)
- [ ] Task 6: Agent — skeptical.md
- [ ] Task 7: Agent — pre-mortem.md
- [ ] Task 8: Agent — verifier.md
- [ ] Task 9: Empirical test — parallel subagent invocation
- [ ] Task 10: Skill — adversarial-review.md (biggest file)
- [ ] Task 11: Skill — challenge-existing-spec.md
- [ ] Task 12: Skill — challenge-existing-plan.md
- [ ] Task 13: Empirical test — skill auto-activation
- [ ] Task 14: End-to-end test — Mode A flow
- [ ] Task 15: End-to-end test — Mode B flow
- [ ] Task 16: README.md
- [ ] Task 17: Update CLAUDE.md and memory (this file included)
- [ ] Task 18: Final validation and tag v0.1.0

## Key Design Decisions (Do Not Re-ask)

These were decided during brainstorming + adversarial review. Read the active spec for full rationale.

1. **Plugin architecture over CLI** — no API key, auto-activates, composes with superpowers, drops ~1500 lines of plumbing
2. **Five plugin-defined subagents** — enforced read-only via `tools:` field (pending empirical verification)
3. **Auto-activation via skill descriptions** — no slash commands
4. **Mode A + Mode B** — full flow + targeted review on existing artifacts
5. **Stage 3 drops counter-design** — architecture locked at Gate 2, only skeptical + pre-mortem on plans
6. **Consult on CRITICAL + IMPORTANT-that-touches-architecture** — auto-apply everything else
7. **Finding Checklist Gate as explicit flow step** — not TodoWrite hope, mechanical disposition block
8. **Evidence Index on disk** — survives native compaction's lossy behavior on file:line refs
9. **Hard dependency on superpowers >= 5.0** — no graceful degradation
10. **Opus for Challengers, Sonnet for Judge + Verifier** — per-subagent `model:` field

## How to Continue Work

Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to work through the 18 tasks in `docs/superpowers/plans/2026-04-11-design-challenger-skill-plan.md`. The plan is self-contained — each task has exact file paths, complete content, and verification steps.

Tasks 5, 9, 13, 14, 15, and 18.4 are **empirical tests that require a human observer** in fresh Claude Code sessions. Pause and hand off to the user at those tasks.

## Archived CLI Reference (Do Not Modify)

The TypeScript CLI in `src/` was a full implementation built against the Claude Agent SDK. It documents the protocol in working code but is not deployed because:
- Plugin architecture is simpler and composes with superpowers
- Plugin uses Claude Code's auth (no API key management)
- Plugin subagents give enforced read-only via `tools:` field (vs. SDK's `disallowedTools`)

If you need to understand a specific piece of the adversarial review protocol, the CLI's code and prompts may help as reference. But all new work happens in `plugin/`.
