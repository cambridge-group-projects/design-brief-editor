const pageListEl = document.getElementById('page-list');
const searchEl = document.getElementById('search');
const editorEl = document.getElementById('editor');
const previewEl = document.getElementById('preview');
const currentPageEl = document.getElementById('current-page');
const saveBtn = document.getElementById('save-btn');
const pullBtn = document.getElementById('pull-btn');
const newPageBtn = document.getElementById('new-page-btn');
const previewToggleBtn = document.getElementById('preview-toggle-btn');
const statusBar = document.getElementById('status-bar');
const indexPreviewEl = document.getElementById('index-preview');
const tabButtons = document.querySelectorAll('.tab-btn');
const clientDialog = document.getElementById('client-dialog');
const clientForm = document.getElementById('client-form');
const clientNameInput = document.getElementById('client-name');
const clientCompanyInput = document.getElementById('client-company');
const clientEmailInput = document.getElementById('client-email');
const clientCancelBtn = document.getElementById('client-cancel-btn');
const dragTooltipEl = document.getElementById('drag-tooltip');

const INDEX_PAGE_PATH = 'Brief_and_client_planning.md';
const SCROLL_TARGET_HEADING = 'Group Project Design Briefs for 2027 (work in progress)';

let pages = [];
let currentPath = null;
let loadedContent = '';
let dirty = false;
let previewVisible = true;

function setStatus(message, kind) {
  statusBar.textContent = message || '';
  statusBar.className = kind || '';
}

function setDirty(value) {
  dirty = value;
  saveBtn.disabled = !dirty || !currentPath;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function sendHeartbeat() {
  fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
}

// prompt()/confirm() block JS execution (including our heartbeat interval)
// for as long as the dialog is open. Ping right before and right after so a
// slow answer never looks like a closed tab to the server's watchdog.
function promptWithHeartbeat(message, defaultValue) {
  sendHeartbeat();
  const result = prompt(message, defaultValue);
  sendHeartbeat();
  return result;
}

function confirmWithHeartbeat(message) {
  sendHeartbeat();
  const result = confirm(message);
  sendHeartbeat();
  return result;
}

function renderPageList() {
  const filter = searchEl.value.trim().toLowerCase();
  pageListEl.innerHTML = '';
  for (const page of pages) {
    if (filter && !page.path.toLowerCase().includes(filter)) continue;
    const li = document.createElement('li');
    li.textContent = page.path.replace(/\.md$/, '');
    li.title = page.path;
    li.dataset.path = page.path;
    if (page.path === currentPath) li.classList.add('active');
    li.addEventListener('click', () => openPage(page.path));
    pageListEl.appendChild(li);
  }
}

async function loadPages() {
  pages = await fetchJson('/api/pages');
  renderPageList();
}

async function confirmDiscardIfDirty() {
  if (!dirty) return true;
  return confirmWithHeartbeat('You have unsaved changes. Discard them?');
}

async function openPage(pagePath) {
  if (!(await confirmDiscardIfDirty())) return;
  setStatus('Loading…');
  const data = await fetchJson(`/api/page?path=${encodeURIComponent(pagePath)}`);
  currentPath = pagePath;
  loadedContent = data.content;
  editorEl.value = data.content;
  currentPageEl.textContent = pagePath;
  renderPreview();
  setDirty(false);
  renderPageList();
  setStatus('');
}

function renderPreview() {
  if (!previewVisible) return;
  const content = editorEl.value || '';
  previewEl.innerHTML = window.marked.parse(content);
  decorateClientLine(previewEl, content);
}

// --- Standardized "Client: Name, Company, Email." line -----------------
//
// Contributors shouldn't hand-type this line (formatting drifts). Instead
// the preview shows a button in its place; the raw markdown still ends up
// as one plain, consistently-formatted line, since that's what has to
// render correctly for everyone else on GitHub.

const CLIENT_LINE_RE = /^Client:\s*(.+?),\s*(.+?),\s*(.+?)\.?\s*$/i;

function findClientLine(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CLIENT_LINE_RE);
    if (m) return { index: i, name: m[1].trim(), company: m[2].trim(), email: m[3].trim() };
  }
  return null;
}

function upsertClientLine(content, fields) {
  const newLine = `Client: ${fields.name}, ${fields.company}, ${fields.email}.`;
  const existing = findClientLine(content);
  if (existing) {
    const lines = content.split('\n');
    lines[existing.index] = newLine;
    return lines.join('\n');
  }
  // No existing line: insert right after the H1 title, or at the very top
  // if there isn't one.
  const headingMatch = content.match(/^(#[^\n]*\n)([\s\S]*)$/);
  if (headingMatch) {
    const rest = headingMatch[2].replace(/^\n+/, '');
    return `${headingMatch[1]}\n${newLine}\n\n${rest}`;
  }
  const rest = content.replace(/^\n+/, '');
  return `${newLine}\n\n${rest}`;
}

function decorateClientLine(container, content) {
  const existing = findClientLine(content);
  if (existing) {
    const target = Array.from(container.querySelectorAll('p')).find((p) =>
      /^client:/i.test(normalizeText(p.textContent))
    );
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'client-chip';
    chip.textContent = `Client: ${existing.name} · ${existing.company} · ${existing.email} (edit)`;
    chip.title = 'Edit client information';
    chip.addEventListener('click', openClientDialog);
    if (target) target.replaceWith(chip);
    else container.prepend(chip);
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'client-chip add';
    btn.textContent = '+ Add client info';
    btn.title = 'Add the standard Client: name, company, email line';
    btn.addEventListener('click', openClientDialog);
    const heading = container.querySelector('h1');
    if (heading) heading.after(btn);
    else container.prepend(btn);
  }
}

function openClientDialog() {
  if (!currentPath) return;
  const existing = findClientLine(editorEl.value);
  clientNameInput.value = existing ? existing.name : '';
  clientCompanyInput.value = existing ? existing.company : '';
  clientEmailInput.value = existing ? existing.email : '';
  sendHeartbeat();
  clientDialog.showModal();
  clientNameInput.focus();
}

clientCancelBtn.addEventListener('click', () => clientDialog.close());

clientForm.addEventListener('submit', (e) => {
  e.preventDefault();
  editorEl.value = upsertClientLine(editorEl.value, {
    name: clientNameInput.value.trim(),
    company: clientCompanyInput.value.trim(),
    email: clientEmailInput.value.trim(),
  });
  setDirty(editorEl.value !== loadedContent);
  renderPreview();
  clientDialog.close();
  sendHeartbeat();
});

editorEl.addEventListener('input', () => {
  setDirty(editorEl.value !== loadedContent);
  renderPreview();
});

previewToggleBtn.addEventListener('click', () => {
  previewVisible = !previewVisible;
  previewEl.classList.toggle('hidden', !previewVisible);
  editorEl.classList.toggle('full', !previewVisible);
  previewToggleBtn.textContent = previewVisible ? 'Preview: split' : 'Preview: off';
  if (previewVisible) renderPreview();
});

saveBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  saveBtn.disabled = true;
  setStatus('Saving and pushing to GitHub…');
  try {
    const result = await fetchJson('/api/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, content: editorEl.value }),
    });
    loadedContent = editorEl.value;
    setDirty(false);
    setStatus(result.message, 'ok');
    await loadPages();
  } catch (err) {
    setStatus(err.message, 'error');
    saveBtn.disabled = false;
  }
});

pullBtn.addEventListener('click', async () => {
  pullBtn.disabled = true;
  setStatus('Pulling latest from GitHub…');
  try {
    await fetchJson('/api/pull', { method: 'POST' });
    await loadPages();
    setStatus('Up to date with GitHub.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    pullBtn.disabled = false;
  }
});

newPageBtn.addEventListener('click', async () => {
  const name = promptWithHeartbeat('New page name (letters, numbers, - and _; .md added automatically):');
  if (!name) return;
  const cleanName = name.trim().replace(/\.md$/, '');
  if (!cleanName) return;
  const pagePath = `${cleanName}.md`;
  try {
    await fetchJson('/api/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pagePath }),
    });
    await loadPages();
    await openPage(pagePath);
    setStatus(`Created ${pagePath}. Edit it and click Save & Push to publish.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

searchEl.addEventListener('input', renderPageList);

// --- Browse tab: the index page rendered as clickable navigation -------------

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function rewriteIndexLinks(container) {
  container.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener';
      return;
    }
    if (href.startsWith('#')) return; // in-page anchor, leave alone
    a.classList.add('wiki-link');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const pagePath = decodeURIComponent(href).replace(/\.md$/, '') + '.md';
      openPage(pagePath);
    });
  });
}

// Finds the (up to) three "### <heading>" + list pairs that follow
// SCROLL_TARGET_HEADING — the staging lists that the "+ New" button and
// drag-and-drop are scoped to.
function findTrackedSections(container) {
  const headings = Array.from(container.querySelectorAll('h2'));
  const targetHeading = headings.find((h) => normalizeText(h.textContent) === SCROLL_TARGET_HEADING);
  if (!targetHeading) return [];

  const sections = [];
  let el = targetHeading.nextElementSibling;
  while (el && el.tagName !== 'H2' && sections.length < 3) {
    if (el.tagName === 'H3') {
      const listEl = el.nextElementSibling;
      if (listEl && (listEl.tagName === 'UL' || listEl.tagName === 'OL')) {
        sections.push({ h3: el, heading: normalizeText(el.textContent), listEl });
      }
    }
    el = el.nextElementSibling;
  }
  return sections;
}

// Attaches a "+ New" button to each of the three staging lists, so new
// entries + their linked page can be added without leaving the index.
// Purely a UI affordance — nothing about the button itself is written
// back to the index page.
function attachListButtons(sections) {
  for (const { h3, heading } of sections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'list-new-btn';
    btn.textContent = '+ New';
    btn.title = `Add a new entry to "${heading}"`;
    btn.addEventListener('click', () => addListEntry(heading));
    h3.appendChild(btn);
  }
}

const DRAG_TOOLTIP_TEXT = 'Drag to move this entry to one of the other two lists.';
const DRAG_TOOLTIP_OFFSET_X = 50; // px to the right of the pointer, clear of the bullet text

function showDragTooltip(e) {
  dragTooltipEl.textContent = DRAG_TOOLTIP_TEXT;
  dragTooltipEl.style.left = `${e.clientX + DRAG_TOOLTIP_OFFSET_X}px`;
  dragTooltipEl.style.top = `${e.clientY}px`;
  dragTooltipEl.style.display = 'block';
}
function moveDragTooltip(e) {
  dragTooltipEl.style.left = `${e.clientX + DRAG_TOOLTIP_OFFSET_X}px`;
  dragTooltipEl.style.top = `${e.clientY}px`;
}
function hideDragTooltip() {
  dragTooltipEl.style.display = 'none';
}

// Makes each item in the three staging lists draggable to any of the other
// two, so candidates can be moved between them without hand-editing the
// markdown. A custom tooltip (not the native title attribute, which can't
// be repositioned or styled) flags the feature and follows the pointer,
// offset to the right so it doesn't sit on top of the text it's about.
function attachDragAndDrop(sections) {
  for (const { heading, listEl } of sections) {
    Array.from(listEl.children).forEach((li, index) => {
      if (li.tagName !== 'LI') return;
      li.draggable = true;
      li.setAttribute('aria-label', DRAG_TOOLTIP_TEXT);
      // Links are draggable by default in browsers, which would otherwise
      // steal the drag gesture (dragging the URL) instead of the li.
      li.querySelectorAll('a').forEach((a) => { a.draggable = false; });
      li.dataset.section = heading;
      li.dataset.index = String(index);

      li.addEventListener('mouseenter', showDragTooltip);
      li.addEventListener('mousemove', moveDragTooltip);
      li.addEventListener('mouseleave', hideDragTooltip);

      li.addEventListener('dragstart', (e) => {
        li.classList.add('dragging');
        hideDragTooltip(); // native drag suppresses further mouse events anyway
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(
          'application/json',
          JSON.stringify({ fromHeading: heading, fromIndex: index })
        );
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
    });

    listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      listEl.classList.add('drag-over');
    });
    listEl.addEventListener('dragleave', () => listEl.classList.remove('drag-over'));
    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      listEl.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('application/json');
      if (!raw) return;
      const { fromHeading, fromIndex } = JSON.parse(raw);
      if (fromHeading === heading) return; // dropped back on its own list
      moveListEntry(fromHeading, heading, fromIndex);
    });
  }
}

async function moveListEntry(fromHeading, toHeading, fromIndex) {
  setStatus(`Moving entry to "${toHeading}"…`);
  try {
    const result = await fetchJson('/api/index/move-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromHeading, toHeading, fromIndex }),
    });
    await loadIndexPreview(false);
    setStatus(result.message, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
    await loadIndexPreview(false); // re-sync item positions after a failed/stale move
  }
}

async function addListEntry(sectionHeading) {
  const title = promptWithHeartbeat(`New entry for "${sectionHeading}" — title:`);
  if (!title || !title.trim()) return;
  const description = promptWithHeartbeat('Optional short description (leave blank for none):') || '';

  setStatus(`Adding "${title.trim()}"…`);
  try {
    const result = await fetchJson('/api/index/add-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionHeading, title, description }),
    });
    await loadIndexPreview(false);
    await loadPages();
    setStatus(result.message, 'ok');
    await openPage(result.path);
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function loadIndexPreview(scrollToTarget) {
  const scrollTop = indexPreviewEl.scrollTop;
  const data = await fetchJson(`/api/page?path=${encodeURIComponent(INDEX_PAGE_PATH)}`);
  indexPreviewEl.innerHTML = window.marked.parse(data.content);
  rewriteIndexLinks(indexPreviewEl);
  const sections = findTrackedSections(indexPreviewEl);
  attachListButtons(sections);
  attachDragAndDrop(sections);

  if (scrollToTarget) {
    const heading = Array.from(indexPreviewEl.querySelectorAll('h2')).find(
      (h) => normalizeText(h.textContent) === SCROLL_TARGET_HEADING
    );
    if (heading) heading.scrollIntoView({ block: 'start' });
  } else {
    indexPreviewEl.scrollTop = scrollTop;
  }
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('tab-browse').classList.toggle('active', btn.dataset.tab === 'browse');
    document.getElementById('tab-all').classList.toggle('active', btn.dataset.tab === 'all');
  });
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Keep the server alive only while this tab is open: ping it periodically,
// and tell it to shut down as soon as the tab actually unloads.
setInterval(sendHeartbeat, 4000);
sendHeartbeat();

// Catch up immediately after the tab was backgrounded (browsers throttle
// timers in hidden tabs) rather than waiting for the next interval tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sendHeartbeat();
});

window.addEventListener('pagehide', () => {
  navigator.sendBeacon('/api/shutdown');
});

loadPages().catch((err) => setStatus(err.message, 'error'));
loadIndexPreview(true).catch((err) => setStatus(err.message, 'error'));

// The server already attempted a sync with GitHub before opening this tab
// (proceeding with the local copy either way) — surface it if that failed.
fetchJson('/api/status')
  .then((status) => {
    if (status.startupSyncError) {
      setStatus(`Showing the local copy — could not sync with GitHub on startup: ${status.startupSyncError}`, 'error');
    }
  })
  .catch(() => {});
