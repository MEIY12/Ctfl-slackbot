# Slackbot Output Quality Design (Approach A)

Date: 2026-03-04
Status: Approved
Scope: Prompt and response-contract hardening only (no evaluation framework or orchestration refactor in this phase)

## Goal

Improve output quality for the Slack bot by focusing on:
- complete execution of requested scope,
- concise and consistent response formatting,
- consistent behavior across similar prompts.

The bot should infer required and expected related content from the content model so users can ask for outcomes (for example, "create a landing page") without listing every component explicitly.

## Constraints

- Keep current architecture centered in `src/lib/agent.ts`.
- Do not implement larger refactors (state-machine rewrite) in this phase.
- Do not add operational metrics tracking in this phase.

## Architecture

Keep the current single-orchestrator flow and add explicit quality gates:

1. Intent + Mode Gate
   - Determine whether the user asked a direct question or content/campaign work.
   - Ensure execution mode and planning behavior align with request type.

2. Execution Completeness Gate
   - Verify that the requested scope was fully addressed before final response.

3. Output Contract Gate
   - Ensure final response is concise, structured, and deterministic.

Introduce an internal response contract object that must pass before returning:
- `scopeCompleted: boolean`
- `completionEvidence: string[]`
- `finalFormatValid: boolean`
- `consistencyHintsUsed: boolean`

If any gate fails, run one bounded repair pass before responding.

## Data Flow: Autonomous Scope Expansion

### 1) Model Discovery

Before planning/execution, inspect content types and fields to capture:
- required fields and validations,
- reference relationships,
- constraints needed for valid entries.

### 2) Composition Inference

Infer expected richness from target archetype:
- high-composition target (for example, landing page): multi-component output,
- bounded target (for example, carousel): smaller focused output.

This phase should aim for production-plausible completeness, not minimal schema satisfaction.

### 3) Required + Expected Planner

Build a plan with:
- Required items: schema-required references/fields that must exist,
- Expected items: archetype-level components inferred from model and existing patterns.

### 4) Ordered Execution

Execute in dependency order:
1. leaf/reference entries,
2. composed components,
3. top-level page/container entries.

### 5) Finalization Checks

Before return, verify:
- required references are satisfied,
- expected composition depth is met for the archetype,
- result is not under-built for high-composition asks.

## Error Handling and Guardrails

### Blocker Classification

Differentiate:
- hard blockers (permissions, required-field failures, locale constraints),
- soft blockers (optional enrichments, minor uncertainty).

Continue through soft blockers with best-effort defaults. Stop only on hard blockers.

### Non-Minimality Guardrail

For high-composition asks, reject thin plans and expand before execution until a minimum composition threshold is met.

### Reference Integrity Guardrail

Before create/update and before finalization:
- ensure required references exist or are queued for creation,
- prevent completion when dependencies are unresolved.

### Consistency Guardrail

Use stable patterns for naming/slugging/composition ordering so similar prompts produce similar outcomes.

### Bounded Repair Loop

If post-check fails, perform one repair pass to:
- create missing dependencies,
- relink references,
- reformat final output to contract.

If still failing, return a concise blocker report with explicit missing pieces.

## Testing and Acceptance

### Prompt Contract Tests

Verify final output always follows required structure and brevity expectations.

### Scenario Tests

Cover representative asks such as:
- "Build a landing page" (expects richer composition),
- "Build a carousel" (expects bounded composition),
- "Create related content for X" (expects dependency inference and linking).

### Quality Acceptance Checks

- Completeness: required and expected composition checks pass.
- Consistency: similar prompts produce similar composition behavior.
- Formatting: response is concise and scannable.

### Definition of Done (Approach A)

For high-composition user asks, the bot autonomously creates a production-plausible set of related content without requiring the user to list every component.
