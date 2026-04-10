# design-challenger

**CLI that orchestrates adversarial AI agents to stress-test your design specs before you write code.**

> **Status**: Spec complete. Implementation starting.

## The Problem

Single-pass AI designs always have gaps. Every time you manually ask an agent to "go back and double-check," it finds something it missed. You're acting as a quality gate that could be automated.

Design Challenger replaces you in that loop. You set the goal, approve the output. Everything in between is autonomous.

## How It Works

Three agents with distinct roles debate your design through an escalating review protocol:

```
You: "add WebSocket support"
          |
          v
    Orchestrator
     /    |    \
Writer  Challenger  Judge
  |       |          |
  |   Explores the   |
  |   codebase,      |
  |   produces a     Filters
  |   counter-design,findings
  |   then attacks   for
  |   assumptions    signal
  |   with evidence  |
  |       |          |
  |<------+----------+
  |
  Fixes gaps, writes final spec
          |
          v
    You approve (or redirect)
```

- **Writer** — brainstorms, researches, writes specs and plans
- **Challenger** — independently explores the codebase, produces an alternative design, then adversarially tests assumptions with cited evidence
- **Judge** — filters Challenger findings for actionability so the Writer isn't drowning in noise

The Challenger escalates across three cognitive frames per review stage:
1. **Counter-Design + Hypothesis Testing** — sketch what you'd build instead, extract assumptions, falsify against the codebase
2. **Skeptical Verification** — re-read the artifact, verify fixes actually landed, find what was missed
3. **Pre-mortem** — imagine this failed in production 6 months from now, trace the failure through the design

## Planned Usage

```bash
# Review a design for any repo
design-challenger "add user authentication" --repo /path/to/project

# Use different models for perspective diversity
design-challenger "migrate to event sourcing" \
  --writer-model claude-sonnet-4-6 \
  --challenger-model claude-opus-4-6

# Pick up where you left off
design-challenger --resume <run-id>
```

Every run produces four artifacts:
- **Design spec** — the architecture document
- **Implementation plan** — ordered steps with dependencies
- **Design Decision Log** — why every decision was made, with evidence from the debate
- **Run summary** — quality metrics, cost, what the Challenger found

## Key Design Choices

- **Dialectical inquiry, not just critique** — the Challenger proposes an alternative design before attacking. Research shows assigned devil's advocates produce weaker challenges than agents with their own position.
- **Judge as noise filter** — HubSpot found this was "the single most important factor" in their AI code review agent. Without it, engineers dismissed all feedback.
- **Heterogeneous models recommended** — same-model debate amplifies shared biases. Using different models for Writer vs Challenger introduces genuine perspective diversity.
- **Active context management** — doesn't trust 1M context to be enough. Tracks token budgets, masks stale observations, preserves critical evidence through compaction.

## Roadmap

- [x] v1 spec — architecture, flow, Challenger protocol
- [x] v2 spec — Judge agent, dialectical inquiry, context management, quality metrics
- [ ] Core implementation — orchestrator, agents, prompts
- [ ] CLI and terminal UX
- [ ] Resume and checkpointing
- [ ] First real-world test runs

## Spec

Full design spec: [`docs/superpowers/specs/2026-04-09-design-challenger-design.md`](docs/superpowers/specs/2026-04-09-design-challenger-design.md)

## Built With

- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — programmatic access to Claude Code agents
- TypeScript / Node.js

## License

MIT
