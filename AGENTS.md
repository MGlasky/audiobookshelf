# Maintainer notes — MGlasky/audiobookshelf fork

Private fork of [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf). `master` tracks upstream and stays fast-forwardable; all feature work happens on branches cut from `origin/master`.

## Tracking upstream (re-pinning `master`)

Upstream commits frequently. Re-pin at the start of each implementation stage.

1. **Pin the upstream SHA.** Record the target commit (full SHA + version if tagged) here and in the project index:

   ```sh
   git fetch upstream && git rev-parse upstream/master
   ```

   Current pin: `18e32410ad4d708c82e0ff170523126221909e28` (v2.36.1, 2026-09-19).
   Re-pinned 2026-09-20 (stage-1 fork hygiene): no-op — fork `master` was already identical to upstream (`0 0` ahead/behind).

2. **Fetch and compare** (first time only: `git remote add upstream https://github.com/advplyr/audiobookshelf.git`):

   ```sh
   git fetch upstream
   git rev-list --left-right --count origin/master...upstream/master
   ```

   `0 N` (nothing on the left) means a fast-forward is possible. Any fork-side commits on the left mean `master` has diverged — stop and report; never resolve by force.

3. **Fast-forward only, or branch.**

   ```sh
   git checkout master
   git merge --ff-only upstream/master
   git push origin master
   ```

   **Never force-push `master`.** If `--ff-only` fails, stop and escalate rather than improvising a merge. If fork-side changes are needed, put them on a branch; `master` only ever moves to upstream tips.

4. **Build verification** (Node 20 — matches upstream CI):

   ```sh
   npm ci && npm run build:server          # server: tsc -> dist-server/
   cd client && npm ci && npm run generate # client build
   npm test                                # what unit-tests.yml runs
   ```

5. **CI check.** Actions were enabled on this fork 2026-09-20 (GitHub ships Actions disabled on forks). On push:
   - **Run Unit Tests** (`unit-tests.yml`) — `npm ci` + `npm test`; runs on every branch push.
   - **Integration Test** (`integration-test.yml`) — client generate, server compile, `pkg` binary, boot + curl check; only on pushes touching `client/**`, `server/**`, `test/**`, `index.js`, `package.json`, `tsconfig.server.json`.
   - **Run Component Tests** (`component-tests.yml`) — client tests on `client/**` changes.
   - **Build and Push Docker Image** (`docker-build.yml`) — **never runs on this fork**: the job is gated on `github.repository == 'advplyr/audiobookshelf'`. Container builds are verified locally instead (`npm run docker-amd64-local`, requires docker).

## Conventions

- Conventional commit prefixes (`feat:`, `fix:`, `docs:`); commits authored by `Obvious <obvious@obvious.ai>` with a `Co-authored-by: Mikey <mkglasky@gmail.com>` trailer.
- Doc-only changes: commit to a branch cut from `origin/master`; a PR is optional unless review is wanted.
