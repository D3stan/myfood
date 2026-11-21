# MyFood — notes for Claude

## Default workflow for fixes and features

Apply this by default; it is a default, not a rule — skip or adapt steps when the user says otherwise or the change is trivial.

1. Explore just enough to write a precise brief, then delegate implementation to **Sonnet subagents** (one per independent piece; don't let two touch the same files).
2. Tell each subagent to read the ponytail skill first (`~/.claude/plugins/marketplaces/ponytail/skills/ponytail/SKILL.md`) for minimal, reuse-first code.
3. **Verify their work yourself**: read the diff, run `npm test` and `npm run build` (with `TZ=Europe/Copenhagen`, as CI does), and fix or send back anything wrong.
4. Work on a branch, open a PR, wait for CI (check on a timer, don't busy-poll), and **merge into `main` if all checks are green**. Merging to main deploys to Dokploy.
