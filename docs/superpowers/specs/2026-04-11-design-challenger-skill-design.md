# Design Challenger Skill — v1 Spec

**Supersedes**: `2026-04-09-design-challenger-design.md` (CLI-based v1 — architecturally sound but over-engineered for the problem)

## Purpose

A Claude Code plugin that automatically engages adversarial design review whenever you do design work in any project. You set the goal, approve big calls at gates. Everything in between runs as an enhanced version of your existing superpowers workflow.

The plugin composes with `superpowers:brainstorming` and `superpowers:writing-plans` — it doesn't replace them. You still use your normal design flow; the plugin layers Challenger review on top automatically.

**Requires**: `superpowers >= 5.0` plugin installed. This is a **hard dependency**, not graceful degradation. If superpowers is not present, the plugin's skills fail at activation with a clear error: "design-challenger requires superpowers plugin. Install it via `/plugin install claude-plugins-official/superpowers`." This matches your existing setup and avoids the failure mode where the plugin silently loses core functionality on a missing dependency.

## Why This Replaces the CLI

The CLI v1 was designed before plugin-defined subagents matured. Reassessing against current Claude Code capabilities:

| Concern | CLI v1 | Plugin v1 |
|---------|--------|-----------|
| Authentication | Requires `ANTHROPIC_API_KEY` | Uses Claude Code's existing auth |
| Read-only enforcement on Challenger | `disallowedTools` SDK option (verified) | Plugin subagent `tools:` field (**enforcement unverified under plugins** — see Empirical Testing below) |
| Distribution | `npm install` + build step | Plugin install once, works everywhere |
| Activation | Manual CLI invocation | Auto-loads via skill description matching |
| Session management | Custom checkpointing + resume | Claude Code's conversation persistence |
| Context management | Custom 150K/250K/500K thresholds | Claude Code's native compaction (known-lossy on file paths + line numbers; see Risks) |
| Code footprint | ~1500 lines TypeScript | ~500 lines markdown (skills + subagent defs) |

The CLI codebase is preserved in `src/` for reference but not deployed.

## Roles

| Role | Implementation | Model |
|------|----------------|-------|
| **User** | You | — |
| **Writer + Orchestrator** | Claude Code (main session) | User's default (typically Opus) |
| **Counter-Design Challenger** | Plugin subagent, round 1 | `opus` |
| **Skeptical Challenger** | Plugin subagent, round 2 | `opus` |
| **Pre-mortem Challenger** | Plugin subagent, round 3 | `opus` |
| **Judge** | Plugin subagent, ephemeral | `sonnet` |
| **Verifier** | Plugin subagent, ephemeral | `sonnet` |

Claude Code is both orchestrator and Writer — it brainstorms, writes specs/plans, addresses findings, spawns subagents at the right moments. No separate Writer session.

**Model values**: Use attested plugin values (`opus`, `sonnet`, `haiku`, `inherit`), not literal model IDs. Literal model IDs like `claude-opus-4-6` are not attested in any shipped Anthropic plugin and may not resolve correctly under plugin frontmatter.

## Plugin Structure

Matches the shipped convention used by `superpowers` and `code-simplifier`:

```
design-challenger/
  .claude-plugin/
    plugin.json                     # Plugin manifest: name, version, description, author
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

The `agents/` directory is auto-discovered by Claude Code. No manifest registration required.

## Invocation Convention

Plugin subagents are invoked as `<plugin-name>:<agent-name>`. The plugin is named `design-challenger` in `plugin.json`. Agent files use a bare `name:` in their frontmatter (e.g., `name: counter-design`), and the main session invokes them as:

```
Agent({
  subagent_type: "design-challenger:counter-design",
  description: "Round 1 adversarial review",
  prompt: "..."
})
```

Namespacing uses the plugin name from `plugin.json`, not the filename.

## Activation

Skills auto-load based on description matching, same mechanism as `superpowers:brainstorming`.

**`adversarial-review.md`** — description: "Use during design work, writing specs, planning implementations. Runs adversarial review on designs before finalizing them. Loads alongside superpowers:brainstorming and superpowers:writing-plans."

**`challenge-existing-spec.md`** — description: "Use when reviewing an existing spec, design document, or proposal for gaps, issues, or hidden assumptions."

**`challenge-existing-plan.md`** — description: "Use when reviewing an existing implementation plan for completeness, missing dependencies, or operational gaps."

You never type a command. The skill loads because of what you're doing.

## Flow

Three stages: (1) brainstorming with parallel Challenger exploration, (2) spec review cycle (up to 3 rounds), (3) plan review cycle (up to 2 rounds — counter-design dropped; see rationale below). Each review cycle terminates early if no remaining findings.

### Mode A: Full adversarial design (new feature)

User: *"Let's design user authentication for this app."*

#### Stage 1: Brainstorming

1. `superpowers:brainstorming` starts normally — Claude Code explores context, asks clarifying questions, proposes approaches.
2. **In parallel**, Claude Code spawns the `design-challenger:counter-design` subagent with the topic and codebase access. It independently explores the codebase (read-only) and produces an alternative approach + extracted assumptions + initial findings. This runs while brainstorming is asking you clarifying questions — no additional wall time.
3. When both finish, Claude Code runs `design-challenger:judge` on the Challenger's findings. Judge filters noise, consolidates duplicates, adjusts severity.
4. For findings with external evidence, Claude Code spawns `design-challenger:verifier` subagents per claim. Refuted claims dropped; unverifiable claims flagged.
5. Claude Code applies findings **to the brainstorming context** (not a written artifact — the spec does not exist yet). Specifically: findings are incorporated into Claude Code's proposed approach before it presents the design to the user at Gate 1. CRITICAL findings surface to the user as part of the design presentation; IMPORTANT/MINOR findings are silently incorporated into the approach.
6. `superpowers:brainstorming` writes the spec to `docs/superpowers/specs/<date>-<topic>-design.md` (standard brainstorming behavior, unchanged).
7. **GATE 1** — Claude Code presents: brainstorm summary, counter-design alternative, findings addressed, any CRITICAL items needing user input, and the spec file path. User responds: approve / request changes / abort.

#### Stage 2: Spec Review Cycle

The spec exists. Now run up to 3 rounds of adversarial review *against the written spec*.

8. **Pre-review assumption verification** — Claude Code parses the spec's `## Assumptions` section for items tagged `[external]`. Spawns `design-challenger:verifier` for each. Refuted assumptions fixed before Challenger sees the spec.
9. **Round 1 (Counter-Design + Hypothesis Tester)** — Claude Code spawns `design-challenger:counter-design` pointing at the spec. This round is *different* from Stage 1's parallel exploration: now the subagent sees the written artifact, produces its own counter-design specifically against the spec's architecture, extracts assumptions from the spec, and falsifies them.
10. Judge filter + Verifier + **Finding Checklist Gate** (see below) + Address findings.
11. **Round 2 (Skeptical Verifier)** — Claude Code spawns `design-challenger:skeptical` with the list of findings marked addressed/rejected from Round 1. Subagent re-reads the actual spec file, verifies claimed fixes landed, looks for new issues.
12. Judge filter + Verifier + Finding Checklist Gate + Address findings. **Early termination** if no remaining findings.
13. **Round 3 (Pre-mortem)** — Claude Code spawns `design-challenger:pre-mortem`. Imagines 6-month failure scenarios, traces each through the spec.
14. Judge filter + Verifier + Finding Checklist Gate + Address findings.
15. **GATE 2** — Claude Code presents: spec file path, rounds run, findings summary, metrics snapshot, unresolved concerns. User responds: approve / request changes / abort.

#### Stage 3: Plan Review Cycle

16. `superpowers:writing-plans` writes the implementation plan to `docs/superpowers/plans/<date>-<topic>-plan.md` (standard behavior, unchanged).
17. **Pre-review assumption verification** — same as Stage 2 step 8, applied to the plan.
18. **Round 1 (Skeptical)** — Claude Code spawns `design-challenger:skeptical` against the plan. Verifies the plan faithfully implements the spec, checks for missing steps, missing dependencies, verification criteria gaps. **Counter-design is NOT run against the plan** — by Gate 2, architecture is locked, and plan-level counter-design either re-litigates settled spec decisions or overlaps with skeptical's job.
19. Judge filter + Verifier + Finding Checklist Gate + Address findings. **Upstream propagation**: findings with `upstream_issue: true` indicate bugs in the spec (not the plan). Claude Code fixes both documents.
20. **Round 2 (Pre-mortem)** — Claude Code spawns `design-challenger:pre-mortem` against the plan. Imagines implementation-phase failure scenarios (step X fails, step Y has a hidden dependency on Z, operator forgets to run migration, etc.).
21. Judge filter + Verifier + Finding Checklist Gate + Address findings.
22. **GATE 3** — Claude Code presents: plan file path, rounds run, findings summary, any upstream fixes applied to the spec. User responds: approve / request changes / abort.

#### Finalize

23. Claude Code writes the full DDL (`<date>-<topic>-decisions.md`) and run summary (`<date>-<topic>-run-summary.md`).
24. Auto-commits artifacts with message `design-challenger: <stage> approved for <topic>`.

### Total Challenger invocations per full run (worst case)

- Counter-design subagent: 2× (Stage 1 exploration, Stage 2 Round 1)
- Skeptical subagent: 2× (Stage 2 Round 2, Stage 3 Round 1)
- Pre-mortem subagent: 2× (Stage 2 Round 3, Stage 3 Round 2)
- Judge: up to 6× (one per Challenger round)
- Verifier: variable (once per external claim, typically 2–10× per stage)

Early termination on "no remaining findings" typically reduces this significantly.

### Mode B: Challenge existing artifact

User: *"Review this spec: `docs/superpowers/specs/2026-04-11-auth-design.md`"*

`challenge-existing-spec.md` skill loads. Claude Code runs Stage 2 steps 8–15 against the existing spec (no brainstorming, no spec writing). Outputs findings + DDL + run summary. Artifact updated in place.

`challenge-existing-plan.md` loads on plan review. Runs Stage 3 steps 17–22, including upstream propagation to the source spec if present.

## Subagent Specifications

Each subagent is defined in a markdown file with frontmatter specifying model and tools. Frontmatter uses bare agent `name:` (plugin prefix is applied at invocation).

### `agents/counter-design.md`

```yaml
---
name: counter-design
description: Round 1 adversarial design reviewer. Produces counter-design, extracts assumptions, falsifies against evidence.
model: opus
tools: Read, Glob, Grep, WebSearch, WebFetch
---
```

System prompt embeds:
- Identity: "Adversarial design reviewer. You explore and analyze. You do NOT modify any files." (tools field ideally enforces this; see Empirical Testing)
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
name: skeptical
description: Round 2 skeptical verifier. Re-reads artifact, verifies fixes landed, finds new issues from fixes.
model: opus
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
name: pre-mortem
description: Round 3 pre-mortem analysis. Imagines 6-month failure scenarios, traces through design.
model: opus
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
name: judge
description: Filters Challenger findings for actionability. Removes noise, consolidates duplicates, adjusts severity.
model: sonnet
---
```

No `tools:` field — the Judge operates purely on findings data passed via the prompt. It does not read files or browse. If future versions need to inspect artifacts, add `tools: Read` then.

System prompt:
- "You are a noise filter, not a reviewer."
- Evaluation criteria: actionable? duplicate? proportionate severity?
- Does NOT filter on severity alone — all actionable findings forwarded
- Output: `forwarded_findings` (with adjusted severity + rationale) + `filtered_findings` (with reason + rationale)

### `agents/verifier.md`

```yaml
---
name: verifier
description: Verifies external claims against documentation and web sources. Used for pre-review assumption checks and Challenger evidence verification.
model: sonnet
tools: Read, Glob, Grep, WebSearch, WebFetch
---
```

System prompt:
- Single-purpose: given a claim + source, confirm or refute
- Output: `{ claim, verified, confidence, evidence, source_checked }`
- Called per-claim, ephemeral each time

## Auto-Apply vs Consult Rules

After Judge filters findings and Verifier confirms external evidence, Claude Code addresses findings. **Severity in the consult rules is the Judge-adjusted severity, not the Challenger-raw severity** — this is the point of having a Judge.

| Severity | Default Behavior | Escalation Exceptions |
|----------|------------------|----------------------|
| **MINOR** | Auto-apply. Summarize in DDL. | None. |
| **IMPORTANT** | Auto-apply. Summarize in DDL. | **Escalate to consult if the finding modifies `## Architecture` or `## Components` sections, introduces a new external dependency, or changes a data contract.** These are architecture-level changes that deserve user visibility even at IMPORTANT severity. |
| **CRITICAL** | **Pause and consult the user.** Present the finding with evidence, Challenger's proposed resolution, and impact on architecture. User approves or rejects before Claude Code applies. | — |

Rationale: CRITICAL findings indicate architecture-level pivots. But the real risk isn't CRITICAL fatigue — it's *invisible drift* from IMPORTANT findings that modify architecture silently. The escalation exception for IMPORTANT is a cheap safeguard.

Claude Code determines whether an IMPORTANT finding "modifies Architecture/Components" by inspecting the finding's `recommendation` field and the file diff it would produce. When in doubt, escalate.

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

Same structure as CLI v1. Validation is pattern-based rather than AJV-enforced.

### Schema Retry Loop

When Claude Code parses a subagent's findings and the JSON is malformed or missing required fields:

1. **Attempt 1**: Extract JSON, validate against expected shape.
2. **On failure**: Re-prompt the subagent with a single message: "Your previous output did not match the required schema. Here is the schema: `<schema>`. Please re-emit your findings in this exact format."
3. **Attempt 2**: Parse the re-prompt response.
4. **On second failure**: Surface the raw output to the user as an unresolved finding, continue the round with whatever findings parsed successfully. Log the parse failure in the run summary.

Max 2 re-prompts per subagent invocation. This matches the CLI's retry policy (CLI spec §"Schema Validation").

## Finding Checklist Gate (Core Correctness Mechanism)

After each Challenger round's findings are forwarded by the Judge, Claude Code must explicitly disposition every forwarded finding ID before the round advances. This is an **explicit flow step**, not a TodoWrite hope:

1. After Judge returns forwarded findings, Claude Code constructs the checklist: one entry per forwarded finding ID.
2. Before advancing rounds, Claude Code emits an explicit disposition block:
   ```json
   [
     { "finding_id": 1, "disposition": "addressed", "detail": "Added JWT validation middleware at src/middleware/auth.ts:15-32" },
     { "finding_id": 2, "disposition": "rejected", "detail": "Changing connection pool size would conflict with pgbouncer limits (config/pgbouncer.ini:3)" }
   ]
   ```
3. Claude Code checks: every forwarded finding ID has a matching disposition entry with non-empty `detail`.
4. **If any disposition is missing or empty**: Claude Code does not advance. It re-addresses the missing findings and re-emits the disposition block. Max 2 re-addressing attempts. On third failure, surface the missing IDs to the user at the next gate with the unresolved list.

TodoWrite can track this internally for the orchestrator's own bookkeeping, but the canonical enforcement is the disposition block + completeness check. This is the single strongest correctness mechanism from the CLI, preserved mechanically.

## Upstream Propagation

When a Challenger finds `upstream_issue: true` (e.g., plan review exposes a spec bug):

1. Claude Code fixes the current artifact (plan).
2. Claude Code fixes the upstream source (spec).
3. Both files saved. DDL records the fix with a cross-reference:
   ```markdown
   - **Upstream fix**: Applied to `<upstream_source>` in addition to current artifact.
   ```
4. If the finding triggered a CRITICAL consult (or IMPORTANT escalation), the user sees both changes before they're applied.

## External Evidence Verification

For findings with `evidence_type: "external"`:

1. Claude Code spawns `design-challenger:verifier` per external claim (parallelizable via multiple Agent tool calls in one message).
2. Verifier checks source, returns `{ verified: boolean, confidence, evidence }`.
3. Verified claims → `evidence_verified: true` on the finding.
4. Unverifiable claims → flagged to user ("evidence could not be independently confirmed").
5. Refuted claims → finding dropped, logged in DDL as "Challenger error — evidence refuted."

## Evidence Index

Claude Code maintains a side-channel `docs/superpowers/specs/<date>-<topic>-evidence.json` file, written as the flow progresses:

```json
{
  "evidence": [
    {
      "id": "e1",
      "type": "file",
      "location": "src/auth/middleware.ts",
      "lines": "42-58",
      "summary": "JWT validation logic",
      "cited_by": ["finding_3", "assumption_1"]
    }
  ]
}
```

Purpose: if Claude Code's native compaction drops file paths or line numbers from context, the evidence index is re-readable from disk. Subagents in later rounds can reference this index rather than re-exploring the codebase. This is the plugin's substitute for the CLI's in-memory evidence index.

Claude Code writes to this file incrementally: append to the `evidence` array whenever a new citation appears in a Challenger finding. Use Edit (not Write) so concurrent appends don't overwrite.

## Output Artifacts

Every full run produces five files in the target repo:

| Artifact | Default Location |
|----------|------------------|
| **Spec** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
| **Plan** | `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md` |
| **DDL** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-decisions.md` |
| **Evidence Index** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-evidence.json` |
| **Run Summary** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-run-summary.md` |

Same convention as CLI v1, same convention as existing superpowers usage in this repo.

## Design Decision Log (DDL)

Claude Code writes the DDL incrementally during the flow. Each significant decision captured:

```markdown
## Decision N: <title>
- **Context**: <what prompted this>
- **Writer proposed**: <original approach>
- **Challenger counter-design**: <alternative, if applicable>
- **Challenger concern**: <specific finding + evidence>
- **Resolution**: addressed | rejected | consulted-user
- **Disposition detail**: <what changed (addressed), why rejected (rejected), or what the user decided (consulted)>
- **Upstream fix**: <upstream_source file path, if applicable>
- **Evidence**: <file:line refs, URLs>
- **Round**: <Stage/Round>
- **Judge assessment**: <forwarded|filtered, Judge's rationale>
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
  - Checklist re-disposition rate (how often Claude Code had to re-address missing IDs)
- Parse failures: count of subagent invocations that required schema retry or surfaced malformed output
- Artifact paths

Metrics are approximate (not programmatically instrumented like the CLI), but the DDL + evidence index provide enough structured data to compute them.

## Gates

Three gates mirror the CLI flow:

- **GATE 1**: After brainstorming + Stage 1 parallel counter-design. User approves the direction before spec writing finalizes.
- **GATE 2**: After spec writing + all spec-review rounds. User approves the spec before plan writing.
- **GATE 3**: After plan writing + all plan-review rounds. User approves the plan before finalization.

At each gate, Claude Code presents a summary, any unresolved concerns, and the artifact path. User responds: approve / request changes / abort.

On `request_changes`, user provides direction, Claude Code applies it, then re-presents.
On `abort`, Claude Code writes a partial run summary and stops.

## Feature Transfer from CLI

| CLI Feature | Plugin Implementation | Status |
|-------------|----------------------|--------|
| Three-stage flow | Skill orchestrates brainstorm → spec → plan | ✅ Direct |
| Counter-design + dialectical inquiry | `counter-design` subagent methodology | ✅ Direct |
| Escalating review protocol | Distinct subagents per phase (3 for spec, 2 for plan) | 🔄 Adapted (plan stage drops counter-design for cost/overlap reasons) |
| Judge filter | `judge` subagent | ✅ Direct |
| Verifier agent | `verifier` subagent | ✅ Direct |
| Read-only Challenger | Subagent `tools:` field | ⚠️ **Depends on empirical test** — `tools:` enforcement under plugins is unverified in current Claude Code versions. See Empirical Testing section. |
| Pre-review assumption verification | Orchestrator spawns verifier before Round 1 | ✅ Direct |
| Finding format | Markdown with JSON blocks | ✅ Direct |
| Finding-level checklist enforcement | Explicit disposition block + completeness check as flow step | ✅ Direct (preserved mechanically, not as TodoWrite hope) |
| Schema validation + retry loop | Pattern-based parse + max-2 retries per subagent invocation | ✅ Direct |
| Writer disposition format (addressed/rejected with detail) | Canonical disposition block; detail field captured in DDL | ✅ Direct |
| Upstream propagation | Skill instruction: fix both files when `upstream_issue: true`; DDL cross-references | ✅ Direct |
| External evidence verification | `verifier` subagent per external claim | ✅ Direct |
| DDL generation | Claude Code writes incrementally, includes upstream_file + disposition detail | ✅ Direct |
| Evidence index | Written to `docs/superpowers/specs/<date>-<topic>-evidence.json` incrementally | ✅ Direct (disk-backed; substitute for CLI's in-memory index) |
| Run summary with metrics | Written at end, metrics approximated from DDL + evidence index | 🔄 Adapted (post-hoc metrics, similar fidelity) |
| Output artifacts (spec/plan/DDL/evidence/summary) | Same locations, same format | ✅ Direct |
| Auto-commit at gates | Skill instructs git commit | ✅ Direct |
| Heterogeneous models | Per-subagent `model:` field with attested values | ✅ Direct |
| Project-agnostic | Plugin installed globally | ✅ Enhanced |
| **Auto-activation on design work** | Skill description matching | 🆕 **Gained** |
| **Review existing specs/plans (Mode B)** | `challenge-existing-*.md` skills | 🆕 **Gained** |
| **Composes with superpowers** | Works alongside brainstorming + writing-plans | 🆕 **Gained** |
| Session resume | Claude Code's native conversation persistence | ❌ **Dropped** (accepted — conversation history IS the state) |
| Per-agent USD budget caps | — | ❌ **Dropped with risk** — a runaway Opus subagent has no cost ceiling. Mitigation: user monitors total session cost via Claude Code's usage indicator. |
| Custom compaction hooks | Claude Code handles compaction natively | ❌ **Dropped with risk** — Claude Code's native compaction is documented-lossy on file paths and line numbers, which is exactly what Challenger findings cite. Mitigation: the disk-backed Evidence Index preserves file:line references across compactions. |
| Context management tiers (150K/250K/500K) | Claude Code's native thresholds | ❌ **Dropped with risk** — no explicit observation masking or structured re-injection. Mitigation: Evidence Index + structured DDL provide re-injectable context on next subagent invocation if the orchestrator detects compaction indicators. |

## Empirical Testing (v1 Success Gate)

Before declaring v1 done, these assumptions must be empirically verified:

1. **`tools:` enforcement under plugins** — Deploy a test Challenger subagent with `tools: Read, Glob, Grep` only, and attempt Write/Edit/Bash from within its system prompt's example code. If the subagent successfully writes a file, enforcement is advisory; the spec must add instruction-based discipline as a backup.
2. **Subagent invocation by `plugin-name:agent-name`** — Verified in principle via existing Anthropic plugins (superpowers, code-simplifier), but test the specific `design-challenger:<name>` format end-to-end before v1 ships.
3. **Model value attested values work** — `opus`, `sonnet`, `haiku` confirmed in shipped plugins. Verify by checking the subagent session's model ID in its init message.
4. **Skill auto-load on design work** — Verify the plugin's skills activate alongside `superpowers:brainstorming` when the user says "design X," without explicit invocation.

Results of these tests update the spec's risk annotations. If any fail, the implementation plan's mitigation branches take over.

## Scope — What's In v1

- Plugin manifest (`.claude-plugin/plugin.json`) + 3 skills + 5 subagent definitions
- Mode A: full design flow (brainstorm → spec → plan with review at each stage)
- Mode B: targeted review on existing spec or plan
- All five subagent types with documented system prompts
- Finding format + JSON extraction + schema retry loop
- Finding Checklist Gate (disposition block + completeness check)
- Auto-apply / consult-on-CRITICAL logic with IMPORTANT escalation for architecture changes
- Judge-adjusted severity in consult rules
- DDL + run summary + evidence index generation
- Artifact output to standard superpowers locations
- Auto-commit at gates
- Upstream propagation with DDL cross-references
- External evidence verification
- Documentation (README) for installing the plugin
- Empirical test checklist in v1 success gate

## Scope — Out (Deferred)

- Telegram/Slack notifications on gate or CRITICAL consult
- Custom Challenger prompt overrides (v1 prompts are static)
- Multi-Challenger parallelism (spawning N counter-design agents with different priors)
- Cross-provider models (non-Anthropic Challengers for maximum bias diversity)
- Cross-run analytics aggregating metrics across multiple design sessions
- Web UI / dashboard
- CI/CD integration (headless with exit codes) — the CLI was going to handle this; if needed later, a thin CLI wrapper can invoke the plugin
- Plugin-level `disallowedTools` fallback (if `tools:` enforcement turns out to be advisory, v2 may need instruction-based read-only discipline; v1 does empirical test first)

## Assumptions

1. **[external, UNVERIFIED]** Claude Code plugin subagents support the `tools:` frontmatter field as an enforced allowlist (not just advisory documentation). **Empirical test required** — see v1 Success Gate.
2. **[external, verified]** Claude Code plugin subagents support per-subagent `model:` specification with values `opus`, `sonnet`, `haiku`, `inherit`. Confirmed via shipped plugins (superpowers, code-simplifier).
3. **[external, verified]** The Agent tool in Claude Code can invoke plugin-defined subagents via `subagent_type: "<plugin-name>:<agent-name>"`. Confirmed via superpowers plugin's `Task tool (superpowers:code-reviewer)` usage.
4. **[external, unverified]** Skills auto-load based on description matching. User doesn't need to invoke them manually. Expected behavior based on existing superpowers skills behavior; confirm during v1 deployment.
5. **[external, verified]** Plugin installation via Claude Code's plugin system. Plugin manifest lives at `.claude-plugin/plugin.json`. Confirmed via shipped plugin structure.
6. **[internal]** The user has `superpowers >= 5.0` installed. Hard dependency.
7. **[internal, verified]** Subagents spawned by Claude Code don't inherit parent conversation context — each starts fresh. Essential for dialectical inquiry.
8. **[internal]** Claude Code produces structured JSON output reliably enough that pattern-based parsing + 2 retries recovers from the rare malformed case.
9. **[internal]** Multiple Agent tool calls in a single message execute in parallel, enabling parallel verifier invocations.

## Success Criteria

The plugin is working when:

- Any design session in any project automatically engages Challenger review without user prompting
- Counter-design subagent produces genuinely different approaches than the main Claude Code session (test: can you spot at least one architectural divergence per design?)
- Judge filters >10% but <50% of findings (indicates sensible signal/noise balance)
- Verifier catches at least occasional external hallucinations before they reach the Writer
- User consults only on CRITICAL + escalated-IMPORTANT findings, not buried in approval fatigue
- DDL + run summary + evidence index make every significant decision traceable
- Full plugin install is one step and works across all projects
- All four empirical tests in v1 Success Gate pass (or their failures are documented and mitigated)

## Open Questions for Implementation Plan

These surface during the plan phase, not the spec:

1. **Plugin installation mechanism** — exact command (`/plugin install ...`), manifest contents, version-pinning superpowers dependency.
2. **Parallel subagent spawning** — the CLI did Writer + Challenger in parallel during brainstorming. Verify that multiple Agent tool calls in one message actually execute in parallel (vs. sequentially).
3. **Subagent output parsing** — exact structure of the message returned from an Agent tool call; where the structured JSON lives in the response.
4. **DDL incremental writes** — Write vs. Edit semantics for append-only decision log writes.
5. **Evidence index concurrent-append safety** — if multiple Verifier subagents run in parallel, they may try to append to the evidence index simultaneously. Serialize writes at the orchestrator.
6. **Compaction detection** — how Claude Code signals that compaction has occurred, so the orchestrator can re-inject the evidence index before the next subagent invocation.

These don't block the spec — they're implementation tactics. The writing-plans skill surfaces them during plan drafting.
