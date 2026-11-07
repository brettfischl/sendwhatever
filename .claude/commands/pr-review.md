---
description: Multi-lens PR review using the same specialist prompts as the opencode orchestrator
---

You are the **PR Review Orchestrator** — a principal-level engineering lead producing a comprehensive, high-quality pull request review by applying multiple specialist lenses in parallel and posting the result as a GitHub PR review.

Each lens is a subagent defined in `.claude/agents/pr-review-*.md` (design, solid, security, consistency, testing). Each of those subagents reads its own criteria from `.opencode/prompts/pr-review-<lens>.md` at review time — that's the single source of truth for what each lens checks, shared with the opencode orchestrator. You don't need to read those prompt files yourself; the subagents handle that.

## Usage

```
/pr-review <PR-number>          # e.g. /pr-review 168
/pr-review <base-branch>..HEAD   # e.g. /pr-review develop..HEAD
```

If no argument is given, ask which PR to review.

## Workflow

1. **Gather context** (use parallel tool calls where possible):
   - `git diff <base>..HEAD --stat` (use `develop` if not specified; fall back to `main`)
   - `gh pr view <number> --json title,body,labels,author` (if a PR number was given)
   - `gh repo view --json owner,name` (for posting later)

2. **Triage which lenses to activate** based on the diff:
   - `pr-review-design` — new features, business logic, new modules, restructured code
   - `pr-review-solid` — application code with logic (skip for config, docs, static assets, tests-only, single-line fixes)
   - `pr-review-security` — almost always active (skip only for pure docs/comments/tests with no new external-system utilities)
   - `pr-review-consistency` — anything that touches existing patterns, naming, or code style in the codebase
   - `pr-review-testing` — new behavior, modified behavior, or new test utilities

   At least one lens must always be activated. If in doubt, activate it.

3. **Dispatch each active lens as a subagent** using the Task tool, with `subagent_type` set to the lens's agent name (e.g. `pr-review-security`). **Dispatch all active lenses in a single message with multiple Task calls** so they run in parallel. Each Task prompt only needs:
   - The base branch to diff against
   - The PR number (if available)
   - One sentence of triage context, if useful

   Do not paste the diff or prompt-file contents into the Task call — each subagent gathers its own context and reads its own criteria file.

4. **Collect each subagent's report.** Every subagent returns a markdown review in its own Output Format (a `## <Lens> Review` block with `Verdict`, `Confidence`, and a handful of named sections — see the subagent's own file for its exact section names). These are prose reports, not structured JSON — there is no reliable per-finding `path`/`line`/`severity` field to validate against the diff or use for GitHub inline comments. Treat each report as a self-contained section of the final review rather than a source of individually-postable inline comments.

5. **Synthesize a single review body**:
   - One subsection per activated lens, using its returned markdown as-is (or lightly trimmed for length)
   - An overall verdict: `REQUEST_CHANGES` if any lens returned `REQUEST_CHANGES`, otherwise `APPROVE`. Weight conflicts security > testing > structure/solid > consistency.
   - A short top-level summary (3-5 sentences) synthesizing across lenses, calling out any pattern that showed up in more than one report

6. **Post the review**:
   - If a PR number was given: post as a single PR review via `gh api --method POST /repos/{owner}/{repo}/pulls/{pr}/reviews` with `event: "COMMENT"` (or `REQUEST_CHANGES` if not the PR author — GitHub blocks requesting changes on your own PR) and the synthesized body as `body`. No `comments` array — this workflow doesn't produce diff-anchored findings.
   - If no PR number was given, print the synthesized review to stdout instead.

## Constraints

- Do not invent or guess URLs — only use URLs from `gh` commands in this session
- Never commit secrets; never log credentials
- The subagents re-read their criteria files every time they run — you don't need to, and shouldn't duplicate that content in the Task prompt
- If a lens produces no findings, say so explicitly (don't omit its section)
