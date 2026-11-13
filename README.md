# printhive

Artus Mosquet
Aryan Dhillon
Aarnav Sabale
Arvind Awasthi

## Tech Stack

Bun and Astro for frontend, UV and Python for backend, and Vercel for hosting

## Repository Structure

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
