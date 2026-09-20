# design-brief-editor

A local editor for the "Brief and client planning" page of the group projects
site, and the client/brief pages it links to:
https://group-projects.cst.cam.ac.uk/Brief_and_client_planning/

The pages are Markdown files in the `docs/` folder of
https://github.com/cambridge-group-projects/cambridge-group-projects.github.io
(branch `main`). The site rebuilds and redeploys on every push to that branch.

## Setup (one-time)

1. Install Node.js 18+ if you don't have it — easiest via
   [nvm](https://github.com/nvm-sh/nvm) (`nvm install --lts`), or from
   [nodejs.org](https://nodejs.org). `git` is required too (macOS offers to
   install it the first time you run any `git` command).
2. Clone this repo and run the start script:
   ```
   git clone <this-repo-url>
   cd <this-repo>
   ./start.sh
   ```

The first run also clones the *site's own* repo into a `site/` folder
here — that's a separate, one-time step `start.sh` walks you through
automatically:

- It tries a plain `git clone` of the site repo first, which just works if you
  already have GitHub credentials set up on this machine.
- If that fails (most likely because you're not signed in), and you have
  the [GitHub CLI](https://cli.github.com) (`gh`) installed, it launches
  `gh auth login` for you — sign in via the browser window it opens, and it
  retries automatically. If `gh` isn't installed, it tells you how to get it
  (`brew install gh` on macOS) or gives you the manual `git clone` command
  to run yourself.
- If git doesn't know your name/email yet (a common gap on a fresh machine),
  it asks for both so your commits are attributed to you.

None of this repeats on later runs — once `site/` is cloned, `./start.sh`
goes straight to starting the editor.

## Usage

```
./start.sh
```

This picks an unused port, starts the server, syncs `site/` with GitHub
(proceeding with the local copy if that fails, e.g. you're offline), and
opens the editor in your default browser automatically. The server shuts
itself down as soon as you close that tab (or after a few minutes if the
browser disappears without telling it, e.g. a crash) — no need to remember
to stop it, and no fixed port to collide with your other local dev servers.

Set `PORT=1234` to pin a specific port, or `OPEN_BROWSER=0` to start the
server without opening a tab.

- The `site/` directory is a real git clone of the site repo. It's the source
  of truth on disk; the editor just reads and writes the Markdown files in
  its `docs/` folder.
- The **Browse** tab (default) renders `Brief_and_client_planning.md` itself
  as navigation,
  scrolled to "Group Project Design Briefs for 2027 (work in progress)".
  Click any link in it to open that page for editing on the right. The
  **+ New** button next to each of the three 2027 lists (Accepted design
  briefs / Design Brief Candidates / Potential Clients) prompts for a title
  (and optional short description), appends a correctly formatted entry to
  that list, creates the linked page if it doesn't already exist, and
  publishes both in one commit — the button itself is just a local UI aid,
  nothing about it is written into the page source.
- The **All pages** tab has a flat, filterable list of every page in `docs/`, for
  the rare case you need something not linked from the index.
- Click a page to edit it, with a live Markdown preview on the right.
- **Save & Push** commits the change (`Update <page> via design brief editor`)
  and pushes straight to `main` on GitHub — there's no draft/review step, so make sure
  the content is what you want before saving.
- **Sync** pulls the latest changes from GitHub before you start editing.
- **+ New** creates a new page (`Name.md`) with a title heading.

## If a save fails because of an upstream conflict

The tool always pulls (`--rebase`) before pushing. If that fails — usually
because someone else edited the same page — your edit stays committed
locally in `site/` but is *not* pushed. Resolve it by hand in that folder
(e.g. `cd site && git status`), then push manually.

## Requirements

- Node.js 18+ (no `npm install` needed — this has no external dependencies)
- `git`, with push access to the site repo (contact whoever administers the
  repo's GitHub team if you don't have it)
- Optional but recommended: the [GitHub CLI](https://cli.github.com) (`gh`),
  which the one-time setup above uses to walk you through signing in if
  plain `git clone`/`push` don't already work on your machine
