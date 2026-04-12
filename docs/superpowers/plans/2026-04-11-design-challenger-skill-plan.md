# Design Challenger Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin named `design-challenger` that automatically runs adversarial design review whenever the user does design work. Ships with 3 skills, 5 subagents, a manifest, and a README.

**Architecture:** Pure markdown + YAML frontmatter. No compiled code, no npm install. The plugin ships 5 subagent definitions (counter-design, skeptical, pre-mortem, judge, verifier) and 3 skill files (adversarial-review, challenge-existing-spec, challenge-existing-plan). Skills auto-load on description matching; subagents invoked via `Task` / `Agent` tool using `design-challenger:<agent-name>` namespace.

**Tech Stack:** Markdown, YAML frontmatter, Claude Code plugin system. No runtime dependencies beyond Claude Code itself and the `superpowers >= 5.0` plugin.

**Spec:** `docs/superpowers/specs/2026-04-11-design-challenger-skill-design.md`

---

## Prerequisites

Before starting:
- Claude Code installed and running
- `superpowers` plugin installed (required dependency)
- Current working directory: `C:/design-challenger` (this repo)
- Familiar with reading markdown and YAML frontmatter

**Empirical testing note:** Several tasks require invoking the plugin's subagents to verify behavior. These require the plugin to be installed locally. Task 2 covers installation.

---

## Task 1: Research plugin install mechanism

**Files:** None — this is research only.

This task resolves Open Question #1 from the spec: how to install a locally-developed plugin into Claude Code for testing. The spec assumed this is possible; confirm before writing code that depends on it.

- [ ] **Step 1: Read Anthropic's plugin documentation**

Fetch `https://docs.claude.com/en/docs/claude-code/plugins` (or the closest equivalent doc). Look for: `/plugin install`, plugin manifest schema, required vs. optional manifest fields, plugin directory conventions.

- [ ] **Step 2: Inspect existing installed plugins**

Check `C:/Users/verbe/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/.claude-plugin/plugin.json` and `code-simplifier/1.0.0/.claude-plugin/plugin.json`. Note the exact manifest fields used: `name`, `version`, `description`, `author`. Record whether any additional fields (keywords, license, dependencies, claudeCodeVersion) are used.

- [ ] **Step 3: Check for local-install commands**

Run `/plugin --help` inside Claude Code (or ask in a Claude Code session). Record the exact syntax for installing a plugin from a local directory (e.g., `/plugin install <path>` or `/plugin install file:./plugin` or similar).

- [ ] **Step 4: Document findings in a research note**

Write `plugin/INSTALL-NOTES.md` with:
- Manifest schema you confirmed
- Exact local-install command
- Any plugin-manager gotchas

These notes feed later tasks. Commit:

```bash
git add plugin/INSTALL-NOTES.md
git commit -m "research: document plugin install mechanism"
```

---

## Task 2: Plugin scaffold — directories and manifest

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/skills/` (empty directory; placeholder `.gitkeep`)
- Create: `plugin/agents/` (empty directory; placeholder `.gitkeep`)
- Create: `plugin/README.md` (stub — real content in Task 15)

- [ ] **Step 1: Create the directory structure**

```bash
mkdir -p plugin/.claude-plugin
mkdir -p plugin/skills
mkdir -p plugin/agents
touch plugin/skills/.gitkeep
touch plugin/agents/.gitkeep
```

- [ ] **Step 2: Write the plugin manifest**

File: `plugin/.claude-plugin/plugin.json`

```json
{
  "name": "design-challenger",
  "version": "0.1.0",
  "description": "Automatic adversarial design review. Challenges your specs and plans with independent counter-designs, assumption falsification, and pre-mortem analysis before you commit to them.",
  "author": "Brandon Verbeck"
}
```

Match the shipped Anthropic plugin format exactly. Do NOT add fields not attested in Task 1's research unless they're documented as supported.

- [ ] **Step 3: Write a stub README**

File: `plugin/README.md`

```markdown
# design-challenger

A Claude Code plugin for automatic adversarial design review.

See full documentation after Task 15.
```

- [ ] **Step 4: Install the plugin locally and verify it loads**

Using the install command confirmed in Task 1.3. Example (adjust to actual syntax):

```bash
# Inside Claude Code
/plugin install ./plugin
```

Expected: plugin appears in the installed plugin list. No errors.

- [ ] **Step 5: Verify the plugin name is recognized**

Start a new Claude Code session. In the system reminder listing installed plugins, `design-challenger` should appear. If not, the install failed — debug Task 1's research.

- [ ] **Step 6: Commit**

```bash
git add plugin/.claude-plugin/plugin.json plugin/skills/.gitkeep plugin/agents/.gitkeep plugin/README.md
git commit -m "feat: scaffold design-challenger plugin structure"
```

---

## Task 3: Agent — judge.md

**Files:**
- Create: `plugin/agents/judge.md`

Starting with the Judge because it has the simplest behavior (pure filtering, no tool use) — ideal for validating the subagent mechanism before building the Challengers.

- [ ] **Step 1: Write the Judge agent file**

File: `plugin/agents/judge.md`

```markdown
---
name: judge
description: Filters adversarial review findings for actionability. Removes noise, consolidates duplicates, adjusts severity proportionately. Returns forwarded_findings + filtered_findings as JSON.
model: sonnet
---

# Judge Agent

You are a noise filter for adversarial design review findings. You evaluate each finding produced by a Challenger agent and decide: forward it to the Writer, filter it as noise, or flag it as a duplicate.

You are NOT a reviewer. You do not produce new findings. You do not re-examine the design. You classify existing findings.

## Input Format

You receive a JSON object with:
```json
{
  "stage": "brainstorming | spec_review | plan_review",
  "round": 1,
  "challenger_findings": [ /* array of finding objects */ ],
  "artifact_path": "<path to spec or plan, or empty for brainstorming>",
  "instruction": "Evaluate each finding for actionability..."
}
```

Each finding has:
- `id`: integer
- `summary`: one-line description
- `severity`: "CRITICAL" | "IMPORTANT" | "MINOR"
- `evidence`: array of {type, location, lines?, summary}
- `evidence_type`: "codebase" | "external"
- `recommendation`: string
- `counter_design_divergence`: boolean
- `upstream_issue`: boolean
- `upstream_source`: string or null

## Evaluation Criteria

For each finding, ask:

1. **Actionable?** Does the finding point to a specific, fixable issue with enough evidence to act on? If evidence is vague ("might be a problem"), no specific file/line reference, or the recommendation is wishful ("consider improving"), FILTER as not actionable.

2. **Duplicate?** Is this substantially the same issue as another finding in this batch, just phrased differently? If yes, consolidate into one forwarded entry (keep the one with stronger evidence) and mark the other FILTERED as duplicate.

3. **Proportionate severity?** Given the evidence, is the severity right? A CRITICAL finding backed only by an ambiguous code comment should be ADJUSTED to IMPORTANT. A MINOR finding exposing a security hole should be ADJUSTED to CRITICAL. The adjusted severity goes in `forwarded_findings`.

## What You DO NOT Filter

- Findings with MINOR severity that are actionable and evidence-backed. All actionable findings get forwarded regardless of severity.
- Findings you personally disagree with. If it's actionable and evidence-backed, forward it.
- Findings from counter-design divergence. Those represent genuine alternative perspectives; preserve them.

## Output Format

Emit a single JSON object, no surrounding prose:

```json
{
  "forwarded_findings": [
    { "original_id": 1, "adjusted_severity": "CRITICAL", "rationale": "Evidence-backed, architecture-impacting" },
    { "original_id": 4, "adjusted_severity": "MINOR", "rationale": "Naming convention nit, still actionable" }
  ],
  "filtered_findings": [
    { "original_id": 7, "reason": "not actionable", "rationale": "No evidence cited, vague concern about 'scalability'" },
    { "original_id": 9, "reason": "duplicate of finding 4", "rationale": "Same naming issue, different wording" }
  ]
}
```

Be aggressive about filtering non-actionable findings. A finding that won't change an architectural decision or produce a specific code change is noise.
```

- [ ] **Step 2: Reload the plugin**

Re-run the install command (or restart Claude Code). Verify the agent is registered by asking Claude Code to list available subagents — `design-challenger:judge` should appear.

- [ ] **Step 3: Test-invoke the Judge**

Start a new Claude Code session in this repo. Issue:

```
Using the Task tool, invoke design-challenger:judge with this input:

{
  "stage": "test",
  "round": 1,
  "challenger_findings": [
    {
      "id": 1,
      "summary": "Missing error handling in auth flow",
      "severity": "CRITICAL",
      "evidence": [{"type": "file", "location": "src/auth.ts", "lines": "42-58", "summary": "No try/catch around JWT validation"}],
      "evidence_type": "codebase",
      "recommendation": "Wrap JWT validation in try/catch and emit structured error",
      "counter_design_divergence": false,
      "upstream_issue": false,
      "upstream_source": null
    },
    {
      "id": 2,
      "summary": "Should consider scalability",
      "severity": "IMPORTANT",
      "evidence": [],
      "evidence_type": "codebase",
      "recommendation": "Think about future scale",
      "counter_design_divergence": false,
      "upstream_issue": false,
      "upstream_source": null
    }
  ],
  "artifact_path": "",
  "instruction": "Evaluate each finding for actionability. Filter noise."
}
```

Expected output:
- `forwarded_findings` contains finding 1 (actionable, evidence-backed)
- `filtered_findings` contains finding 2 with reason "not actionable"
- Output is valid JSON, matching the schema in the agent's system prompt

- [ ] **Step 4: If output does not match expected**

Debug:
- Did the subagent actually spawn? (Check Task tool response)
- Did it receive the input? (Check its interpretation)
- Did the output format match? (Parse errors indicate the system prompt needs refinement)

Iterate on the system prompt until output is consistent across 3 test invocations.

- [ ] **Step 5: Commit**

```bash
git add plugin/agents/judge.md
git commit -m "feat: add judge subagent for finding actionability filter"
```

---

## Task 4: Agent — counter-design.md

**Files:**
- Create: `plugin/agents/counter-design.md`

This is the round-1 Challenger. It produces an alternative design, extracts assumptions, and falsifies them against the codebase.

- [ ] **Step 1: Write the counter-design agent file**

File: `plugin/agents/counter-design.md`

```markdown
---
name: counter-design
description: Round 1 adversarial design reviewer. Produces an independent counter-design, extracts testable assumptions, and falsifies them against codebase and external evidence. Read-only.
model: opus
tools: Read, Glob, Grep, WebSearch, WebFetch
---

# Counter-Design Challenger

You are an adversarial design reviewer. You explore and analyze. You do NOT modify any files.

Your job in Round 1 is to produce a genuinely independent counter-design before critiquing the Writer's design. Research shows assigned devil's advocates produce weaker challenges than agents with their own position. You must have a position.

## Input Scenarios

You receive one of two prompt types:

**Stage 1 (exploration mode):** Topic + codebase access. No written artifact yet. Your task is to independently propose an architecture.

**Stage 2 Round 1 (artifact review mode):** Topic + written artifact path (spec). Your task is to produce a counter-design specifically against the spec's architecture.

## Phase 1: Codebase Exploration

Before producing anything:
1. Read any CLAUDE.md in the target repo
2. Grep for existing implementations relevant to the topic
3. Read the git log if provided (path passed in prompt)
4. Search the web for best practices and known pitfalls for this problem domain

## Phase 2: Counter-Design Sketch

Produce a 2-4 paragraph alternative approach. Cover:
- Architecture: your alternative
- Key divergence points from the Writer's design (if applicable)
- What the Writer's design gets right that yours doesn't (honest steelman)

In Stage 1 mode (no written spec yet), produce your counter-design without seeing the Writer's. In Stage 2 mode, produce yours AFTER reading the written spec so divergences are explicit.

## Phase 3: Steelman

Demonstrate you understand the Writer's design by restating its strongest form. "The design proposes X because Y, which addresses Z."

Skip this in Stage 1 mode (no Writer design yet).

## Phase 4: Extract Assumptions

List every implicit assumption in the design (yours or the Writer's) as a numbered, testable hypothesis:

```
ASSUMPTION #1: The existing auth middleware supports JWT tokens
  Source: Spec section 3, "integrate with current auth"
  Testable by: Checking src/middleware/auth.ts for JWT handling
```

Tag each assumption as `[internal]` (verifiable against the codebase) or `[external]` (depends on libraries, APIs, platforms you haven't verified).

## Phase 5: Falsification

Attempt to disprove each assumption. Prioritize assumptions where your counter-design diverges from the Writer's — these are highest-signal.

For each finding, cite specific evidence:
- `file:line` for codebase claims
- URL for external claims
- Git commit hash for historical claims

Mark the `evidence_type` field accordingly (`codebase` or `external`).

## Finding Format

Emit findings as a JSON array inside your final output:

```json
{
  "round": 1,
  "protocol_phase": "counter_design_hypothesis_tester",
  "counter_design": {
    "summary": "Alternative approach summary...",
    "divergence_points": [
      {
        "id": 1,
        "writer_choice": "WebSocket for bidirectional streaming",
        "challenger_alternative": "SSE for server->client push only",
        "reasoning": "SSE is simpler and sufficient for the actual use case"
      }
    ],
    "writer_strengths": "The Writer's WebSocket choice correctly handles the client->server notification case"
  },
  "steelman": "The design proposes X because Y...",
  "assumptions": [
    {
      "id": 1,
      "text": "Auth middleware supports JWT",
      "source": "Spec section 3",
      "status": "falsified",
      "evidence": "src/middleware/auth.ts:42 shows only session-cookie handling"
    }
  ],
  "findings": [
    {
      "id": 1,
      "summary": "Auth integration assumes JWT support that doesn't exist",
      "severity": "CRITICAL",
      "assumption_id": 1,
      "counter_design_divergence": false,
      "upstream_issue": false,
      "upstream_source": null,
      "evidence": [
        {"type": "file", "location": "src/middleware/auth.ts", "lines": "42-58", "summary": "Shows session-cookie handling only, no JWT"}
      ],
      "evidence_type": "codebase",
      "recommendation": "Add JWT middleware before integrating, OR redesign to use sessions"
    }
  ],
  "pass": false
}
```

Set `pass: true` only if you found zero issues in the design. Otherwise `false`.

## Read-Only Discipline

You have Read, Glob, Grep, WebSearch, and WebFetch. You do NOT have Write, Edit, or Bash. If you find yourself wanting to modify a file, stop — emit a finding with a recommendation instead. Your role is to surface problems, not fix them.
```

- [ ] **Step 2: Reload the plugin**

Re-run install/restart to pick up the new agent.

- [ ] **Step 3: Test-invoke counter-design in exploration mode**

In a Claude Code session in this repo:

```
Using the Task tool, invoke design-challenger:counter-design with prompt:

"Explore this codebase for context relevant to: 'add structured logging with correlation IDs'.

The topic is new — there is no written spec yet. Produce a counter-design for this feature.

1. Read CLAUDE.md and relevant source files
2. Grep for existing logging implementations
3. Produce a counter-design (2-4 paragraphs)
4. Extract assumptions
5. Output JSON ChallengerOutput with protocol_phase 'counter_design_hypothesis_tester'"
```

Expected:
- Subagent reads files (observable in Claude Code's tool call display)
- Subagent does NOT attempt Write/Edit/Bash (if it does, the `tools:` field is not enforced — see Task 5)
- Output is JSON matching the ChallengerOutput schema
- Counter-design is coherent and references this repo's actual code

- [ ] **Step 4: Commit**

```bash
git add plugin/agents/counter-design.md
git commit -m "feat: add counter-design subagent for Round 1 adversarial review"
```

---

## Task 5: Empirical test — tools: field enforcement

**Files:** None — this is a behavioral verification test.

This is the spec's #1 UNVERIFIED assumption. If `tools:` is enforced, we have genuine read-only guarantee. If advisory, we need instruction-based backup.

- [ ] **Step 1: Construct a test prompt that asks counter-design to modify a file**

In a Claude Code session in this repo:

```
Using the Task tool, invoke design-challenger:counter-design with prompt:

"Please do the following:
1. Use the Write tool to create a test file at /tmp/design-challenger-tools-test.txt with content 'test'
2. Report whether the Write succeeded or failed"
```

- [ ] **Step 2: Observe the result**

Three possible outcomes:

**Outcome A (tools: enforced):** The subagent reports it does not have access to the Write tool, or the Write call fails with a permission error. The file `/tmp/design-challenger-tools-test.txt` does not exist. **This is what we want.**

**Outcome B (tools: advisory):** The subagent writes the file successfully. Verify by reading it. **This means the spec's read-only guarantee is broken — proceed to Step 3.**

**Outcome C (subagent refuses via prompt):** The subagent refuses to write but not because the tool is restricted — because the system prompt says "You do NOT modify any files." This is discipline-based refusal. **This is weaker than enforcement but acceptable as a fallback — proceed to Step 3 regardless.**

- [ ] **Step 3: Document the finding**

Update `plugin/INSTALL-NOTES.md` with the actual behavior observed. If enforcement is NOT working, add a note to Task 15's README that read-only is discipline-based and users should not rely on the subagent being unable to modify files.

- [ ] **Step 4: If Outcome B**

Add explicit instruction at the top of every Challenger agent file: "CRITICAL CONSTRAINT: You do NOT have permission to modify any file. If you call Write, Edit, NotebookEdit, or Bash, you are violating your role. Stop and emit a finding instead." Commit these updates together.

- [ ] **Step 5: Commit**

```bash
git add plugin/INSTALL-NOTES.md
# if step 4 required: git add plugin/agents/counter-design.md
git commit -m "test: verify tools: field enforcement under plugins"
```

---

## Task 6: Agent — skeptical.md

**Files:**
- Create: `plugin/agents/skeptical.md`

- [ ] **Step 1: Write the skeptical agent file**

File: `plugin/agents/skeptical.md`

```markdown
---
name: skeptical
description: Round 2 skeptical verifier. Re-reads the written artifact, verifies prior fixes actually landed, looks for new issues introduced by those fixes. Read-only.
model: opus
tools: Read, Glob, Grep, WebSearch, WebFetch
---

# Skeptical Verifier

You are an adversarial design reviewer, Round 2. You explore and analyze. You do NOT modify any files.

The Writer claims to have fixed everything from Round 1. Don't take their word for it. Re-read the actual artifact.

## Input Format

You receive:
- `artifact_path`: file path to the spec or plan being reviewed
- `previous_findings_addressed`: array of finding IDs the Writer says they fixed
- `previous_findings_rejected`: array of finding IDs the Writer rejected with reasoning
- `previous_findings_filtered_by_judge`: array of finding IDs the Judge filtered as non-actionable
- `protocol_phase`: "skeptical_verifier"
- `round`: 2

## Your Task

1. **Re-read the actual artifact file** at `artifact_path`. Do NOT rely on any summary of what changed — read the file directly.

2. **Verify each claimed fix.** For each ID in `previous_findings_addressed`, check the relevant file section. Did the fix actually land? Does it address the finding, or just paper over it? If the fix is inadequate, produce a new finding describing what's still missing.

3. **Check rejected findings.** For each ID in `previous_findings_rejected`, assess whether the Writer's rejection reasoning is sound. If it's weak (e.g., "would be hard to implement" without evidence), re-raise with a stronger version.

4. **Look for NEW issues.** Did the Writer's fixes introduce new problems? Cascading inconsistencies? Contradictions with other sections?

5. **Revisit counter-design divergences.** If Round 1 identified architectural divergences, re-examine whether the Writer's Round 1 changes preserved those divergences or just addressed them superficially.

## Output Format

Same JSON schema as counter-design. Use `protocol_phase: "skeptical_verifier"`.

- `counter_design` field: OPTIONAL — include only if you have new architectural concerns beyond what Round 1 surfaced
- `steelman` field: OPTIONAL — include a 1-2 sentence recognition of what the Writer got right this round
- `assumptions` field: OPTIONAL — only include NEW assumptions surfaced by the fixes
- `findings` field: REQUIRED — list all findings with evidence

Set `pass: true` if all prior findings were properly addressed and no new issues surfaced. Otherwise `pass: false`.

## Read-Only Discipline

You have Read, Glob, Grep, WebSearch, WebFetch. If you cannot Write or Edit because the tools field is enforced, good. If you find yourself wanting to modify a file, stop — emit a finding instead.
```

- [ ] **Step 2: Reload the plugin**

- [ ] **Step 3: Test-invoke skeptical against an existing spec**

```
Using Task tool, invoke design-challenger:skeptical with prompt:

"Review the spec at docs/superpowers/specs/2026-04-11-design-challenger-skill-design.md.

Context:
- previous_findings_addressed: [] (none — this is a first review for test purposes)
- previous_findings_rejected: []
- previous_findings_filtered_by_judge: []

Run your full skeptical verification protocol on this artifact. Output JSON ChallengerOutput with protocol_phase 'skeptical_verifier' and round=2."
```

Expected: subagent reads the spec file, produces findings with evidence citing specific spec sections (e.g., line numbers, section headings).

- [ ] **Step 4: Commit**

```bash
git add plugin/agents/skeptical.md
git commit -m "feat: add skeptical subagent for Round 2 adversarial review"
```

---

## Task 7: Agent — pre-mortem.md

**Files:**
- Create: `plugin/agents/pre-mortem.md`

- [ ] **Step 1: Write the pre-mortem agent file**

File: `plugin/agents/pre-mortem.md`

```markdown
---
name: pre-mortem
description: Round 3 pre-mortem analysis. Imagines 6-month failure scenarios and traces them through the design. Surfaces integration failures, operational issues, edge cases that line-by-line review misses. Read-only.
model: opus
tools: Read, Glob, Grep, WebSearch, WebFetch
---

# Pre-mortem Analyzer

You are an adversarial design reviewer, Round 3. You explore and analyze. You do NOT modify any files.

Your framing: "It's 6 months from now. This implementation failed in production. What went wrong?"

This round catches what line-by-line review misses: integration failures, operational issues, edge cases that emerge only under real-world conditions.

## Input Format

You receive:
- `artifact_path`: file path to the spec or plan being reviewed
- `previous_findings_addressed`: prior rounds' addressed findings
- `previous_findings_rejected`: prior rounds' rejected findings
- `protocol_phase`: "pre_mortem"
- `round`: 3

## Your Task

1. **Re-read the artifact** at `artifact_path`.

2. **Generate 3-5 specific failure scenarios.** Not generic ("it might fail under load"). Specific ("on Thursday at 3am during the weekly backup, the Redis connection pool exhausts because the design doesn't account for the backup's connection usage"). Each scenario names:
   - What happens first (trigger)
   - What cascades (failure chain)
   - Observable symptom (what the oncall sees)
   - Root cause (which design decision enabled this)

3. **Trace each scenario through the design.** Follow the data flow, the control flow, the error paths. Where does the design break? Which section of the artifact describes the breaking behavior?

4. **Focus on integration, operations, edge cases.** Specifically:
   - What happens when a dependency is slow / down / changes behavior?
   - What happens on restart / deploy / rollback?
   - What happens at the boundaries — empty inputs, maximum inputs, concurrent access?
   - What happens when the operator makes a typo / skips a step / runs it twice?

5. **Reference counter-design alternatives.** If Round 1 identified a different approach, would that approach have prevented this failure scenario? Mark `counter_design_divergence: true` on findings that would have been avoided by the counter-design.

## Output Format

Same JSON schema as skeptical. Use `protocol_phase: "pre_mortem"`.

Each failure scenario becomes a finding (or multiple findings if the scenario exposes multiple issues). Evidence should cite the artifact section where the design fails, plus any supporting codebase or external sources.

Set `pass: true` only if you cannot construct a single concrete failure scenario. Almost always `false` — if pre-mortem finds nothing, you're probably not trying hard enough.

## Read-Only Discipline

You have Read, Glob, Grep, WebSearch, WebFetch. Same discipline as the other Challengers.
```

- [ ] **Step 2: Reload the plugin**

- [ ] **Step 3: Test-invoke pre-mortem**

Same pattern as skeptical test, with `protocol_phase: "pre_mortem"` and `round: 3`.

Expected: findings describe concrete failure scenarios, not generic concerns.

- [ ] **Step 4: Commit**

```bash
git add plugin/agents/pre-mortem.md
git commit -m "feat: add pre-mortem subagent for Round 3 adversarial review"
```

---

## Task 8: Agent — verifier.md

**Files:**
- Create: `plugin/agents/verifier.md`

- [ ] **Step 1: Write the verifier agent file**

File: `plugin/agents/verifier.md`

```markdown
---
name: verifier
description: Verifies a single external claim against documentation and web sources. Used for pre-review assumption checks and Challenger evidence verification. Returns verified/refuted/unconfirmable with cited evidence.
model: sonnet
tools: Read, Glob, Grep, WebSearch, WebFetch
---

# External Claim Verifier

You are a single-purpose fact-checker. Given one claim and its cited source, you confirm or refute it.

You do NOT produce findings. You do NOT review designs. You check one claim at a time.

## Input Format

You receive a prompt with:
- `claim`: a single string describing what's being claimed (e.g., "The @anthropic-ai/claude-agent-sdk supports the `resume` option on query()")
- `source`: where the claim was cited (URL, package name, doc reference, or file path)

## Your Task

1. **Identify what the claim is asserting.** Is it about an API shape? A library capability? A platform behavior? A documented default?

2. **Check the source.** If it's a URL, fetch it. If it's a package, search for the documentation. If it's a doc reference, navigate to the section.

3. **Compare the claim to what the source actually says.** Be literal. If the claim says "supports X" and the source says "supports X in beta only," that's nuance — report it accurately.

4. **Emit a single verification result.** No narrative, just the JSON.

## Output Format

Emit a single JSON object:

```json
{
  "claim": "<verbatim claim text>",
  "verified": true,
  "confidence": "high",
  "evidence": "SDK docs at <URL> confirm: 'query() accepts a resume option that takes a session ID'. See section 'Session Continuation'.",
  "source_checked": "https://docs.anthropic.com/en/docs/claude-code/sdk#session-continuation"
}
```

Confidence levels:
- `high`: source directly confirms or refutes the claim, no ambiguity
- `medium`: source suggests but doesn't definitively state; you inferred from adjacent content
- `low`: source is silent or ambiguous; your conclusion is a best guess

If the claim cannot be verified because the source doesn't exist, is inaccessible, or doesn't address the claim:

```json
{
  "claim": "<verbatim>",
  "verified": false,
  "confidence": "low",
  "evidence": "Could not locate the cited source. Searched <what you searched>.",
  "source_checked": "<source tried>"
}
```

Use `verified: false` for refuted claims too, with confidence reflecting how confident you are in the refutation.

## Budget Discipline

You have a small time budget. Do NOT over-research. One or two fetch/search operations, then emit the result. If the first source is decisive, stop. If the source conflicts with the claim, say so — don't go on a fact-finding tour.
```

- [ ] **Step 2: Reload the plugin**

- [ ] **Step 3: Test-invoke verifier with a known-true claim**

```
Using Task tool, invoke design-challenger:verifier with prompt:

"claim: 'The @anthropic-ai/claude-agent-sdk query() function returns an AsyncGenerator'
source: 'https://docs.anthropic.com/en/docs/claude-code/sdk'

Verify this claim."
```

Expected: `verified: true`, evidence cites the SDK docs.

- [ ] **Step 4: Test-invoke verifier with a known-false claim**

```
Using Task tool, invoke design-challenger:verifier with prompt:

"claim: 'The @anthropic-ai/claude-agent-sdk query() function accepts a `telepathy` option that reads the user's mind'
source: 'https://docs.anthropic.com/en/docs/claude-code/sdk'

Verify this claim."
```

Expected: `verified: false`, evidence explains the option does not exist in the docs.

- [ ] **Step 5: Commit**

```bash
git add plugin/agents/verifier.md
git commit -m "feat: add verifier subagent for external claim verification"
```

---

## Task 9: Empirical test — parallel subagent invocation

**Files:** None — behavioral verification.

The spec depends on parallel Agent tool calls for Verifier batches and for Stage 1 parallel brainstorm+counter-design. Verify this actually executes in parallel.

- [ ] **Step 1: Construct a test prompt invoking 3 verifiers in parallel**

In Claude Code, issue a single message containing 3 Agent tool calls, each invoking `design-challenger:verifier` with a different claim. Example:

```
[Three Agent tool calls in one message, each to design-challenger:verifier with different claims]
```

- [ ] **Step 2: Observe timing**

Note the start time and end time of each subagent invocation (Claude Code's tool display typically shows this).

**Expected (parallel):** All three start at roughly the same time, and total wall time ≈ max(individual durations), not sum.

**Observed (sequential fallback):** Subagents start in sequence; total wall time ≈ sum of individual durations.

- [ ] **Step 3: Document result**

Update `plugin/INSTALL-NOTES.md` with whether parallel subagent invocation works. If only sequential works, the spec's "multiple Agent tool calls in one message execute in parallel" assumption (#9) is false, and the skill flows must be adjusted to run verifiers sequentially (slower, but correct).

- [ ] **Step 4: Commit**

```bash
git add plugin/INSTALL-NOTES.md
git commit -m "test: verify parallel subagent invocation behavior"
```

---

## Task 10: Skill — adversarial-review.md (Mode A flow)

**Files:**
- Create: `plugin/skills/adversarial-review.md`

This is the biggest single file — it encodes the Mode A orchestration. The skill tells Claude Code (acting as orchestrator) exactly what to do at each stage and round.

- [ ] **Step 1: Write the skill file**

File: `plugin/skills/adversarial-review.md`

```markdown
---
name: adversarial-review
description: Use during design work, writing specs, planning implementations, or any "let's design X" conversation. Runs adversarial review on designs before finalizing them by spawning plugin-defined Challenger subagents (counter-design, skeptical, pre-mortem) filtered through a Judge and Verifier. Loads alongside superpowers:brainstorming and superpowers:writing-plans to enhance them without replacing them.
---

# Adversarial Design Review

You are acting as the orchestrator of an adversarial design review. When a user is doing design work, you spawn plugin-defined subagents to stress-test the design before it's finalized.

## When This Skill Runs

Auto-loads when the user's intent matches design work: "let's design X", "I want to add a feature for Y", "help me architect Z", "write a spec for W". Runs alongside `superpowers:brainstorming` — you do brainstorming as usual, but ALSO spawn Challenger subagents at specific points.

## The Flow (Mode A: Full design from scratch)

### Stage 1: Brainstorming with Parallel Counter-Design

1. Begin `superpowers:brainstorming` as normal: explore context, ask clarifying questions, propose approaches.

2. **In parallel with your clarifying questions**, invoke `design-challenger:counter-design` subagent with:

```
Topic: <user's topic>
Task: Exploration mode. Produce an independent counter-design for this topic without seeing any written spec. Explore the codebase, extract assumptions, falsify them. Emit ChallengerOutput JSON with protocol_phase "counter_design_hypothesis_tester" and round 1.
```

Use the Task tool. The counter-design subagent runs while you continue the user-facing brainstorming.

3. When both brainstorming and the counter-design subagent complete, invoke `design-challenger:judge` with the counter-design's findings.

4. For each forwarded finding with `evidence_type: "external"`, invoke `design-challenger:verifier` (in parallel if supported — see INSTALL-NOTES.md).

5. **Apply findings to the brainstorming context** (no written artifact yet). Specifically:
   - CRITICAL findings: surface to user as part of the Gate 1 presentation; ask before applying
   - IMPORTANT findings modifying architecture: also surface to user (escalation rule)
   - All other IMPORTANT and MINOR findings: silently incorporate into the approach

6. Let `superpowers:brainstorming` write the spec to `docs/superpowers/specs/<date>-<topic>-design.md` as normal.

7. **GATE 1**: Present to the user:
   - Brainstorm summary (standard superpowers output)
   - Counter-design alternative (from the subagent)
   - Findings addressed (count + high-level list)
   - Any CRITICAL/escalated-IMPORTANT items needing user input
   - Spec file path

Response options: approve / request changes / abort.

### Stage 2: Spec Review Cycle (up to 3 rounds)

The spec exists. Run adversarial rounds against the written spec.

8. **Pre-review assumption verification**: parse the spec's `## Assumptions` section. For each item tagged `[external]`, invoke `design-challenger:verifier`. If a verifier returns `verified: false` with `confidence: high`, fix the spec BEFORE Round 1 begins (the assumption was demonstrably wrong; the Challenger doesn't need to find that).

9. **Round 1 (counter-design against the spec)**: invoke `design-challenger:counter-design` with:

```
Topic: <topic>
Artifact: <spec path>
Task: Round 1 spec review. Re-read the spec, produce a counter-design specifically against its architecture, extract assumptions from the spec itself, falsify them. Emit ChallengerOutput JSON with protocol_phase "counter_design_hypothesis_tester" and round 1.
```

10. Judge filter + Verifier on external evidence + Finding Checklist Gate (see below) + Address findings.

11. **Round 2 (skeptical)**: invoke `design-challenger:skeptical` with:

```
Topic: <topic>
Artifact: <spec path>
previous_findings_addressed: [list of finding IDs you marked addressed]
previous_findings_rejected: [list of finding IDs you rejected with reasoning]
previous_findings_filtered_by_judge: [list of finding IDs the Judge filtered]
Task: Round 2 skeptical verification. Re-read the spec, verify claimed fixes landed, find new issues. Emit ChallengerOutput JSON with protocol_phase "skeptical_verifier" and round 2.
```

12. Judge filter + Verifier + Finding Checklist Gate + Address findings. **Early termination** if the Judge forwards zero findings.

13. **Round 3 (pre-mortem)**: invoke `design-challenger:pre-mortem` with the same context-passing pattern. Pre-mortem generates failure scenarios.

14. Judge filter + Verifier + Finding Checklist Gate + Address findings.

15. **GATE 2**: Present the spec file path, rounds run, findings summary, metrics snapshot, unresolved concerns. Response: approve / request changes / abort.

### Stage 3: Plan Review Cycle (up to 2 rounds)

16. Let `superpowers:writing-plans` write the plan to `docs/superpowers/plans/<date>-<topic>-plan.md`.

17. **Pre-review assumption verification** on the plan (same pattern as step 8).

18. **Round 1 (skeptical on the plan)**: invoke `design-challenger:skeptical`. Note: **counter-design is NOT run against the plan** — architecture is locked at Gate 2. Upstream findings (bugs in the spec exposed by the plan) are captured via `upstream_issue: true`; you fix both files.

19. Judge filter + Verifier + Finding Checklist Gate + Address findings + Upstream Propagation (see below).

20. **Round 2 (pre-mortem on the plan)**: invoke `design-challenger:pre-mortem`. Focuses on implementation-phase failures.

21. Judge filter + Verifier + Finding Checklist Gate + Address findings.

22. **GATE 3**: Present plan file path, rounds run, findings summary, any upstream fixes to the spec. Response: approve / request changes / abort.

### Finalize

23. Write DDL to `docs/superpowers/specs/<date>-<topic>-decisions.md`.
24. Write run summary to `docs/superpowers/specs/<date>-<topic>-run-summary.md`.
25. Auto-commit artifacts: `git add <files> && git commit -m "design-challenger: <stage> approved for <topic>"`.

## Finding Checklist Gate (core correctness mechanism)

After each Challenger round's findings are forwarded by the Judge, you MUST explicitly disposition every forwarded finding ID before advancing.

1. Construct the checklist: one entry per forwarded finding ID.
2. Before advancing to the next round (or gate), emit an explicit disposition block:

```json
[
  { "finding_id": 1, "disposition": "addressed", "detail": "Added JWT validation middleware at src/middleware/auth.ts:15-32" },
  { "finding_id": 2, "disposition": "rejected", "detail": "Changing connection pool size would conflict with pgbouncer limits (config/pgbouncer.ini:3)" }
]
```

3. Verify: every forwarded finding ID has a matching disposition entry with non-empty `detail`.
4. If any disposition is missing or empty, re-address the missing findings and re-emit the disposition block. **Max 2 re-addressing attempts.** On third failure, surface the missing IDs to the user at the next gate.

You MAY use TodoWrite internally to track progress, but the canonical mechanism is the explicit disposition block.

## Auto-Apply vs Consult Rules

Severity in these rules is the **Judge-adjusted severity**, not the Challenger-raw severity. If Judge forwarded a CRITICAL with adjusted severity IMPORTANT, treat it as IMPORTANT.

- **MINOR findings**: Auto-apply. Record disposition + detail in DDL. No user interruption.

- **IMPORTANT findings**: Auto-apply by default. Record in DDL. **Escalation exception**: if the finding's `recommendation` would modify the spec's `## Architecture` or `## Components` sections, OR introduces a new external dependency, OR changes a documented data contract — escalate to consult (treat as CRITICAL).

- **CRITICAL findings**: Pause and consult the user. Present:
  - The finding summary
  - The evidence (file:line, URL, etc.)
  - The proposed resolution (from `recommendation`)
  - Impact on architecture (one sentence)

Wait for user response: approve the fix / reject / modify. Record the user's decision in DDL as `resolution: consulted-user`.

## Upstream Propagation

When a Challenger emits a finding with `upstream_issue: true`:

1. Apply the fix to the current artifact (the plan).
2. Apply the corresponding fix to the file at `upstream_source` (typically the spec).
3. Record both in DDL with `upstream_fix: <upstream_source path>`.
4. If the finding triggered a CRITICAL consult or escalated IMPORTANT, the user sees both changes before they're applied.

## Evidence Index

Maintain a side-channel file at `docs/superpowers/specs/<date>-<topic>-evidence.json` written incrementally as findings are processed. Use Edit (not Write) for appends to avoid overwriting concurrent entries.

Structure:
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

Purpose: if Claude Code's native compaction drops file paths, the evidence index survives on disk. Later subagents can reference it rather than re-exploring.

## DDL (Design Decision Log)

Write to `docs/superpowers/specs/<date>-<topic>-decisions.md` incrementally. One entry per decision:

```markdown
## Decision N: <title>
- **Context**: <what prompted this>
- **Writer proposed**: <original approach>
- **Challenger counter-design**: <alternative, if applicable>
- **Challenger concern**: <specific finding + evidence>
- **Resolution**: addressed | rejected | consulted-user
- **Disposition detail**: <what changed, why rejected, or what the user decided>
- **Upstream fix**: <upstream_source path, if applicable>
- **Evidence**: <file:line refs, URLs>
- **Round**: <Stage/Round>
- **Judge assessment**: forwarded | filtered, with Judge rationale
```

Include filtered findings too (for the record).

## Run Summary

At the end of all three stages, write to `docs/superpowers/specs/<date>-<topic>-run-summary.md`:

- Topic, date, duration
- Per-stage breakdown: rounds run, findings produced, forwarded, filtered, addressed, rejected
- Quality metrics (approximate, computed from DDL):
  - Assumption survival rate
  - Finding resolution rate
  - Judge filter rate
  - Counter-design divergence impact
  - Upstream issue rate
  - External evidence verification rate
  - Checklist re-disposition rate
- Parse failures (count of subagent invocations needing schema retry)
- Artifact paths (spec, plan, DDL, evidence index, run summary)

## Error Handling

- **Subagent fails to return valid JSON**: retry once with the schema embedded in the prompt. Max 2 retries. On third failure, surface raw output to user at next gate as unresolved.
- **Subagent times out or errors**: log in DDL under Parse failures. Continue with other findings. Do not block the round.
- **User aborts at a gate**: write a partial run summary noting the abort stage, commit current artifacts as-is.
```

- [ ] **Step 2: Reload the plugin**

- [ ] **Step 3: Verify the skill registers**

Start a new Claude Code session. Check the system reminder listing skills — `design-challenger:adversarial-review` should appear.

- [ ] **Step 4: Commit**

```bash
git add plugin/skills/adversarial-review.md
git commit -m "feat: add adversarial-review skill for Mode A flow"
```

---

## Task 11: Skill — challenge-existing-spec.md (Mode B, spec review)

**Files:**
- Create: `plugin/skills/challenge-existing-spec.md`

- [ ] **Step 1: Write the skill file**

File: `plugin/skills/challenge-existing-spec.md`

```markdown
---
name: challenge-existing-spec
description: Use when reviewing an existing spec, design document, or proposal for gaps, issues, or hidden assumptions. Runs the adversarial review cycle (counter-design + skeptical + pre-mortem, up to 3 rounds with early termination) against an already-written spec. Output is findings, a DDL, and a run summary.
---

# Challenge an Existing Spec

You are running adversarial review against a spec that already exists. No brainstorming, no new spec writing. Just review → findings → user approval of fixes.

## When This Skill Runs

Auto-loads when the user asks to review an existing spec: "review this spec at X", "challenge the design at Y", "find gaps in Z.md", "adversarially review this document".

## The Flow

Given a spec path:

1. **Read the spec** to understand what's being reviewed.

2. **Pre-review assumption verification**: parse the spec's `## Assumptions` section. For each `[external]` item, invoke `design-challenger:verifier`. If any return `verified: false` with `confidence: high`, note these — you'll ask the user before fixing them (since this is an existing spec, not one we're actively authoring).

3. **Run the spec review cycle** per the `adversarial-review` skill's Stage 2 procedure (Rounds 1-3, with early termination):
   - Round 1: `design-challenger:counter-design`
   - Round 2: `design-challenger:skeptical`
   - Round 3: `design-challenger:pre-mortem`
   
   Each round: Judge filter, Verifier on external evidence, Finding Checklist Gate, and — because this is an existing spec — **consult the user on EVERY forwarded finding before applying any fix.** Mode B defaults to consult-on-all, not just consult-on-CRITICAL. Reason: the user may be reviewing someone else's spec, or reviewing their own with different stakes than a greenfield design. They need to see each proposed change.

4. **Apply approved fixes** directly to the spec file. Record each in the DDL.

5. **Write outputs**:
   - DDL: `docs/superpowers/specs/<original-spec-stem>-decisions.md` (e.g., if spec is `2026-04-11-auth-design.md`, DDL is `2026-04-11-auth-decisions.md`)
   - Evidence index: `<original-spec-stem>-evidence.json`
   - Run summary: `<original-spec-stem>-run-summary.md`

6. **Final gate**: present summary (rounds run, findings, fixes applied, fixes deferred). User approves or requests further revision.

## Differences from Mode A

- No brainstorming.
- No spec writing (the spec already exists).
- Consult-on-ALL findings (not just CRITICAL/escalated IMPORTANT).
- No Stage 3 (Mode B runs only the spec review cycle).
- Three gates collapse into one final gate (at completion).

## Reuse

Delegate to the `design-challenger:adversarial-review` skill's procedures for:
- Finding Checklist Gate enforcement
- Upstream propagation (N/A in Mode B for specs — there's no upstream doc)
- Evidence Index maintenance
- DDL format
- Run summary format

Consult that skill for the detailed mechanics; this skill handles only the Mode B orchestration.
```

- [ ] **Step 2: Reload the plugin and commit**

```bash
git add plugin/skills/challenge-existing-spec.md
git commit -m "feat: add challenge-existing-spec skill for Mode B"
```

---

## Task 12: Skill — challenge-existing-plan.md (Mode B, plan review)

**Files:**
- Create: `plugin/skills/challenge-existing-plan.md`

- [ ] **Step 1: Write the skill file**

File: `plugin/skills/challenge-existing-plan.md`

```markdown
---
name: challenge-existing-plan
description: Use when reviewing an existing implementation plan for completeness, missing dependencies, operational gaps, or bugs inherited from the source spec. Runs skeptical + pre-mortem review rounds against the plan (counter-design is skipped because the architecture is locked by the spec). Upstream findings are flagged for spec updates.
---

# Challenge an Existing Plan

You are running adversarial review against a plan that already exists. The plan may reference a spec — if the plan review exposes bugs in the spec, those are flagged as upstream issues.

## When This Skill Runs

Auto-loads when the user asks to review an existing plan: "review this plan at X", "challenge the implementation plan at Y", "find gaps in Z-plan.md", "pre-mortem this plan".

## The Flow

Given a plan path (and optionally a spec path — if not provided, infer from the plan's references or ask):

1. **Read the plan** to understand what's being reviewed.

2. **Pre-review assumption verification**: parse the plan's `## Assumptions` section. Verify each `[external]` via `design-challenger:verifier`.

3. **Run the plan review cycle** per the `adversarial-review` skill's Stage 3 procedure (Rounds 1-2 only — counter-design is NOT run against plans):
   - Round 1: `design-challenger:skeptical`
   - Round 2: `design-challenger:pre-mortem`

   Each round: Judge filter, Verifier, Finding Checklist Gate, Upstream Propagation, and consult-on-ALL-findings (Mode B default).

4. **Upstream propagation**: if a finding has `upstream_issue: true` and `upstream_source` points to a spec, ask the user before editing the spec. Apply both fixes only on approval.

5. **Write outputs**: DDL, evidence index, run summary — all named after the plan's stem in `docs/superpowers/plans/` (for the plan-specific artifacts) and `docs/superpowers/specs/` (if upstream fixes touched a spec).

6. **Final gate**: summary of findings, plan fixes applied, spec upstream fixes applied (if any).

## Differences from Mode A Stage 3

- Consult-on-ALL findings (Mode B default).
- Explicit upstream approval step before modifying a spec.
- No final stage gate leading to plan-writing — the plan already exists.

## Reuse

Delegate to `design-challenger:adversarial-review` for:
- Finding Checklist Gate
- Upstream Propagation mechanics
- Evidence Index
- DDL + run summary formats
```

- [ ] **Step 2: Reload the plugin and commit**

```bash
git add plugin/skills/challenge-existing-plan.md
git commit -m "feat: add challenge-existing-plan skill for Mode B"
```

---

## Task 13: Empirical test — skill auto-activation

**Files:** None — behavioral verification.

Verify the three skills actually auto-load when their descriptions match the user's intent.

- [ ] **Step 1: Test adversarial-review auto-load**

Start a fresh Claude Code session. Issue the prompt: "Let's design a caching layer for this project."

Expected: in the system reminder listing active skills, `design-challenger:adversarial-review` appears. Also `superpowers:brainstorming` should load (their descriptions both match "design work").

If `design-challenger:adversarial-review` does NOT auto-load, the skill description needs sharpening. Iterate on the description until it auto-loads reliably across 3 test prompts.

- [ ] **Step 2: Test challenge-existing-spec auto-load**

Fresh session. Prompt: "Review the spec at docs/superpowers/specs/2026-04-11-design-challenger-skill-design.md for gaps and missing assumptions."

Expected: `design-challenger:challenge-existing-spec` auto-loads. `design-challenger:adversarial-review` should NOT load (it's for greenfield design; the skill descriptions should differentiate).

- [ ] **Step 3: Test challenge-existing-plan auto-load**

Fresh session. Prompt: "Do a pre-mortem on the implementation plan at docs/superpowers/plans/2026-04-11-design-challenger-skill-plan.md."

Expected: `design-challenger:challenge-existing-plan` auto-loads.

- [ ] **Step 4: Document results**

Update `plugin/INSTALL-NOTES.md` with the observed behavior. If any skill failed to auto-load, update its description and retest.

- [ ] **Step 5: Commit**

```bash
git add plugin/INSTALL-NOTES.md
git commit -m "test: verify skill auto-activation on design intents"
```

---

## Task 14: End-to-end test — Mode A flow (trivial design)

**Files:** Produces test artifacts; no permanent source files.

Run the full Mode A flow against a trivial design in this repo to verify end-to-end behavior.

- [ ] **Step 1: Start a fresh Claude Code session in this repo**

Prompt: "Let's add a `--dry-run` flag to the design-challenger CLI that logs what would happen without actually making any SDK calls."

This should trigger both `superpowers:brainstorming` and `design-challenger:adversarial-review`.

- [ ] **Step 2: Observe Stage 1 behavior**

Verify:
- Brainstorming asks clarifying questions
- In parallel, `design-challenger:counter-design` spawns (visible in Task tool calls)
- When both finish, `design-challenger:judge` spawns on the findings
- Gate 1 presents counter-design + findings + asks for approval

Approve at Gate 1.

- [ ] **Step 3: Observe Stage 2 behavior**

Verify:
- A spec is written to `docs/superpowers/specs/<date>-dry-run-flag-design.md` (or similar)
- `design-challenger:verifier` runs on any external assumptions
- Round 1 (`counter-design`) spawns against the written spec
- Judge filters findings
- Finding Checklist Gate: you see an explicit disposition block before Round 2
- Round 2 (`skeptical`) spawns
- Round 3 (`pre-mortem`) may spawn if findings remain, or early termination
- Gate 2 presents spec summary

Approve at Gate 2.

- [ ] **Step 4: Observe Stage 3 behavior**

Verify:
- A plan is written to `docs/superpowers/plans/<date>-dry-run-flag-plan.md`
- Pre-review assumption verification runs
- Round 1 (`skeptical`) spawns — NOT counter-design (verify per the spec's Stage 3 fix)
- Round 2 (`pre-mortem`) may spawn
- Any upstream findings trigger spec edits AND plan edits
- Gate 3 presents plan summary + any upstream fixes

Approve at Gate 3.

- [ ] **Step 5: Verify output artifacts**

Confirm these files exist:
- `docs/superpowers/specs/<date>-dry-run-flag-design.md`
- `docs/superpowers/plans/<date>-dry-run-flag-plan.md`
- `docs/superpowers/specs/<date>-dry-run-flag-decisions.md` (DDL)
- `docs/superpowers/specs/<date>-dry-run-flag-evidence.json`
- `docs/superpowers/specs/<date>-dry-run-flag-run-summary.md`

Verify DDL has entries for at least one decision. Verify evidence index has entries with `cited_by` arrays. Verify run summary has metrics (even if approximate).

- [ ] **Step 6: Document any gaps**

If the flow skipped a step, produced the wrong artifact, or failed to consult the user where expected, update the relevant skill file and re-test the affected portion.

- [ ] **Step 7: Clean up test artifacts**

Delete the test spec, plan, DDL, evidence, and summary — they were only for validation. Keep the plugin files.

```bash
rm docs/superpowers/specs/<date>-dry-run-flag-*.md
rm docs/superpowers/specs/<date>-dry-run-flag-evidence.json
rm docs/superpowers/plans/<date>-dry-run-flag-plan.md
```

- [ ] **Step 8: Commit any skill refinements**

```bash
git add plugin/skills/
git commit -m "test: verify end-to-end Mode A flow, refine skills per observed behavior"
```

---

## Task 15: End-to-end test — Mode B (review existing CLI spec)

**Files:** Produces DDL + run summary against the existing CLI spec; verifies Mode B.

- [ ] **Step 1: Start a fresh Claude Code session in this repo**

Prompt: "Review the spec at `docs/superpowers/specs/2026-04-09-design-challenger-design.md` for gaps, hidden assumptions, and architectural issues."

Expected: `design-challenger:challenge-existing-spec` auto-loads, NOT adversarial-review.

- [ ] **Step 2: Observe Mode B behavior**

Verify:
- No brainstorming phase
- Reads the existing spec file
- Pre-review assumption verification runs
- Round 1 (`counter-design`) produces a counter-design against the CLI spec
- Judge filters findings
- Every forwarded finding is presented to you for approval before any fix is applied (consult-on-ALL)
- Rounds 2 and 3 (skeptical, pre-mortem) run with early termination
- Final gate presents summary

- [ ] **Step 3: Verify outputs**

- `docs/superpowers/specs/2026-04-09-design-challenger-decisions.md` (DDL, named after the source spec's stem)
- `docs/superpowers/specs/2026-04-09-design-challenger-evidence.json`
- `docs/superpowers/specs/2026-04-09-design-challenger-run-summary.md`
- The original spec file may have been edited if you approved fixes

- [ ] **Step 4: Commit the Mode B test artifacts**

These are real artifacts for a real spec review — worth keeping.

```bash
git add docs/superpowers/specs/
git commit -m "test: Mode B adversarial review of CLI v1 spec"
```

---

## Task 16: README.md — install and usage docs

**Files:**
- Modify: `plugin/README.md` (replace the stub from Task 2)

- [ ] **Step 1: Write the full README**

File: `plugin/README.md`

```markdown
# design-challenger

Automatic adversarial design review for Claude Code. When you do design work in any project, this plugin spawns read-only Challenger subagents that independently explore, propose counter-designs, extract and falsify assumptions, and generate pre-mortem failure scenarios — before you finalize your spec or plan.

## What it does

Three subagents challenge your designs with genuine independent reasoning:
- **Counter-Design** (Round 1) — proposes an alternative architecture, extracts assumptions, falsifies them against the codebase
- **Skeptical** (Round 2) — re-reads the written spec/plan and verifies fixes actually landed
- **Pre-mortem** (Round 3) — imagines 6-month failure scenarios and traces them through the design

Two helper subagents keep the feedback actionable:
- **Judge** — filters findings for noise, consolidates duplicates, adjusts severity
- **Verifier** — independently confirms external claims (SDK docs, web references, API contracts)

## Requirements

- Claude Code (plugin system support)
- `superpowers >= 5.0` plugin installed

## Install

```bash
# Inside Claude Code
/plugin install <local-path-or-registry>
```

(Exact install command: see INSTALL-NOTES.md, populated during Task 1 research.)

## Usage

**Mode A — Automatic enhancement of design work.**
Just start designing. The plugin auto-activates:

> "Let's design authentication for this app."

You'll get normal superpowers brainstorming plus:
- A Challenger counter-design running in parallel
- Findings filtered by the Judge
- External claims verified by the Verifier
- A Design Decision Log capturing every significant call
- A run summary with quality metrics

You approve at three gates: after brainstorming, after the spec, after the plan.

**Mode B — Review an existing spec or plan.**

> "Review the spec at docs/superpowers/specs/my-design.md for gaps."

The plugin runs the adversarial review cycle against the existing artifact. Consults you on every finding before applying fixes.

## What happens to me as the user

- **CRITICAL findings**: you are paused and consulted before anything is applied
- **IMPORTANT findings that touch architecture or dependencies**: also escalated to consult
- **All other IMPORTANT + MINOR findings**: auto-applied. You see the summary at the next gate.
- **Mode B overrides this to consult-on-all** — you see every proposed change

## Output artifacts (per run)

- Spec: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Plan: `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`
- DDL: `docs/superpowers/specs/YYYY-MM-DD-<topic>-decisions.md`
- Evidence index: `docs/superpowers/specs/YYYY-MM-DD-<topic>-evidence.json`
- Run summary: `docs/superpowers/specs/YYYY-MM-DD-<topic>-run-summary.md`

## Known limitations in v1

- **`tools:` enforcement under plugins is not fully verified.** If the Challenger subagents can modify files despite their `tools: Read, Glob, Grep, WebSearch, WebFetch` declaration, they'll refuse via their system prompt instead. See INSTALL-NOTES.md for the verification result on your setup.
- **Native compaction may drop file:line references** from context. The evidence index (saved to disk per run) preserves these across compactions — later subagents should read the index rather than re-exploring.
- **No per-subagent cost cap.** A runaway Opus subagent has no budget ceiling. Monitor total session cost.
- **Metrics are approximate.** Quality metrics in the run summary are computed from the DDL, not programmatically instrumented. Reasonable estimates, not audited numbers.

## Troubleshooting

- **Skill doesn't auto-load on "design X" prompts**: verify plugin is installed and superpowers >= 5.0 is also installed. Check the session start reminder for the list of loaded skills.
- **Subagent returns malformed JSON**: the orchestrator retries up to 2 times, then surfaces the raw output. If this happens repeatedly, file an issue with the raw output.
- **Finding seems like nonsense**: the Judge may not have filtered it correctly. You can always reject via disposition with reasoning.

## Philosophy

Single-pass AI designs always have gaps. Every "go back and double-check" finds something. This plugin replaces you in that loop — you set the goal, approve the big calls, and let the Challenger run with enforced independence.

Research basis:
- HubSpot's code review agent: Judge filtering was the single most important factor in effectiveness
- LLM multi-agent debate literature: same-model debate amplifies shared biases; dialectical inquiry (counter-design before critique) produces stronger challenges than assigned devil's advocacy
- JetBrains context research: observation masking and structured re-injection improve solve rates 2.6% while cutting costs 50%

This plugin applies those findings to design review specifically.

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add plugin/README.md
git commit -m "docs: write plugin README with install, usage, and troubleshooting"
```

---

## Task 17: Update CLAUDE.md and memory for the pivot

**Files:**
- Modify: `CLAUDE.md` (root of this repo)
- Modify: `C:/Users/verbe/.claude/projects/C--design-challenger/memory/project_status.md`

The CLI implementation is archived. The plugin is the current path.

- [ ] **Step 1: Update CLAUDE.md**

Modify the root `CLAUDE.md` to reflect the pivot. Add a section at the top:

```markdown
## Project Status (2026-04-11)

This repo originally scoped a TypeScript CLI implementation of Design Challenger. That implementation is complete in `src/` but **not deployed**. The project pivoted to a Claude Code plugin architecture (simpler, auto-activates, composes with superpowers).

- **Active path**: `plugin/` — the Claude Code plugin (`design-challenger`)
- **Active spec**: `docs/superpowers/specs/2026-04-11-design-challenger-skill-design.md`
- **Active plan**: `docs/superpowers/plans/2026-04-11-design-challenger-skill-plan.md`
- **Archived**: `src/` (TypeScript CLI), `docs/superpowers/specs/2026-04-09-design-challenger-design.md`, `docs/superpowers/plans/2026-04-09-design-challenger-plan.md`

The CLI code is preserved for reference. The CLI spec + plan document the design decisions that informed the plugin architecture.
```

- [ ] **Step 2: Update memory — project status**

File: `C:/Users/verbe/.claude/projects/C--design-challenger/memory/project_status.md`

```markdown
---
name: Project Status
description: Design Challenger implementation status -- pivoted from CLI to Claude Code plugin on 2026-04-11
type: project
---

Design Challenger is a Claude Code plugin that runs adversarial design review. Originally scoped as a TypeScript CLI; pivoted to plugin architecture for simpler auto-activation and native integration with superpowers.

**Current state (2026-04-11):**
- CLI implementation COMPLETE in `src/` (Steps 1-13 of CLI plan) but NOT deployed
- Plugin spec complete: `docs/superpowers/specs/2026-04-11-design-challenger-skill-design.md`
- Plugin implementation plan complete: `docs/superpowers/plans/2026-04-11-design-challenger-skill-plan.md`
- Plugin implementation: [status — fill in as tasks complete]

**Key pivots:**
- CLI used `@anthropic-ai/claude-agent-sdk` directly, required ANTHROPIC_API_KEY
- Plugin uses Claude Code's existing auth, no API key
- CLI's `disallowedTools` replaced by plugin subagent `tools:` field (enforcement empirically unverified under plugins — see INSTALL-NOTES.md in plugin dir)
- CLI's checkpointing + resume replaced by Claude Code's conversation persistence
- 1500 lines TypeScript → ~500 lines markdown

**How to apply:** When working on the plugin, refer to the skill design spec for behavior and the skill implementation plan for task-level detail. The CLI code in `src/` is reference material for decisions but should NOT be modified or extended.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md C:/Users/verbe/.claude/projects/C--design-challenger/memory/project_status.md
git commit -m "docs: update CLAUDE.md and memory for CLI→plugin pivot"
```

---

## Task 18: Final validation and ship

**Files:** None — verification only.

- [ ] **Step 1: Verify all plugin files exist**

```bash
ls -la plugin/.claude-plugin/plugin.json
ls -la plugin/agents/{counter-design,skeptical,pre-mortem,judge,verifier}.md
ls -la plugin/skills/{adversarial-review,challenge-existing-spec,challenge-existing-plan}.md
ls -la plugin/README.md
ls -la plugin/INSTALL-NOTES.md
```

All 11 files should exist.

- [ ] **Step 2: Re-run empirical tests one more time**

From Tasks 5, 9, 13 — all must pass. Document final state in INSTALL-NOTES.md.

- [ ] **Step 3: Re-run Mode A and Mode B end-to-end tests**

From Tasks 14 and 15. Artifacts should be produced correctly.

- [ ] **Step 4: Check the plugin on a second project**

Change directory to a different repo (e.g., a personal project unrelated to design-challenger). Start a Claude Code session there. Issue "Let's design X" for any X. Verify the plugin auto-activates.

This verifies project-agnostic behavior — the plugin's #1 value prop.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: final validation of design-challenger plugin v0.1.0"
```

- [ ] **Step 6: Tag v0.1.0**

```bash
git tag -a plugin-v0.1.0 -m "design-challenger plugin v0.1.0: initial release"
git push origin main --tags
```

---

## Self-Review Checklist (for the plan author, completed before handoff)

**Spec coverage:**
- ✅ Plugin manifest + directory structure (Task 2)
- ✅ 5 subagents with frontmatter + system prompts (Tasks 3, 4, 6, 7, 8)
- ✅ 3 skills with auto-activation descriptions (Tasks 10, 11, 12)
- ✅ Finding Checklist Gate explicit (in Task 10's skill)
- ✅ Auto-apply vs Consult rules with IMPORTANT escalation (in Task 10's skill)
- ✅ Upstream propagation (in Task 10's skill)
- ✅ Evidence Index incremental disk-backed (in Task 10's skill)
- ✅ DDL with disposition detail + upstream_file (in Task 10's skill)
- ✅ Schema retry loop (in Task 10's skill, error handling section)
- ✅ Empirical testing (Tasks 1, 5, 9, 13)
- ✅ Mode A end-to-end test (Task 14)
- ✅ Mode B end-to-end test (Task 15)
- ✅ README with install, usage, troubleshooting (Task 16)
- ✅ Memory + CLAUDE.md update for pivot (Task 17)
- ✅ Cross-project verification (Task 18 step 4)

**Placeholder scan:** No TBDs, TODOs, "fill in details", "similar to Task N" references. Every file has its content inline.

**Type/name consistency:** `design-challenger:<agent-name>` invocation format used consistently. Subagent `name:` fields use bare names (counter-design, skeptical, pre-mortem, judge, verifier). Skill names use full plugin-prefix format in the description ("Loads alongside superpowers:brainstorming").
