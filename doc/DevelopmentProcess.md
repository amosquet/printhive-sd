# PrintHive Team Development Process

This document defines the repository architecture, branching workflow, and code review policies for the PrintHive project. All team members follow this guide throughout development.

---

## 1. Repository Architecture

PrintHive uses a monorepo layout that separates the Python backend (`backend/`), the Astro web frontend (`frontend/`), project documentation (`doc/`), and cross-system integration tests (`tests/`). This structure keeps frontend and backend dependencies isolated while allowing atomic changes across the full stack in a single repository.

### Directory Tree

```text
printhive-sd/
├── README.md                        # Root project overview and documentation
├── Software Development Plan.pdf    # Project scope, requirements, and deliverables
├── backend/                         # Python backend service (managed with uv)
│   ├── .python-version              # Pinned Python version (3.13)
│   ├── README.md                    # Backend documentation
│   ├── pyproject.toml               # Python package configuration and dependencies
│   ├── src/
│   │   └── backend/
│   │       └── __init__.py          # Backend package entry point
│   └── tests/                       # Backend-specific tests (Python unit & module tests)
├── doc/                             # Project and engineering process documentation
│   └── DevelopmentProcess.md        # Team development process, branching, and PR policy
├── frontend/                        # Astro web application frontend (managed with Bun)
│   ├── .gitignore                   # Frontend Git ignore rules
│   ├── .vscode/                     # VS Code workspace recommendations and launch config
│   │   ├── extensions.json
│   │   └── launch.json
│   ├── AGENTS.md                    # Development server and agent instructions
│   ├── README.md                    # Frontend documentation and commands
│   ├── astro.config.mjs             # Astro configuration
│   ├── bun.lock                     # Bun dependency lockfile
│   ├── package.json                 # Frontend scripts and dependencies
│   ├── public/                      # Static public assets
│   │   ├── favicon.ico
│   │   └── favicon.svg
│   ├── src/                         # Frontend source code
│   │   └── pages/                   # Astro file-based route pages
│   │       └── index.astro          # Main landing page
│   ├── tests/                       # Frontend-specific tests (UI & component tests)
│   └── tsconfig.json                # TypeScript configuration
└── tests/                           # Cross-stack integration tests (frontend + backend)
```

### Architectural Breakdown

- **`backend/` (Python Backend & Edge Relay Services):**
  Built with Python 3.13+ and managed with `uv` (`pyproject.toml`). Uses the standard `src/` layout (`backend/src/backend/`) so the package is installed in editable mode during testing rather than imported implicitly from the working directory. Core modules for REST/WebSocket API endpoints, staff-shift-aware scheduling, 2D print batching, headless Orca Slicer CLI workers, and the local network Edge Relay daemon reside inside `backend/src/backend/`.
- **`frontend/` (Responsive Web Portal):**
  Built with Astro and managed with Bun (`package.json`, `bun.lock`). Static, unprocessed assets (icons, fonts, sample models) reside in `frontend/public/`. Application source code lives in `frontend/src/`, with file-based routing under `frontend/src/pages/` and reusable UI components (3D WebGL model preview, queue status dashboard, live telemetry video feed, and staff controls) organized under `frontend/src/components/`.
- **`doc/` (Engineering & Process Documentation):**
  Houses living team documentation, architectural specifications, deployment guides, and development workflow standards (such as `doc/DevelopmentProcess.md`).
- **Test Directory Separation (`backend/tests/`, `frontend/tests/`, and root `tests/`):**
  The repository maintains three distinct `tests/` directories scoped by layer:
  1. **`backend/tests/` (Backend Tests):** Dedicated to isolated backend unit and module tests (e.g., Python scheduling heuristics, 2D bin-packing logic, G-code duration parsing, and API route handlers).
  2. **`frontend/tests/` (Frontend Tests):** Dedicated to isolated frontend tests (e.g., Astro pages, UI components, client-side model validation, and WebGL viewport rendering).
  3. **`tests/` (Root Integration Tests):** Dedicated to cross-stack integration and end-to-end tests that verify the frontend, backend API, and edge relay working together as a complete system.

### Standards & Structural References

Our repository organization follows established ecosystem standards and official documentation:

- **Mozilla MDN Web Docs — Website File & Directory Structure:**
  - [MDN: Dealing with files (Website structure best practices)](https://developer.mozilla.org/en-US/docs/Learn_web_development/Getting_started/Environment_setup/Dealing_with_files) — Guides how our web application separates root configuration, static assets (`public/`), styles, scripts, and page routes using predictable, lowercase, hyphen-friendly file paths.
  - [MDN Web Docs: Web Technology References](https://developer.mozilla.org/en-US/docs/Web) — Reference standards for semantic HTML, CSS, JavaScript/TypeScript, WebGL, and WCAG web accessibility compliance.
- **Astro Project Structure:**
  - [Astro Official Documentation: Project Structure](https://docs.astro.build/en/basics/project-structure/) — Defines the required conventions for `src/pages/`, `public/`, `astro.config.mjs`, and `tsconfig.json`.
- **Python Packaging Authority (PyPA) & `uv` Layout:**
  - [PyPA Packaging Guide: `src` layout vs. flat layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/) — Explains why isolating importable Python code inside `backend/src/backend/` prevents accidental local imports and ensures clean packaging.
  - [Astral `uv` Documentation: Project Structure & Layout](https://docs.astral.sh/uv/concepts/projects/layout/) — Standardizes `pyproject.toml`, `.python-version`, and lockfile-driven reproducible Python environments.
- **Test Suite Organization (`pytest`):**
  - [pytest Documentation: Good Integration Practices & Test Layout](https://docs.pytest.org/en/stable/explanation/goodpractices.html#choosing-a-test-layout) — Recommends placing `tests/` alongside `src/` so test runners execute against the installed package.

---

## 2. Branching & Workflow Model

PrintHive uses a two-tier integration branching model (`master` + `dev`) combined with developer feature branches inside the shared team repository.

### Shared Repository Policy (No Personal Forks)

- **Do not fork the team repository** to create personal development repositories.
- Every team member must create, push, and maintain their feature and development branches directly within the main `printhive-sd` team repository so work is visible to all teammates and runs through shared CI checks.

### Main & Supporting Branches

1. **`master` (Production / Release Branch):**
   - Contains stable, fully verified, release-ready code corresponding to project milestones and working deliverables.
   - Direct commits or pushes to `master` are strictly prohibited.
   - Updated only via pull requests from `dev` after thorough integration testing and team verification.
2. **`dev` (Integration Branch):**
   - Serves as the primary day-to-day integration branch where completed features, fixes, and enhancements are combined and tested together.
   - Direct commits to `dev` are prohibited; all work enters `dev` through reviewed pull requests from feature branches.
   - Branches for new work are always branched off the latest `dev`.
3. **Feature / Fix Branches (Short-Lived Working Branches):**
   - Created from `dev` by individual developers or pairs working on features, bug fixes, documentation updates, or refactors.
   - Merged back into `dev` via Pull Request once implemented and tested.

### Branch Naming Convention

All working branches must follow the format:

```text
<username>/<feature-or-fix-being-implemented>
```

- Use your GitHub/team identifier in lowercase, followed by a slash (`/`) and a descriptive `kebab-case` summary of the work.
- **Examples:**
  - `artus/stl-upload-validation`
  - `aryan/shift-aware-scheduler`
  - `aarnav/webgl-model-preview`
  - `arvind/edge-relay-websocket-fix`

### Standard Developer Workflow

1. Sync local `dev` with the remote repository:
   ```bash
   git checkout dev
   git pull origin dev
   ```
2. Create a new branch off `dev` following the naming convention:
   ```bash
   git checkout -b <username>/<feature-or-fix-being-implemented>
   ```
3. Implement changes, commit regularly with clear commit messages, and run local tests.
4. Push the branch to the shared team repository (`git push -u origin <branch-name>`) and open a Pull Request targeting `dev`.
5. Once `dev` is verified and stable for a milestone or release checkpoint, open a Pull Request from `dev` into `master`.

---

## 3. Code Development & Review Policy

### Pull Request Scope & Frequency

- **Flexible PR Scope:** Pull requests do **not** have to be single-purpose or narrowly scoped. Developers may bundle related features, multi-file full-stack changes, refactors, or a complete milestone task into a single PR whenever that matches how the work was built, provided the PR description clearly explains what is included.
- **PR & Integration Frequency:**
  - Developers push to their working branches regularly and open a PR into `dev` as soon as a feature, task, or batch of changes is working and locally tested (typically 1–2 PRs per developer per week during active sprints).
  - `dev` is merged into `master` via a release PR at the end of each sprint, milestone, or whenever a verified set of features is ready for demonstration/deployment.
- **Review Turnaround:** Teammates aim to review open pull requests within **24–48 hours** so work is not blocked.

### Approval & Merge Process

- **Pull Requests Required:** All changes to `dev` and `master` must go through GitHub Pull Requests. Direct pushes to `dev` or `master` are not allowed.
- **PR Description Requirements:** Every pull request must include:
  1. A short summary of the changes included in the PR.
  2. A brief explanation of how the changes were tested locally.
- **Local Testing Prerequisite:** Developers must run and verify their changes locally before requesting a review from teammates.
- **Peer Review & Approval:**
  - **Merging into `dev` (`feature -> dev`):** Requires review and explicit approval from **at least one (1) other team member**, plus passing CI checks. Reviewers check code clarity, adherence to project requirements, and test coverage.
  - **Merging into `master` (`dev -> master`):** Requires verification that the integrated `dev` branch builds cleanly, passes all automated checks, and has been reviewed and approved by another team member before merging.

### Automated CI Checks

Every Pull Request targeting `dev` or `master` triggers automated Continuous Integration (CI) checks that must pass before merging:

1. **Backend Checks (`backend/` & `backend/tests/`):**
   - Reproducible dependency installation check via `uv sync --locked`.
   - Automated backend test suite execution via `uv run pytest` in `backend/tests/`.
2. **Frontend Checks (`frontend/` & `frontend/tests/`):**
   - Dependency installation via `bun install --frozen-lockfile`.
   - Astro/TypeScript diagnostics and production build verification via `bun astro check` and `bun run build`.
   - Automated frontend component/UI tests in `frontend/tests/` and accessibility checks.
3. **Integration Checks (`tests/`):**
   - Execution of full-stack integration tests in the root `tests/` directory.

Only changes that have been tested locally, pass all automated CI checks, and receive required peer approval may be merged into `dev` or `master`.
