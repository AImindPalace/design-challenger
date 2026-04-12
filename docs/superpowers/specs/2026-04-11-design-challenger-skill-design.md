# Design Challenger Skill — v1 Spec

**Supersedes**: `2026-04-09-design-challenger-design.md` (CLI-based v1 — architecturally sound but over-engineered for the problem)

## Purpose

A Claude Code plugin that automatically engages adversarial design review whenever you do design work in any project. You set the goal, approve big calls at gates. Everything in between runs as an enhanced version of your existing superpowers workflow.

The plugin composes with `superpowers:brainstorming` and `superpowers:writing-plans` — it doesn't replace them. You still use your normal design flow; the plugin layers Challenger review on top automatically.

**Requires**: `superpowers` plugin installed. If superpowers is not available, the plugin gracefully degrades — skills still activate but the orchestrator has to handle spec/plan writing itself rather than delegating to superpowers. v1 assumes superpowers is present (this matches your existing setup).

## Why This Replaces the CLI

The CLI v1 was designed before plugin-defined subagents matured. Reassessing against current Claude Code capabilities:

| Concern | CLI v1 | Plugin v1 |
|---------|--------|-----------|
| Authentication | Requires `ANTHROPIC_API_KEY` | Uses Claude Code's existing auth |
| Read-only enforcement on Challenger | `disallowedTools` SDK option | Plugin subagent `tools:` field (enforced) |
| Distribution | `npm install` + build step | Plugin install once, works everywhere |
| Activation | Manual CLI invocation | Auto-loads via skill description matching |
| Session management | Custom checkpointing + resume | Claude Code's conversation persistence |
| Context management | Custom 150K/250K/500K thresholds | Claude Code's native compaction |
| Code footprint | ~1500 lines TypeScript | ~500 lines markdown (skills + subagent defs) |

The CLI codebase is preserved in `src/` for reference but not deployed.

## Roles

| Role | Implementation | Model |
|------|----------------|-------|
| **User** | You | — |
| **Writer + Orchestrator** | Claude Code (main session) | User's default (typically Opus) |
| **Counter-Design Challenger** | Plugin subagent, round 1 | `claude-opus-4-6` |
| **Skeptical Challenger** | Plugin subagent, round 2 | `claude-opus-4-6` |
| **Pre-mortem Challenger** | Plugin subagent, round 3 | `claude-opus-4-6` |
| **Judge** | Plugin subagent, ephemeral | `claude-sonnet-4-6` |
| **Verifier** | Plugin subagent, ephemeral | `claude-sonnet-4-6` |

Claude Code is both orchestrator and Writer — it brainstorms, writes specs/plans, addresses findings, spawns subagents at the right moments. No separate Writer session.

## Plugin Structure

```
design-challenger/
  plugin.json
  skills/
    adversarial-review.md           # Auto-loads on design work (primary flow)
    challenge-existing-spec.md      # Auto-loads when reviewing an existing spec
    challenge-existing-plan.md      # Auto-loads when reviewing an existing plan
  agents/
    counter-design.md               # Round 1: counter-design + hypothesis testing
    skeptical.md                    # Round 2: skeptical verification
    pre-mortem.md                   # Round 3: pre-mortem failure analysis
    judge.md                        # Actionability filter
    verifier.md                     # External evidence verification
  README.md
```

## Activation

Skills auto-load based on description matching, same mechanism as `superpowers:brainstorming`.

**`adversarial-review.md`** — description: "Use during design work, writing specs, planning implementations. Runs adversarial review on designs before finalizing them. Loads alongside superpowers:brainstorming and superpowers:writing-plans."

**`challenge-existing-spec.md`** — description: "Use when reviewing an existing spec, design document, or proposal for gaps, issues, or hidden assumptions."

**`challenge-existing-plan.md`** — description: "Use when reviewing an existing implementation plan for completeness, missing dependencies, or operational gaps."

You never type a command. The skill loads because of what you're doing.

## Flow

Three stages, each with a review cycle. Each review cycle has up to 3 rounds (counter-design → skeptical → pre-mortem), with early termination if no remaining findings.

### Mode A: Full adversarial design (new feature)

User: *"Let's design user authentication for this app."*

#### Stage 1: Brainstorming

1. `superpowers:brainstorming` starts normally — Claude Code explores context, asks clarifying questions, proposes approaches.
2. **In parallel**, Claude Code spawns the `counter-design` subagent with the topic and codebase access. It independently explores the codebase (read-only) and produces an alternative approach + extracted assumptions + initial findings.
3. When both finish, Claude Code runs the `judge` subagent on the Challenger's findings. Judge filters noise, consolidates duplicates.
4. For findings with external evidence, Claude Code spawns `verifier` subagents per claim. Refuted claims dropped; unverifiable claims flagged.
5. Claude Code addresses findings per the auto-apply vs. consult rules (below). Incremental DDL writes.
6. `superpowers:brainstorming` writes the spec to `docs/superpowers/specs/<date>-<topic>-design.md` (standard brainstorming behavior, unchanged).
7. **GATE 1** — Claude Code presents: brainstorm summary, counter-design alternative, findings addressed, any CRITICAL items needing user input, and the spec file path. User responds: approve / request changes / abort.

#### Stage 2: Spec Review Cycle

The spec exists. Now run up to 3 rounds of adversarial review *against the written spec*.

8. **Pre-review assumption verification** — Claude Code parses the spec's `## Assumptions` section for items tagged `[external]`. Spawns `verifier` for each. Refuted assumptions fixed before Challenger sees the spec.
9. **Round 1 (Counter-Design + Hypothesis Tester)** — Claude Code spawns `counter-design` subagent pointing at the spec. This round is *different* from Stage 1's parallel exploration: now the subagent sees the written artifact, produces its own counter-design specifically against the spec's architecture, extracts assumptions from the spec, and falsifies them.
10. Judge filter + Verifier + Address findings (as in Stage 1 steps 3–5).
11. **Round 2 (Skeptical Verifier)** — Claude Code spawns `skeptical` subagent with the list of findings marked addressed/rejected from Round 1. Subagent re-reads the actual spec file, verifies claimed fixes landed, looks for new issues.
12. Judge filter + Verifier + Address findings. **Early termination** if no remaining findings.
13. **Round 3 (Pre-mortem)** — Claude Code spawns `pre-mortem` subagent. Imagines 6-month failure scenarios, traces each through the spec.
14. Judge filter + Verifier + Address findings.
15. **GATE 2** — Claude Code presents: spec file path, rounds run, findings summary, metrics snapshot, unresolved concerns. User responds: approve / request changes / abort.

#### Stage 3: Plan Review Cycle

16. `superpowers:writing-plans` writes the implementation plan to `docs/superpowers/plans/<date>-<topic>-plan.md` (standard behavior, unchanged).
17. **Pre-review assumption verification** — same as Stage 2 step 8, applied to the plan.
18. **Rounds 1–3** — same structure as Stage 2 steps 9–14, but subagents review the plan. **Key difference**: findings with `upstream_issue: true` indicate bugs in the spec (not the plan). Claude Code fixes both documents.
19. **GATE 3** — Claude Code presents: plan file path, rounds run, findings summary, any upstream fixes applied to the spec. User responds: approve / request changes / abort.

#### Finalize

20. Claude Code writes the full DDL (`<date>-<topic>-decisions.md`) and run summary (`<date>-<topic>-run-summary.md`).
21. Auto-commits artifacts with message `design-challenger: <stage> approved for <topic>`.

### Total Challenger invocations per full run (worst case)

- Counter-design subagent: 3× (brainstorming exploration, spec Round 1, plan Round 1)
- Skeptical subagent: 2× (spec Round 2, plan Round 2)
- Pre-mortem subagent: 2× (spec Round 3, plan Round 3)
- Judge: up to 7× (one per Challenger round)
- Verifier: variable (once per external claim, typically 2–10× per stage)

Early termination on "no remaining findings" typically reduces this significantly. Plan's review plan step surfaces estimation tactics for expected token usage.

### Mode B: Challenge existing artifact

User: *"Review this spec: `docs/superpowers/specs/2026-04-11-auth-design.md`"*

`challenge-existing-spec.md` skill loads. Claude Code runs steps 8–13 against the existing spec (no brainstorming, no spec writing). Outputs findings + DDL + run summary. Artifact updated in place.

Same for `challenge-existing-plan.md` against implementation plans.

## Subagent Specifications

Each subagent is defined in a markdown file with frontmatter specifying model and tools.

### `agents/counter-design.md`

```yaml
---
name: design-challenger-counter-design
description: Round 1 adversarial design reviewer. Produces counter-design, extracts assumptions, falsifies against evidence.
model: claude-opus-4-6
tools: Read, Glob, Grep, WebSearch, WebFetch
---
```

System prompt embeds:
- Identity: "Adversarial design reviewer. You explore and analyze. You do NOT modify any files." (enforced by `tools` field)
- Counter-design methodology (2–4 paragraph alternative, divergence points, steelman)
- Assumption extraction format (numbered, testable, cite source)
- Falsification protocol (prioritize assumptions where counter-design diverges)
- Evidence requirements (file:line, URL, or git commit)
- Upstream issue detection (set `upstream_issue: true` for bugs in source docs)
- Evidence type tagging (`codebase` vs `external`)
- Output format: structured findings as markdown with fenced JSON blocks

### `agents/skeptical.md`

```yaml
---
name: design-challenger-skeptical
description: Round 2 skeptical verifier. Re-reads artifact, verifies fixes landed, finds new issues from fixes.
model: claude-opus-4-6
tools: Read, Glob, Grep, WebSearch, WebFetch
---
```

System prompt:
- "The Writer claims to have fixed everything. Don't take their word for it. Re-read the actual file."
- Receives list of prior findings marked as addressed/rejected
- Verifies each claimed fix by checking the actual artifact text
- Looks for NEW issues introduced by the fixes
- Re-examines counter-design divergence points from Round 1
- Same finding format and evidence requirements

### `agents/pre-mortem.md`

```yaml
---
name: design-challenger-pre-mortem
description: Round 3 pre-mortem analysis. Imagines 6-month failure scenarios, traces through design.
model: claude-opus-4-6
tools: Read, Glob, Grep, WebSearch, WebFetch
---
```

System prompt:
- "It's 6 months from now. This failed in production. What went wrong?"
- Generate 3–5 specific failure scenarios
- Trace each scenario through the design step by step
- Focus on integration failures, operational issues, edge cases
- Reference counter-design alternatives — would they have prevented the failure?
- Same finding format

### `agents/judge.md`

```yaml
---
name: design-challenger-judge
description: Filters Challenger findings for actionability. Removes noise, consolidates duplicates, adjusts severity.
model: claude-sonnet-4-6
tools: Read
---
```

System prompt:
- "You are a noise filter, not a reviewer."
- Evaluation criteria: actionable? duplicate? proportionate severity?
- Does NOT filter on severity alone — all actionable findings forwarded
- Output: `forwarded_findings` (with adjusted severity + rationale) + `filtered_findings` (with reason + rationale)

Read tool only (doesn't need to re-explore; operates on findings data).

### `agents/verifier.md`

```yaml
---
name: design-challenger-verifier
description: Verifies external claims against documentation and web sources. Used for pre-review assumption checks and Challenger evidence verification.
model: claude-sonnet-4-6
tools: Read, Glob, Grep, WebSearch, WebFetch
---
```

System prompt:
- Single-purpose: given a claim + source, confirm or refute
- Output: `{ claim, verified, confidence, evidence, source_checked }`
- Called per-claim, ephemeral each time

## Auto-Apply vs Consult Rules

After Judge filters findings and Verifier confirms external evidence, Claude Code addresses findings as follows:

| Severity | Behavior |
|----------|----------|
| **MINOR** | Auto-apply. Summarize in DDL. |
| **IMPORTANT** | Auto-apply. Summarize in DDL. |
| **CRITICAL** | **Pause and consult the user.** Present the finding with evidence, the Challenger's proposed resolution, and the potential impact on architecture. User approves or rejects before Claude Code applies. |

Rationale: CRITICAL findings indicate architecture-level pivots. The user should stay in the loop on those calls without being drowned in approvals for nitpicks.

## Finding Format

Subagents emit findings as JSON blocks within their markdown output. The orchestrator (Claude Code) parses them:

```json
{
  "id": 1,
  "summary": "One-line description",
  "severity": "CRITICAL|IMPORTANT|MINOR",
  "assumption_id": null,
  "counter_design_divergence": false,
  "upstream_issue": false,
  "upstream_source": null,
  "evidence": [
    { "type": "file", "location": "src/auth.ts", "lines": "42-58", "summary": "Shows JWT validation missing" }
  ],
  "evidence_type": "codebase",
  "recommendation": "Add JWT validation middleware before the route handler"
}
```

Same structure as CLI v1. Validation is pattern-based rather than AJV-enforced, but Claude models produce structured output reliably enough for this to work.

## Finding-Level Checklist Enforcement

Claude Code maintains a `TodoWrite` list: one task per forwarded finding, format `"Address finding #N: <summary>"`. Each task marked `completed` (addressed) or updated with rejection reasoning. Round does not advance until all tasks are resolved.

Not bulletproof like code-enforced validation, but Claude Code follows TodoWrite discipline reliably.

## Upstream Propagation

When a Challenger finds `upstream_issue: true` (e.g., plan review exposes a spec bug):

1. Claude Code fixes the current artifact (plan).
2. Claude Code fixes the upstream source (spec).
3. Both files saved, both get the fix recorded in the DDL.
4. If the finding triggered a CRITICAL consult, the user sees both changes before they're applied.

## External Evidence Verification

For findings with `evidence_type: "external"`:

1. Claude Code spawns `verifier` subagent per external claim (parallelizable).
2. Verifier checks source, returns `{ verified: boolean, confidence, evidence }`.
3. Verified claims → `evidence_verified: true` on the finding.
4. Unverifiable claims → flagged to user ("evidence could not be independently confirmed").
5. Refuted claims → finding dropped, logged in DDL as "Challenger error — evidence refuted."

## Output Artifacts

Every full run produces four files in the target repo:

| Artifact | Default Location |
|----------|------------------|
| **Spec** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
| **Plan** | `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md` |
| **DDL** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-decisions.md` |
| **Run Summary** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-run-summary.md` |

Same convention as CLI v1, same convention as existing superpowers usage in this repo.

## Design Decision Log (DDL)

Claude Code writes the DDL incrementally during the flow. Each significant decision captured:

```markdown
## Decision N: <title>
- **Context**: <what prompted this>
- **Writer proposed**: <original approach>
- **Challenger counter-design**: <alternative>
- **Challenger concern**: <specific finding + evidence>
- **Resolution**: <what Claude Code did or asked the user>
- **Evidence**: <file:line refs, URLs>
- **Round**: <Stage/Round>
- **Judge assessment**: <if filtered, rationale>
```

Includes filtered findings with Judge rationale for the record.

## Run Summary

Written at the end of the flow. Includes:
- Topic, date, duration
- Per-stage breakdown: rounds run, findings produced, forwarded, filtered, addressed, rejected
- Quality metrics (computed post-hoc from DDL + conversation):
  - Assumption survival rate
  - Finding resolution rate
  - Judge filter rate
  - Counter-design divergence impact
  - Upstream issue rate
  - External evidence verification rate
- Artifact paths

Metrics are approximate (not programmatically instrumented like the CLI), but the DDL provides enough structured data to compute them.

## Gates

Three gates mirror the CLI flow:

- **GATE 1**: After brainstorming + Round 1 Challenger. User approves the direction before spec writing begins.
- **GATE 2**: After spec writing + all review rounds. User approves the spec before plan writing.
- **GATE 3**: After plan writing + all review rounds. User approves the plan before finalization.

At each gate, Claude Code presents a summary, any unresolved concerns, and the artifact path. User responds: approve / request changes / abort.

On `request_changes`, user provides direction, Claude Code applies it, then re-presents.
On `abort`, Claude Code writes a partial run summary and stops.

## Feature Transfer from CLI

| CLI Feature | Plugin Implementation | Status |
|-------------|----------------------|--------|
| Three-stage flow | Skill orchestrates brainstorm → spec → plan | ✅ Direct |
| Counter-design + dialectical inquiry | `counter-design` subagent methodology | ✅ Direct |
| Escalating 3-round protocol | Three distinct subagents | ✅ Direct (enhanced: separate subagents) |
| Judge filter | `judge` subagent | ✅ Direct |
| Verifier agent | `verifier` subagent | ✅ Direct |
| Read-only Challenger | Subagent `tools:` field | ✅ Enhanced (actually enforced by Claude Code) |
| Pre-review assumption verification | Orchestrator spawns verifier before Round 1 | ✅ Direct |
| Finding format | Markdown with JSON blocks | ✅ Direct |
| Finding-level checklist | TodoWrite list managed by orchestrator | 🔄 Adapted (instruction-based) |
| Upstream propagation | Skill instruction: fix both files when `upstream_issue: true` | ✅ Direct |
| External evidence verification | `verifier` subagent per external claim | ✅ Direct |
| DDL generation | Claude Code writes incrementally | ✅ Direct |
| Run summary with metrics | Written at end, metrics approximated from DDL | 🔄 Adapted (post-hoc metrics) |
| Output artifacts (spec/plan/DDL/summary) | Same locations, same format | ✅ Direct |
| Auto-commit at gates | Skill instructs git commit | ✅ Direct |
| Heterogeneous models | Per-subagent `model:` field | ✅ Direct |
| Evidence index | Written to `docs/superpowers/specs/<topic>-evidence.json` | 🔄 Adapted (less rigorous indexing) |
| Project-agnostic | Plugin installed globally | ✅ Enhanced |
| **Auto-activation on design work** | Skill description matching | 🆕 **Gained** |
| **Review existing specs/plans (Mode B)** | `challenge-existing-*.md` skills | 🆕 **Gained** |
| **Composes with superpowers** | Works alongside brainstorming + writing-plans | 🆕 **Gained** |
| Session resume | Claude Code's native conversation persistence | ❌ **Dropped** (no longer needed) |
| Per-agent USD budget caps | — | ❌ **Dropped** (no SDK equivalent) |
| Custom compaction hooks | Claude Code handles natively | ❌ **Dropped** (not available in subagent mode) |

## Scope — What's In v1

- Plugin with 3 skills and 5 subagent definitions
- Mode A: full design flow (brainstorm → spec → plan with review at each stage)
- Mode B: targeted review on existing spec or plan
- All five subagent types with documented system prompts
- Finding format + JSON extraction + TodoWrite enforcement
- Auto-apply / consult-on-CRITICAL logic
- DDL + run summary generation
- Artifact output to standard superpowers locations
- Auto-commit at gates
- Upstream propagation
- External evidence verification
- Documentation (README) for installing the plugin

## Scope — Out (Deferred)

- Telegram/Slack notifications on gate or CRITICAL consult
- Custom Challenger prompt overrides (v1 prompts are static)
- Multi-Challenger parallelism (spawning N counter-design agents with different priors)
- Cross-provider models (non-Anthropic Challengers for maximum bias diversity)
- Cross-run analytics aggregating metrics across multiple design sessions
- Web UI / dashboard
- CI/CD integration (headless with exit codes) — the CLI was going to handle this; if needed later, a thin CLI wrapper can invoke the plugin

## Assumptions

1. **[external]** Claude Code plugin subagents support the `tools:` field with a list of allowed tools, enforced by Claude Code (not just documented).
2. **[external]** Claude Code plugin subagents support per-subagent `model:` specification.
3. **[external]** The Agent tool in Claude Code can invoke plugin-defined subagents by name.
4. **[external]** Skills auto-load based on description matching — user doesn't need to invoke them manually.
5. **[external]** Plugin installation is straightforward (drop directory into a known path or use a plugin management tool).
6. **[internal]** The user already has `superpowers:brainstorming` and `superpowers:writing-plans` installed. The plugin composes with them rather than depending on their internals.
7. **[internal]** Subagents spawned by Claude Code don't inherit parent conversation context by default — each starts fresh. This is essential for dialectical inquiry.
8. **[internal]** TodoWrite discipline is reliable enough to substitute for code-enforced checklist completion.

## Success Criteria

The plugin is working when:

- Any design session in any project automatically engages Challenger review without user prompting
- Counter-design subagent produces genuinely different approaches than the main Claude Code session (test: can you spot at least one architectural divergence per design?)
- Judge filters >10% but <50% of findings (indicates sensible signal/noise balance)
- Verifier catches at least occasional external hallucinations before they reach the Writer
- User consults only on CRITICAL findings, not buried in MINOR approvals
- DDL + run summary make every significant decision traceable
- Full plugin install is one step and works across all projects

## Open Questions for Implementation

These surface during the plan:

1. **Plugin packaging mechanism** — Claude Code supports plugins installed via plugin manager; what's the exact installation path and manifest format for v1?
2. **Subagent invocation API** — how does the orchestrator (Claude Code) actually invoke a plugin-defined subagent by name via the Agent tool? (`subagent_type: "design-challenger-counter-design"`?)
3. **Subagent output parsing** — how does Claude Code retrieve structured output from a subagent (the subagent's final message, presumably)?
4. **Parallel subagent spawning** — the CLI did Writer + Challenger in parallel during brainstorming. Can the plugin do the same with multiple Agent tool calls in one message?
5. **DDL incremental writes** — Claude Code writes the DDL as it goes. Should it use Write (overwrite each time) or Edit (append sections)?

These don't block the spec — they're implementation tactics. The writing-plans skill surfaces them during plan drafting.
