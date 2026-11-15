# ECE 49595 SD I - GenAI Development

**Project:** PrintHive

**Date:** November 15, 2026

## GenAI Usage Statement

I used GitHub Copilot in VS Code to inspect the PrintHive repository and project documentation, scope the model-intake task, implement it, and run build, diagnostic, test, and browser checks. GenAI authored the Astro intake page and its client-side validation, the smoke tests and frontend test setup, and this submission draft; I reviewed the change summary and authorized the feature commit and push.

## Agent Installation

**Agent and IDE:** GitHub Copilot in VS Code.

**Required evidence:** Add a screenshot showing the installed, signed-in, running agent in the IDE with the PrintHive workspace open.

`[Add screenshot: Copilot installed and running in VS Code]`

## Project Task

### Plan

After reviewing the PrintHive project documentation and repository workflow, the selected task was a first student-facing model-intake page. The agreed scope was a responsive upload interface for STL and OBJ files, a 50 MB file-size limit, and Draft, Standard, and High Strength profiles. The task was kept front-end-only because the repository does not yet provide a connected upload service; the interface must make that limitation clear.

The planned checks were an Astro production build, focused smoke tests for the allowed formats, size guidance, profiles, and disconnected-service state, plus Astro diagnostics. Browser checks would exercise accepted and rejected files and confirm the page remains usable on a narrow viewport.

### Implementation

The Astro starter page was replaced with a PrintHive-branded, responsive intake interface with file-picker and drag-and-drop support. Client-side checks reject unsupported extensions and files larger than 50 MB; the page presents the three agreed profiles and clearly says files are not uploaded or stored. The continuation button remains disabled because there is no backend upload/review workflow yet.

The frontend package gained a `test` script, three built-page smoke tests, and the development dependencies needed for `astro check`; the Bun lockfile was updated accordingly.

### Evidence and Validation

- **Feature commit:** [59672601007aad72436fa33f51bdc55d55e16d8e](https://github.com/amosquet/printhive-sd/commit/59672601007aad72436fa33f51bdc55d55e16d8e)
- **Branch:** `aryandhillon/print-upload-intake`, pushed to the shared PrintHive repository.
- `bun install --frozen-lockfile`: passed.
- `bun run test`: Astro production build passed; 3 smoke tests passed, 0 failed.
- `bun astro check`: 0 errors, 0 warnings, 0 hints.
- `git diff --check`: passed.
- Browser verification: a valid STL and drag-dropped OBJ were accepted; an unsupported G-code file and a file 1 byte above 50 MB were rejected; a 50 MB file was accepted. At a 390 px viewport, the page had no horizontal overflow.

**Task screenshot evidence:** A browser preview was captured during this session, but no screenshot file was added to this repository or uploaded to Brightspace. Attach a saved screenshot of the completed PrintHive page. The local preview used for verification was `http://127.0.0.1:4321/`.

**Validation limits:** File handling is only client-side prototype behavior; it does not prove a server upload, persistence, model parsing, or print queue integration. The feature branch was pushed, but a pull request, teammate review, and merge were not part of this session. The team workflow requires a pull request to `dev` and peer approval before merging.

## Reflection

### 1. How is working with an agent different from asking a chat assistant for code online?

In this task, Copilot could inspect the actual PrintHive documentation and source, make changes in the feature branch, run the project checks, and verify interactions in the browser. The agent could then use those results to correct the implementation rather than leave me to transfer and integrate a standalone code answer. **Personal observation to add:** [Describe how this compared with your own experience asking for code online.]

### 2. Did the agent make mistakes or did you have to correct the plan? How did you notice?

There were mistakes and corrections. When resuming the task, an earlier progress note said implementation was complete, but checking the actual branch showed the untouched Astro starter and no pending changes; the agent then implemented the agreed task. The first smoke-test assertion also assumed Astro would render option tags without extra attributes, which the failing test disproved. A browser check later exposed a stale filename after an unsupported file was selected; the agent fixed the display reset and rechecked the valid, invalid, and size-boundary cases. The task scope itself did not change.

### 3. What permissions did you grant the agent? What actions would be risky to approve automatically, and why?

In this session, I authorized repository edits and local build, test, diagnostic, and browser checks, then explicitly approved committing and pushing the feature branch. Actions such as deleting data, running destructive shell commands, handling secrets, deploying to production, or pushing directly to protected integration or release branches would be risky to approve automatically because they can cause broad or difficult-to-reverse effects. **Personal detail to add if required:** [State the approval mode configured in your VS Code agent settings; it was not verified in this session.]

### 4. How did project documentation in the agent's context help keep the task relevant and scoped?

The project plan and PrintHive documentation grounded the work in the student-facing 3D-print portal instead of treating the repository as a generic Astro site. The development-process document clarified that work belongs on a feature branch and that integration requires a pull request and peer review. The documentation also helped keep this contribution to an intake slice and made the missing backend service an explicit limitation rather than an invented capability.

## Before Submitting

- Add the required screenshot of GitHub Copilot installed and running in VS Code.
- Attach a saved screenshot of the completed PrintHive intake page as task evidence.
- Replace the bracketed personal-observation prompts in Reflections 1 and 3 with your own experience and configured approval mode.
- Check that the first-person reflection wording accurately represents your experience before uploading to Brightspace.