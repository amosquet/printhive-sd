# PrintHive agent instructions

Follow the [team development process](doc/DevelopmentProcess.md) for backend
and repository-wide work. For frontend work, also follow
[the frontend instructions](frontend/AGENTS.md).

## Git and pull requests

- Start feature work from the latest `dev` in the shared repository. Use a
  `<username>/<kebab-case-feature>` branch and open feature pull requests
  against `dev`. Release pull requests go from `dev` to `master`.
- Use only fast-forward pushes to the feature branch for the current task.
  Agents must never force-push to any remote branch, including a branch they
  created. This includes `git push --force`, `-f`, `--force-with-lease`,
  `+` refspecs, and equivalent GitHub API operations. Deleting and recreating
  a remote branch to replace published history is also prohibited.
- To update a published feature branch, fetch the latest `dev` and merge
  `origin/dev` into the feature branch. Resolve any conflicts on that branch
  and push the resulting commits normally.
- Change `dev` and `master` through pull requests. A teammate must approve
  the PR and required checks must pass before it is merged.

## Verification

Run the checks relevant to the change and list what passed or skipped in the
PR description. For backend changes, run `uv sync --locked`,
`uv run ruff check .`, and `uv run pytest tests/` from `backend/`. Run
`uv run --project backend pytest tests/` from the repository root for
integration changes.
