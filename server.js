#!/usr/bin/env node
// Local wiki editor: serves a browser UI over the cloned wiki git repo,
// and on save commits + pushes the change back to GitHub.

import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = path.join(__dirname, 'wiki');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR_DIR = path.join(__dirname, 'vendor');
const WIKI_REPO_URL =
  process.env.WIKI_REPO_URL ||
  'https://github.com/cambridge-group-projects/cambridge-group-projects.github.io.wiki.git';
// Default to 0 (OS picks any free port) so this doesn't collide with other
// local dev servers. Set PORT explicitly to override.
const PORT = process.env.PORT ? Number(process.env.PORT) : 0;

// The browser page pings /api/heartbeat while open. If no ping arrives for
// a while (tab closed, browser crashed, laptop slept), the server exits so
// it doesn't linger as an orphan process. This has to stay generous: a
// blocking prompt()/confirm() dialog or a backgrounded tab (browsers
// throttle timers in hidden tabs) can easily stall pings for a minute or
// more without the page actually being closed.
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;
let lastHeartbeat = Date.now();

// Top-level entries in the wiki repo that are not editable pages.
const SKIP_ENTRIES = new Set(['.git', 'assets', 'stylesheets', '.gitignore']);

function git(args, opts = {}) {
  return execFileP('git', args, { cwd: WIKI_DIR, ...opts });
}

// Resolve a user-supplied relative page path safely inside WIKI_DIR.
function resolvePagePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('missing path');
  }
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = path.join(WIKI_DIR, normalized);
  const rel = path.relative(WIKI_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('invalid path');
  }
  const top = rel.split(path.sep)[0];
  if (SKIP_ENTRIES.has(top)) {
    throw new Error('not an editable page');
  }
  return abs;
}

async function listPages() {
  const pages = [];
  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (prefix === '' && SKIP_ENTRIES.has(entry.name)) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith('.md')) {
        const stat = await fs.stat(path.join(dir, entry.name));
        pages.push({ path: relPath, bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
  await walk(WIKI_DIR, '');
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return pages;
}

function commitMessageFor(relPath) {
  return `Update ${relPath} via local wiki editor`;
}

async function pullLatest() {
  await git(['fetch', 'origin']);
  await git(['pull', '--ff-only', 'origin', 'master']);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Result of the sync attempted at server startup, surfaced via /api/status
// so the browser can tell the user if it's showing a possibly-stale local
// copy. Startup never blocks on this beyond a short timeout — it always
// proceeds with whatever is on disk.
let startupSyncError = null;

async function attemptStartupSync() {
  try {
    await withTimeout(pullLatest(), 8000, 'Startup sync with GitHub');
    console.log('Synced with GitHub.');
  } catch (err) {
    startupSyncError = (err.stderr || err.message || String(err)).trim();
    console.warn(`Could not sync with GitHub on startup, using local copy: ${startupSyncError}`);
  }
}

// Stage the given (already-written-to-disk) paths, commit, sync with
// upstream, and push. If sync or push fails, the commit is left local
// rather than force-pushed or discarded.
async function commitAndPush(relPaths, message) {
  const { stdout: statusBefore } = await git(['status', '--porcelain', '--', ...relPaths]);
  if (statusBefore.trim() === '') {
    return { committed: false, pushed: false };
  }

  await git(['add', '--', ...relPaths]);
  await git(['commit', '-m', message]);

  try {
    await git(['pull', '--rebase', 'origin', 'master']);
  } catch (err) {
    // Leave the commit local; do not attempt to push over an unresolved rebase.
    await git(['rebase', '--abort']).catch(() => {});
    throw new Error(
      `Saved and committed locally, but could not sync with GitHub before push ` +
      `(possible conflicting edit upstream). Resolve manually in the wiki/ folder.\n${err.stderr || err.message}`
    );
  }

  try {
    await git(['push', 'origin', 'master']);
  } catch (err) {
    throw new Error(
      `Saved and committed locally, but push to GitHub failed.\n${err.stderr || err.message}`
    );
  }

  return { committed: true, pushed: true };
}

async function saveAndPublish(relPath, content) {
  const abs = resolvePagePath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');

  const result = await commitAndPush([relPath], commitMessageFor(relPath));
  if (!result.committed) {
    return { committed: false, pushed: false, message: 'No changes to save.' };
  }
  return { committed: true, pushed: true, message: `Saved and pushed ${relPath}.` };
}

async function createPage(relPath) {
  const abs = resolvePagePath(relPath);
  if (fss.existsSync(abs)) {
    throw new Error('Page already exists.');
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const title = path.basename(relPath, '.md').replace(/[_-]/g, ' ');
  await fs.writeFile(abs, `# ${title}\n\n`, 'utf8');
}

function normalizeHeadingText(text) {
  return text.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const ORDERED_ITEM_RE = /^\s*(\d+)[.)]\s+/;

// Find the markdown list immediately following a "### <sectionHeading>"
// line in index.md, so a new entry can be appended to it in place.
function findListBlock(lines, sectionHeading) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,6})\s+(.*)$/);
    if (!m || normalizeHeadingText(m[2]) !== sectionHeading) continue;

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    let end = j;
    while (end < lines.length && LIST_ITEM_RE.test(lines[end])) end++;

    const ordered = end > j && ORDERED_ITEM_RE.test(lines[j]);
    return { insertAt: end, ordered, itemsStart: j, itemsEnd: end };
  }
  return null;
}

const INDEX_ABS = path.join(WIKI_DIR, 'index.md');

async function readIndexLines() {
  const original = await fs.readFile(INDEX_ABS, 'utf8');
  const hadTrailingNewline = original.endsWith('\n');
  const lines = original.split('\n');
  if (hadTrailingNewline) lines.pop();
  return { lines, hadTrailingNewline };
}

async function writeIndexLines(lines, hadTrailingNewline) {
  const updated = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  await fs.writeFile(INDEX_ABS, updated, 'utf8');
}

// Renumbers "N. " items sequentially from 1, so removing an item from the
// middle of an ordered list doesn't leave a gap (which would otherwise
// shift where the rendered list visibly starts counting).
function renumberOrderedItems(lines, itemsStart, itemsEnd) {
  let n = 1;
  for (let k = itemsStart; k < itemsEnd; k++) {
    const m = lines[k].match(/^\s*\d+[.)]\s+(.*)$/);
    if (m) lines[k] = `${n++}. ${m[1]}`;
  }
}

function slugifyTitle(title) {
  return title
    .trim()
    .replace(/\s+/g, '_')
    .replace(/\//g, '-')
    .replace(/[<>:"\\|?*\x00-\x1f]/g, '');
}

// Adds "[Title](Slug) [- description]" as a new item to one of the three
// lists on index.md, creating the linked stub page if it doesn't already
// exist, and publishes both in one commit.
async function addIndexEntry(sectionHeading, rawTitle, rawDescription) {
  const title = (rawTitle || '').trim();
  if (!title) throw new Error('Title is required.');
  const description = (rawDescription || '').trim();

  const slug = slugifyTitle(title);
  if (!slug) throw new Error('Could not derive a page name from that title.');
  const pagePath = `${slug}.md`;
  const pageAbs = resolvePagePath(pagePath);

  const { lines, hadTrailingNewline } = await readIndexLines();

  const block = findListBlock(lines, sectionHeading);
  if (!block) {
    throw new Error(`Could not find the "${sectionHeading}" list in index.md.`);
  }

  let nextNum = 1;
  if (block.ordered) {
    for (let k = block.itemsStart; k < block.itemsEnd; k++) {
      const m = lines[k].match(ORDERED_ITEM_RE);
      if (m) nextNum = Math.max(nextNum, Number(m[1]) + 1);
    }
  }
  const prefix = block.ordered ? `${nextNum}. ` : '- ';
  const newLine = `${prefix}[${title}](${slug})${description ? ` - ${description}` : ''}`;
  lines.splice(block.insertAt, 0, newLine);

  await writeIndexLines(lines, hadTrailingNewline);

  let createdPage = false;
  if (!fss.existsSync(pageAbs)) {
    await fs.mkdir(path.dirname(pageAbs), { recursive: true });
    await fs.writeFile(pageAbs, `# ${title}\n\n`, 'utf8');
    createdPage = true;
  }

  const relPaths = createdPage ? ['index.md', pagePath] : ['index.md'];
  const result = await commitAndPush(relPaths, `Add "${title}" to ${sectionHeading}`);

  const verb = createdPage ? 'created' : 'linked to existing';
  return {
    path: pagePath,
    title,
    created: createdPage,
    message: result.committed
      ? `Added "${title}" to "${sectionHeading}" and ${verb} ${pagePath}. Pushed to GitHub.`
      : 'No changes to save.',
  };
}

// Moves one item (identified by its position within fromHeading's list, as
// last seen by the client) over to toHeading's list, re-formatted to match
// the destination list's marker style (numbered vs bulleted). expectedContent
// guards against moving the wrong line if index.md changed since the client
// last rendered it.
async function moveIndexEntry(fromHeading, toHeading, fromIndex, expectedContent) {
  if (!fromHeading || !toHeading) throw new Error('Missing source or destination list.');
  if (fromHeading === toHeading) return { message: 'Already in that list.' };
  if (!Number.isInteger(fromIndex) || fromIndex < 0) throw new Error('Invalid item position.');

  const { lines, hadTrailingNewline } = await readIndexLines();

  const fromBlock = findListBlock(lines, fromHeading);
  if (!fromBlock) throw new Error(`Could not find the "${fromHeading}" list in index.md.`);

  const lineIndex = fromBlock.itemsStart + fromIndex;
  if (lineIndex < fromBlock.itemsStart || lineIndex >= fromBlock.itemsEnd) {
    throw new Error(`That item is no longer where expected in "${fromHeading}". Try refreshing.`);
  }

  const itemMatch = lines[lineIndex].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
  const content = itemMatch ? itemMatch[1] : lines[lineIndex].trim();
  if (typeof expectedContent === 'string' && content.trim() !== expectedContent.trim()) {
    throw new Error(`"${fromHeading}" has changed since this was loaded. Try refreshing.`);
  }

  lines.splice(lineIndex, 1);
  if (fromBlock.ordered) {
    const freshFromBlock = findListBlock(lines, fromHeading);
    if (freshFromBlock) renumberOrderedItems(lines, freshFromBlock.itemsStart, freshFromBlock.itemsEnd);
  }

  const toBlock = findListBlock(lines, toHeading);
  if (!toBlock) throw new Error(`Could not find the "${toHeading}" list in index.md.`);

  let nextNum = 1;
  if (toBlock.ordered) {
    for (let k = toBlock.itemsStart; k < toBlock.itemsEnd; k++) {
      const m = lines[k].match(ORDERED_ITEM_RE);
      if (m) nextNum = Math.max(nextNum, Number(m[1]) + 1);
    }
  }
  const prefix = toBlock.ordered ? `${nextNum}. ` : '- ';
  lines.splice(toBlock.insertAt, 0, `${prefix}${content}`);

  await writeIndexLines(lines, hadTrailingNewline);

  const label = content.length > 60 ? `${content.slice(0, 57)}...` : content;
  const result = await commitAndPush(['index.md'], `Move "${label}" from ${fromHeading} to ${toHeading}`);

  return {
    message: result.committed
      ? `Moved "${label}" to "${toHeading}". Pushed to GitHub.`
      : 'No changes to save.',
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function serveStatic(res, absPath) {
  const ext = path.extname(absPath);
  const data = await fs.readFile(absPath);
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
      return serveStatic(res, path.join(PUBLIC_DIR, url.pathname.slice('/public/'.length)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      return serveStatic(res, path.join(VENDOR_DIR, url.pathname.slice('/vendor/'.length)));
    }

    if (req.method === 'GET' && url.pathname === '/api/pages') {
      return sendJson(res, 200, await listPages());
    }

    if (req.method === 'GET' && url.pathname === '/api/page') {
      const abs = resolvePagePath(url.searchParams.get('path'));
      const content = await fs.readFile(abs, 'utf8');
      return sendJson(res, 200, { path: url.searchParams.get('path'), content });
    }

    if (req.method === 'POST' && url.pathname === '/api/page') {
      const body = await readJsonBody(req);
      const result = await saveAndPublish(body.path, body.content ?? '');
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/new') {
      const body = await readJsonBody(req);
      await createPage(body.path);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/index/add-entry') {
      const body = await readJsonBody(req);
      const result = await addIndexEntry(body.sectionHeading, body.title, body.description);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/index/move-entry') {
      const body = await readJsonBody(req);
      const result = await moveIndexEntry(body.fromHeading, body.toHeading, body.fromIndex, body.content);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/pull') {
      await pullLatest();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      lastHeartbeat = Date.now();
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      res.writeHead(204);
      res.end();
      console.log('Browser tab closed, shutting down.');
      setTimeout(() => process.exit(0), 50);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const { stdout: lastCommit } = await git(['log', '-1', '--format=%h %ci %s']);
      const { stdout: dirty } = await git(['status', '--porcelain']);
      return sendJson(res, 200, {
        branch: branch.trim(),
        lastCommit: lastCommit.trim(),
        dirty: dirty.trim().length > 0,
        startupSyncError,
      });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === '0') return;
  const opener = { darwin: 'open', win32: 'start', linux: 'xdg-open' }[process.platform];
  if (!opener) return;
  execFile(opener, process.platform === 'win32' ? ['', url] : [url], () => {});
}

// Runs a command with its stdio connected straight to this terminal, so
// interactive prompts (git asking for credentials, gh's browser sign-in
// flow) work exactly as if the person had typed the command themselves.
function runInteractive(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function commandExists(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// A fresh machine often has git installed but never configured with an
// identity, which makes the first commit fail with a confusing error.
// Catch that here instead, while we already have the person's attention.
//
// One readline interface is shared across both questions: creating a new
// one per question loses whatever of the input stream the previous
// interface had already buffered, which hangs the second prompt forever
// when input is piped rather than typed live.
async function ensureGitIdentity() {
  const hasName = await execFileP('git', ['config', '--global', 'user.name']).then(() => true).catch(() => false);
  const hasEmail = await execFileP('git', ['config', '--global', 'user.email']).then(() => true).catch(() => false);
  if (hasName && hasEmail) return;

  console.log("\nGit doesn't know who you are yet — this is needed so your edits are attributed to you.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // If stdin isn't a live terminal (e.g. piped input that ends early), the
  // interface can auto-close between questions; treat that as "no answer"
  // rather than crashing the whole first-run setup.
  const ask = async (q) => {
    try {
      return (await new Promise((resolve) => rl.question(q, resolve))).trim();
    } catch {
      return '';
    }
  };
  try {
    if (!hasName) {
      const name = await ask('Your name (for commit history): ');
      if (name) await execFileP('git', ['config', '--global', 'user.name', name]);
    }
    if (!hasEmail) {
      const email = await ask('Your email: ');
      if (email) await execFileP('git', ['config', '--global', 'user.email', email]);
    }
  } finally {
    rl.close();
  }
}

// One-time setup: clone the wiki if this is the first run on this machine.
// Tries the plain clone first (works if credentials are already set up, e.g.
// SSH keys or a cached HTTPS token); if that fails, falls back to walking
// the person through GitHub CLI sign-in, which is the smoothest way to get
// HTTPS git credentials working without them handling tokens by hand.
async function ensureWikiClone() {
  if (fss.existsSync(path.join(WIKI_DIR, '.git'))) return; // already set up

  if (fss.existsSync(WIKI_DIR)) {
    const entries = await fs.readdir(WIKI_DIR);
    if (entries.length > 0) {
      console.error(
        `\n'${WIKI_DIR}' already exists and isn't a git clone of the wiki.\n` +
        'Move or delete it, then run this again to clone fresh.\n'
      );
      process.exit(1);
    }
  }

  console.log('\nFirst-time setup: this needs a local copy of the wiki. This only happens once.\n');
  await ensureGitIdentity();

  console.log(`\nCloning ${WIKI_REPO_URL} ...`);
  try {
    await runInteractive('git', ['clone', WIKI_REPO_URL, WIKI_DIR]);
    console.log('Wiki cloned successfully.\n');
    return;
  } catch {
    console.log("\nThat didn't work — most likely GitHub needs you to sign in first.\n");
  }

  const hasGh = await commandExists('gh');
  if (!hasGh) {
    console.error(
      [
        '',
        'The GitHub CLI (gh) is not installed, and it is the easiest way to sign in.',
        '  macOS:  brew install gh',
        '  other:  https://cli.github.com',
        '',
        'Alternative: create a Personal Access Token at https://github.com/settings/tokens,',
        `then run:  git clone ${WIKI_REPO_URL} "${WIKI_DIR}"`,
        'and run this again once that succeeds.',
        '',
      ].join('\n')
    );
    process.exit(1);
  }

  const alreadyAuthed = await execFileP('gh', ['auth', 'status']).then(() => true).catch(() => false);
  if (!alreadyAuthed) {
    console.log('Found the GitHub CLI — launching sign-in (this opens your browser)...\n');
    try {
      await runInteractive('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
    } catch {
      console.error('\nGitHub sign-in did not complete. Run this again once you can sign in with `gh auth login`.');
      process.exit(1);
    }
  }

  try {
    await runInteractive('gh', ['auth', 'setup-git']);
    console.log('\nRetrying the clone...');
    await runInteractive('git', ['clone', WIKI_REPO_URL, WIKI_DIR]);
    console.log('Wiki cloned successfully.\n');
  } catch {
    console.error('\nStill could not clone the wiki. See the error above, fix it, then run this again.');
    process.exit(1);
  }
}

async function main() {
  await ensureWikiClone();

  server.listen(PORT, () => {
    const port = server.address().port;
    const url = `http://localhost:${port}/`;
    console.log(`Wiki editor running at ${url}`);
    console.log(`Mirroring: ${WIKI_DIR}`);
    lastHeartbeat = Date.now();
    attemptStartupSync().finally(() => openBrowser(url));
  });
}

main();

// If the browser page stops pinging (tab closed, crash, sleep), exit rather
// than lingering as an orphan process.
setInterval(() => {
  if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
    console.log('No heartbeat from browser tab, shutting down.');
    process.exit(0);
  }
}, 10000);
