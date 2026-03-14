'use strict';

// ── ANSI Parser ───────────────────────────────────────────────────────────────
// VS Code terminal colour palette (standard 0-7, bright 8-15)
const ANSI_PALETTE = [
  '#4c4c4c','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5',
  '#767676','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff',
];

function ansi256(n) {
  if (n < 16) return ANSI_PALETTE[n];
  if (n < 232) {
    n -= 16;
    const b = n % 6, g = Math.floor(n / 6) % 6, r = Math.floor(n / 36);
    const ch = v => v ? v * 40 + 55 : 0;
    return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
  }
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function freshState() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function applySGR(codes, st) {
  let i = 0;
  while (i < codes.length) {
    const n = codes[i];
    if      (n === 0)              Object.assign(st, freshState());
    else if (n === 1)              st.bold = true;
    else if (n === 2)              st.dim = true;
    else if (n === 3)              st.italic = true;
    else if (n === 4)              st.underline = true;
    else if (n === 22)             { st.bold = false; st.dim = false; }
    else if (n === 23)             st.italic = false;
    else if (n === 24)             st.underline = false;
    else if (n === 39)             st.fg = null;
    else if (n === 49)             st.bg = null;
    else if (n >= 30 && n <= 37)   st.fg = ANSI_PALETTE[n - 30];
    else if (n >= 90 && n <= 97)   st.fg = ANSI_PALETTE[n - 90 + 8];
    else if (n >= 40 && n <= 47)   st.bg = ANSI_PALETTE[n - 40];
    else if (n >= 100 && n <= 107) st.bg = ANSI_PALETTE[n - 100 + 8];
    else if (n === 38) {
      if (codes[i+1] === 5 && i+2 < codes.length)      { st.fg = ansi256(codes[i+2]); i += 2; }
      else if (codes[i+1] === 2 && i+4 < codes.length) { st.fg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; }
    }
    else if (n === 48) {
      if (codes[i+1] === 5 && i+2 < codes.length)      { st.bg = ansi256(codes[i+2]); i += 2; }
      else if (codes[i+1] === 2 && i+4 < codes.length) { st.bg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; }
    }
    i++;
  }
}

function stToStyle(st) {
  let s = '';
  if (st.fg)        s += `color:${st.fg};`;
  if (st.bg)        s += `background:${st.bg};`;
  if (st.bold)      s += 'font-weight:bold;';
  if (st.dim)       s += 'opacity:0.55;';
  if (st.italic)    s += 'font-style:italic;';
  if (st.underline) s += 'text-decoration:underline;';
  return s;
}

function renderSeg(text, st, defaultCls) {
  const style = stToStyle(st);
  const esc   = escHtml(text);
  if (style)      return `<span style="${style}">${esc}</span>`;
  if (defaultCls) return `<span class="${defaultCls}">${esc}</span>`;
  return esc;
}

/**
 * Convert a raw text chunk (may contain ANSI escapes) to HTML.
 * Mutates `st` so ANSI state carries over to the next chunk.
 * The result is wrapped in <span class="output-chunk"> for DOM trimming.
 */
function ansiChunkToHtml(raw, st, defaultCls) {
  raw = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); // strip OSC
  raw = raw.replace(/\x1b\[[\d;]*[ABCDEFGHJKLMSTfsu]/g, '');   // strip non-SGR CSI
  raw = raw.replace(/\x1b[@-Z\\-_]/g, '');                       // strip 2-char escapes
  raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');         // normalise line endings

  const SGR = /\x1b\[([\d;]*)m/g;
  let inner = '', last = 0, m;
  while ((m = SGR.exec(raw)) !== null) {
    const seg = raw.slice(last, m.index);
    if (seg) inner += renderSeg(seg, st, defaultCls);
    applySGR(m[1] ? m[1].split(';').map(Number) : [0], st);
    last = m.index + m[0].length;
  }
  const tail = raw.slice(last);
  if (tail) inner += renderSeg(tail, st, defaultCls);
  return `<span class="output-chunk">${inner}</span>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_BUFFER_CHUNKS = 500;

// ── State ────────────────────────────────────────────────────────────────────
let tools        = [];
let selectedToolId = null;
let editingToolId  = null;
const runningTools   = new Set();
/** Per-tool rendered HTML chunks: Map<toolId, string[]> */
const toolOutputs    = new Map();
/** Per-tool ANSI parser state for live append */
const toolAnsiStates = new Map();
/** Output tab currently shown (can differ from selectedToolId) */
let activeOutputToolId = null;
/** Collapsed group names */
const collapsedGroups  = new Set();
/** Current search query */
let searchQuery = '';
/** Drag-and-drop reorder: id of the item being dragged */
let dragToolId = null;
/** Per-tool command run history: Map<toolId, string[]> */
const cmdHistory    = new Map();
/** Navigation cursor into history (-1 = not browsing) */
const cmdHistoryIdx = new Map();

// ── DOM refs ─────────────────────────────────────────────────────────────────
const toolListEl     = document.getElementById('tool-list');
const outputTabsEl   = document.getElementById('output-tabs');
const commandInput   = document.getElementById('command-input');
const cwdInput       = document.getElementById('cwd-input');
const btnStart       = document.getElementById('btn-start');
const btnStop        = document.getElementById('btn-stop');
const btnClearOutput = document.getElementById('btn-clear-output');
const outputArea     = document.getElementById('output-area');
const modalOverlay   = document.getElementById('modal-overlay');
const modalTitle     = document.getElementById('modal-title');
const toolNameInput  = document.getElementById('tool-name');
const toolDescInput  = document.getElementById('tool-description');
const toolCmdInput   = document.getElementById('tool-command');
const toolCwdInput   = document.getElementById('tool-cwd');
const toolGroupInput = document.getElementById('tool-group');
const leftPanel      = document.querySelector('.left-panel');
const resizeHandle   = document.querySelector('.resize-handle');
const toolSearchInput = document.getElementById('tool-search');
const envTableEl     = document.getElementById('env-table');
const btnAddEnv      = document.getElementById('btn-add-env');
const btnSaveCmd     = document.getElementById('btn-save-cmd');

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  tools = await window.electronAPI.loadTools();
  renderToolList();

  toolSearchInput.addEventListener('input', () => {
    searchQuery = toolSearchInput.value;
    renderToolList();
  });

  window.electronAPI.onProcessOutput(({ toolId, data, stream }) => {
    pushAndDisplay(toolId, data, stream);
  });

  window.electronAPI.onProcessExit(({ toolId, code }) => {
    runningTools.delete(toolId);
    pushAndDisplay(toolId, `\n[进程已退出，退出码 ${code}]\n`, 'system');
    if (toolId === selectedToolId) updateButtons();
    renderOutputTabs();
    renderToolList();
  });
}

// ── Tool list rendering ───────────────────────────────────────────────────────
function renderToolList() {
  toolListEl.innerHTML = '';

  const q = searchQuery.trim().toLowerCase();
  const visibleTools = q
    ? tools.filter(t =>
        (t.name        || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.command     || '').toLowerCase().includes(q))
    : tools;

  if (tools.length === 0) {
    toolListEl.innerHTML =
      '<div class="tool-list-empty">还没有工具<br>' +
      '<span class="hint">点击 + 添加第一个工具</span></div>';
    return;
  }

  if (visibleTools.length === 0) {
    toolListEl.innerHTML = '<div class="tool-list-empty">没有匹配的工具</div>';
    return;
  }

  // Build group map: named groups α-sorted first, ungrouped at bottom
  const NO_GROUP = '';
  const groupMap  = new Map();
  visibleTools.forEach(tool => {
    const g = (tool.group || '').trim();
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(tool);
  });
  const sortedGroups = [...groupMap.keys()]
    .filter(g => g !== NO_GROUP)
    .sort((a, b) => a.localeCompare(b));
  if (groupMap.has(NO_GROUP)) sortedGroups.push(NO_GROUP);

  sortedGroups.forEach(groupName => {
    const groupTools = groupMap.get(groupName);
    if (!groupName) {
      groupTools.forEach(tool => toolListEl.appendChild(createToolItem(tool)));
      return;
    }
    // Expand groups automatically when a search is active
    const isCollapsed = !searchQuery.trim() && collapsedGroups.has(groupName);
    const section = document.createElement('div');
    section.className = 'tool-group';

    const header = document.createElement('div');
    header.className = 'tool-group-header';
    header.innerHTML =
      `<span class="tool-group-arrow">${isCollapsed ? '▶' : '▼'}</span>` +
      `<span class="tool-group-name">${escHtml(groupName)}</span>` +
      `<span class="tool-group-count">${groupTools.length}</span>`;
    header.addEventListener('click', () => {
      if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
      else collapsedGroups.add(groupName);
      renderToolList();
    });
    section.appendChild(header);

    if (!isCollapsed) {
      const body = document.createElement('div');
      body.className = 'tool-group-body';
      groupTools.forEach(tool => body.appendChild(createToolItem(tool)));
      section.appendChild(body);
    }
    toolListEl.appendChild(section);
  });
}

function createToolItem(tool) {
  const isRunning  = runningTools.has(tool.id);
  const isSelected = tool.id === selectedToolId;
  const item = document.createElement('div');
  item.className =
    'tool-item' +
    (isSelected ? ' selected' : '') +
    (isRunning  ? ' running'  : '');
  item.dataset.id = tool.id;

  const dot = isRunning ? '<span class="running-dot" title="运行中"></span>' : '';
  item.setAttribute('draggable', 'true');
  item.innerHTML = `
    <span class="drag-handle" title="拖拽排序">⠿</span>
    <div class="tool-item-content">
      <div class="tool-item-name" title="${escHtml(tool.name)}">${escHtml(tool.name)}</div>
      <div class="tool-item-desc">${escHtml(tool.description || '')}</div>
    </div>
    ${dot}
    <div class="tool-item-actions" draggable="false">
      <button class="btn-edit-tool"   title="编辑">✎</button>
      <button class="btn-clone-tool"  title="克隆">⎘</button>
      <button class="btn-delete-tool" title="删除">✕</button>
    </div>
  `;

  item.querySelector('.tool-item-content').addEventListener('click', () => selectTool(tool.id));
  item.querySelector('.btn-edit-tool').addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(tool.id);
  });
  item.querySelector('.btn-clone-tool').addEventListener('click', async (e) => {
    e.stopPropagation();
    const src = tools.find(t => t.id === tool.id);
    if (!src) return;
    const clone = JSON.parse(JSON.stringify(src));
    clone.id   = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    clone.name = src.name + ' (copy)';
    const idx = tools.findIndex(t => t.id === tool.id);
    tools.splice(idx + 1, 0, clone);
    await window.electronAPI.saveTools(tools);
    renderToolList();
  });
  item.querySelector('.btn-delete-tool').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTool(tool.id);
  });

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  item.addEventListener('dragstart', (e) => {
    // Prevent drag when clicking action buttons
    if (e.target.closest('.tool-item-actions')) { e.preventDefault(); return; }
    dragToolId = tool.id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => item.classList.add('dragging'), 0);
  });
  item.addEventListener('dragend', () => {
    dragToolId = null;
    item.classList.remove('dragging');
    document.querySelectorAll('.tool-item.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', (e) => {
    if (!dragToolId || dragToolId === tool.id) return;
    e.preventDefault();
    document.querySelectorAll('.tool-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', (e) => {
    if (!item.contains(e.relatedTarget)) item.classList.remove('drag-over');
  });
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragToolId || dragToolId === tool.id) return;
    item.classList.remove('drag-over');
    const fromIdx = tools.findIndex(t => t.id === dragToolId);
    const toIdx   = tools.findIndex(t => t.id === tool.id);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = tools.splice(fromIdx, 1);
    tools.splice(toIdx, 0, moved);
    await window.electronAPI.saveTools(tools);
    renderToolList();
  });

  return item;
}

// ── Tool selection ────────────────────────────────────────────────────────────
function selectTool(toolId) {
  selectedToolId     = toolId;
  activeOutputToolId = toolId;
  const tool = tools.find((t) => t.id === toolId);
  if (!tool) return;

  commandInput.value = tool.command || '';
  cwdInput.value     = tool.cwd     || '';
  markCommandClean();
  cmdHistoryIdx.set(toolId, -1);
  renderEnvDisplay(tool);
  renderOutputForTool(toolId);
  renderOutputTabs();
  updateButtons();
  renderToolList();
}

function renderEnvDisplay(tool) {
  const envDisplay = document.getElementById('env-display');
  envDisplay.classList.remove('hidden');
  envDisplay.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'env-label';
  label.textContent = 'Env';
  envDisplay.appendChild(label);

  const pairsContainer = document.createElement('div');
  pairsContainer.className = 'env-pairs';
  const vars = Array.isArray(tool.envVars) ? tool.envVars : [];
  vars.forEach(({ key, value }) => pairsContainer.appendChild(createEnvPair(key, value)));
  envDisplay.appendChild(pairsContainer);

  const addBtn = document.createElement('button');
  addBtn.className = 'env-add-btn';
  addBtn.textContent = '+';
  addBtn.title = '添加环境变量';
  addBtn.addEventListener('click', () => {
    const pair = createEnvPair('', '');
    pairsContainer.appendChild(pair);
    markCommandDirty();
    pair.querySelector('.env-key-input').focus();
  });
  envDisplay.appendChild(addBtn);
}

function createEnvPair(key, value) {
  const pair = document.createElement('div');
  pair.className = 'env-pair';

  const keyInput = document.createElement('input');
  keyInput.className = 'env-key-input';
  keyInput.value = key;
  keyInput.placeholder = 'KEY';
  keyInput.spellcheck = false;
  keyInput.autocomplete = 'off';
  keyInput.addEventListener('input', markCommandDirty);

  const eq = document.createElement('span');
  eq.className = 'env-eq';
  eq.textContent = '=';

  const valInput = document.createElement('input');
  valInput.className = 'env-val-input';
  valInput.value = value;
  valInput.placeholder = 'VALUE';
  valInput.spellcheck = false;
  valInput.autocomplete = 'off';
  valInput.addEventListener('input', markCommandDirty);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'env-remove-btn';
  removeBtn.textContent = '×';
  removeBtn.title = '删除';
  removeBtn.addEventListener('click', () => { pair.remove(); markCommandDirty(); });

  pair.appendChild(keyInput);
  pair.appendChild(eq);
  pair.appendChild(valInput);
  pair.appendChild(removeBtn);
  return pair;
}

// ── Buttons ───────────────────────────────────────────────────────────────────
function updateButtons() {
  if (!selectedToolId) {
    btnStart.disabled = true;
    btnStop.disabled  = true;
    return;
  }
  const running = runningTools.has(selectedToolId);
  btnStart.disabled = running || !commandInput.value.trim();
  btnStop.disabled  = !running;
}

btnStart.addEventListener('click', async () => {
  if (!selectedToolId) return;
  const command = commandInput.value.trim();
  const cwd     = cwdInput.value.trim() || undefined;
  if (!command) return;

  // Auto-save command/cwd if dirty
  if (!btnSaveCmd.classList.contains('hidden')) {
    await saveCommandToTool();
  }

  // Push to per-tool command history
  const hist = cmdHistory.get(selectedToolId) || [];
  if (!hist.length || hist[hist.length - 1] !== command) {
    hist.push(command);
    if (hist.length > 50) hist.shift();
    cmdHistory.set(selectedToolId, hist);
  }
  cmdHistoryIdx.set(selectedToolId, -1);

  // Clear output & reset ANSI state for this tool
  toolOutputs.set(selectedToolId, []);
  toolAnsiStates.set(selectedToolId, freshState());
  activeOutputToolId = selectedToolId;
  outputArea.innerHTML = '';

  runningTools.add(selectedToolId);
  renderOutputTabs();
  updateButtons();
  renderToolList();

  const displayCwd = cwd ? ` (cwd: ${cwd})` : '';
  pushAndDisplay(selectedToolId, `$ ${command}${displayCwd}\n`, 'system');

  const activeTool = tools.find(t => t.id === selectedToolId);
  const envVars = activeTool && Array.isArray(activeTool.envVars) ? activeTool.envVars : [];
  const result = await window.electronAPI.startCommand(selectedToolId, command, cwd, envVars);
  if (!result.success) {
    runningTools.delete(selectedToolId);
    pushAndDisplay(selectedToolId, `Error: ${result.error}\n`, 'stderr');
    updateButtons();
    renderToolList();
  }
});

btnStop.addEventListener('click', async () => {
  if (!selectedToolId) return;
  const result = await window.electronAPI.stopCommand(selectedToolId);
  if (result.success) {
    runningTools.delete(selectedToolId);
    pushAndDisplay(selectedToolId, '\n[进程已停止]\n', 'system');
    renderOutputTabs();
    updateButtons();
    renderToolList();
  }
});

// Command input: Enter to run, Up/Down arrows to browse history
commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { if (!btnStart.disabled) btnStart.click(); return; }
  if (!selectedToolId) return;
  const hist = cmdHistory.get(selectedToolId) || [];
  if (!hist.length) return;
  let idx = cmdHistoryIdx.get(selectedToolId) ?? -1;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const newIdx = idx === -1 ? hist.length - 1 : Math.max(0, idx - 1);
    cmdHistoryIdx.set(selectedToolId, newIdx);
    commandInput.value = hist[newIdx];
    markCommandDirty();
    updateButtons();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx === -1) return;
    const newIdx = idx + 1;
    if (newIdx >= hist.length) {
      cmdHistoryIdx.set(selectedToolId, -1);
      commandInput.value = '';
    } else {
      cmdHistoryIdx.set(selectedToolId, newIdx);
      commandInput.value = hist[newIdx];
    }
    markCommandDirty();
    updateButtons();
  }
});

// Re-evaluate Start button when command text changes
commandInput.addEventListener('input', () => { markCommandDirty(); updateButtons(); });
cwdInput.addEventListener('input', markCommandDirty);

function markCommandDirty() {
  if (!selectedToolId) return;
  const tool = tools.find(t => t.id === selectedToolId);
  if (!tool) return;
  const cmdChanged = commandInput.value !== (tool.command || '') ||
                     cwdInput.value     !== (tool.cwd     || '');
  const savedVars = (tool.envVars || []).filter(v => v.key);
  const envDisplay = document.getElementById('env-display');
  const currentVars = Array.from(envDisplay.querySelectorAll('.env-pair'))
    .map(p => { const ins = p.querySelectorAll('input'); return { key: ins[0].value.trim(), value: ins[1].value.trim() }; })
    .filter(v => v.key);
  const envChanged = currentVars.length !== savedVars.length ||
    currentVars.some((v, i) => v.key !== savedVars[i].key || v.value !== savedVars[i].value);
  if (cmdChanged || envChanged) {
    commandInput.classList.add('dirty');
    cwdInput.classList.add('dirty');
    btnSaveCmd.classList.remove('hidden');
  } else {
    markCommandClean();
  }
}

function markCommandClean() {
  commandInput.classList.remove('dirty');
  cwdInput.classList.remove('dirty');
  btnSaveCmd.classList.add('hidden');
}

btnSaveCmd.addEventListener('click', saveCommandToTool);

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 's' && selectedToolId && !btnSaveCmd.classList.contains('hidden')) {
    e.preventDefault();
    saveCommandToTool();
  }
});

async function saveCommandToTool() {
  if (!selectedToolId) return;
  const tool = tools.find(t => t.id === selectedToolId);
  if (!tool) return;
  tool.command = commandInput.value.trim();
  tool.cwd     = cwdInput.value.trim();
  const envDisplay = document.getElementById('env-display');
  tool.envVars = Array.from(envDisplay.querySelectorAll('.env-pair'))
    .map(pair => {
      const inputs = pair.querySelectorAll('input');
      return { key: inputs[0].value.trim(), value: inputs[1].value.trim() };
    })
    .filter(v => v.key);
  await window.electronAPI.saveTools(tools);
  markCommandClean();
  renderToolList();
}

btnClearOutput.addEventListener('click', () => {
  const clearId = activeOutputToolId || selectedToolId;
  if (clearId) {
    toolOutputs.set(clearId, []);
    toolAnsiStates.set(clearId, freshState());
  }
  outputArea.innerHTML =
    '<span class="output-placeholder">shell output after command executed</span>';
  renderOutputTabs();
});

// ── Output system ─────────────────────────────────────────────────────────────
/**
 * Parse rawText with ANSI codes, store rendered HTML in buffer,
 * and append to DOM if this tool is currently selected.
 * stream: 'stdout' | 'stderr' | 'system'
 */
function pushAndDisplay(toolId, rawText, stream) {
  const defaultCls =
    stream === 'stderr' ? 'output-stderr' :
    stream === 'system' ? 'output-system' : 'output-text';

  if (!toolAnsiStates.has(toolId)) toolAnsiStates.set(toolId, freshState());
  const st   = toolAnsiStates.get(toolId);
  const html = ansiChunkToHtml(rawText, st, defaultCls);

  if (!toolOutputs.has(toolId)) toolOutputs.set(toolId, []);
  const buf = toolOutputs.get(toolId);
  const wasEmpty = buf.length === 0;
  buf.push(html);

  // ── Buffer size limit ──────────────────────────────────────────────────────
  if (buf.length > MAX_BUFFER_CHUNKS) {
    const excess = buf.length - MAX_BUFFER_CHUNKS;
    buf.splice(0, excess);
    if (toolId === activeOutputToolId) {
      const chunks = outputArea.querySelectorAll('.output-chunk');
      for (let i = 0; i < Math.min(excess, chunks.length); i++) chunks[i].remove();
    }
  }

  if (wasEmpty) renderOutputTabs();
  if (toolId === activeOutputToolId) {
    const placeholder = outputArea.querySelector('.output-placeholder');
    if (placeholder) placeholder.remove();
    outputArea.insertAdjacentHTML('beforeend', html);
    outputArea.scrollTop = outputArea.scrollHeight;
  }
}

function renderOutputForTool(toolId) {
  const buf = toolOutputs.get(toolId);
  if (!buf || buf.length === 0) {
    outputArea.innerHTML =
      '<span class="output-placeholder">shell output after command executed</span>';
    return;
  }
  outputArea.innerHTML = buf.join('');
  outputArea.scrollTop = outputArea.scrollHeight;
}

// ── Drag-resize ───────────────────────────────────────────────────────────────
const MIN_PANEL_W = 160;
const MAX_PANEL_W = 520;
let dragStart = null;

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragStart = { x: e.clientX, w: leftPanel.offsetWidth };
  resizeHandle.classList.add('dragging');
  document.body.style.cursor     = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const w = Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, dragStart.w + e.clientX - dragStart.x));
  leftPanel.style.width = w + 'px';
});

document.addEventListener('mouseup', () => {
  if (!dragStart) return;
  dragStart = null;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor     = '';
  document.body.style.userSelect = '';
});
// ── Output tabs ─────────────────────────────────────────────────────────
function renderOutputTabs() {
  outputTabsEl.innerHTML = '';
  const seen   = new Set();
  const tabIds = [];
  const candidates = [
    selectedToolId,
    ...runningTools,
    ...[...toolOutputs.keys()].filter(id => (toolOutputs.get(id) || []).length > 0),
  ];
  candidates.forEach(id => { if (id && !seen.has(id)) { seen.add(id); tabIds.push(id); } });

  tabIds.forEach(toolId => {
    const tool = tools.find(t => t.id === toolId);
    if (!tool) return;
    const isActive  = toolId === activeOutputToolId;
    const isRunning = runningTools.has(toolId);
    const tab = document.createElement('div');
    tab.className = 'output-tab' + (isActive ? ' active' : '');
    tab.title = tool.name;
    if (isRunning) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      tab.appendChild(dot);
    }
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tool.name;
    tab.appendChild(name);
    // close button (only shown when not running)
    if (!isRunning) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toolOutputs.delete(toolId);
        toolAnsiStates.delete(toolId);
        if (activeOutputToolId === toolId) {
          activeOutputToolId = selectedToolId !== toolId ? selectedToolId : null;
          if (activeOutputToolId) {
            renderOutputForTool(activeOutputToolId);
          } else {
            outputArea.innerHTML = '<span class="output-placeholder">shell output after command executed</span>';
          }
        }
        renderOutputTabs();
      });
      tab.appendChild(closeBtn);
    }
    tab.addEventListener('click', () => {
      selectTool(toolId);
    });
    outputTabsEl.appendChild(tab);
  });
}
// ── Modal (Add / Edit) ────────────────────────────────────────────────────────
btnAddEnv.addEventListener('click', () => { const k = addEnvRow(); k.focus(); });

document.getElementById('btn-add-tool').addEventListener('click', openAddModal);
document.getElementById('btn-close-modal').addEventListener('click', closeModal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-save').addEventListener('click', saveTool);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && !modalOverlay.classList.contains('hidden')) {
    // Only trigger save when focus is NOT inside env-table inputs
    if (e.target.closest('#env-table')) return;
    e.preventDefault();
    saveTool();
  }
});

function addEnvRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  const keyIn = document.createElement('input');
  keyIn.className = 'env-key';
  keyIn.placeholder = 'KEY';
  keyIn.value = key;
  keyIn.autocomplete = 'off';
  keyIn.spellcheck = false;
  const valIn = document.createElement('input');
  valIn.className = 'env-val';
  valIn.placeholder = '值';
  valIn.value = value;
  valIn.autocomplete = 'off';
  valIn.spellcheck = false;
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-del-env';
  delBtn.type = 'button';
  delBtn.title = '删除';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', () => row.remove());
  row.appendChild(keyIn);
  row.appendChild(valIn);
  row.appendChild(delBtn);
  envTableEl.appendChild(row);
  return keyIn;
}

function collectEnvVars() {
  return [...envTableEl.querySelectorAll('.env-row')]
    .map(row => ({
      key:   row.querySelector('.env-key').value.trim(),
      value: row.querySelector('.env-val').value,
    }))
    .filter(e => e.key !== '');
}

function openAddModal() {
  editingToolId = null;
  modalTitle.textContent = '添加工具';
  toolNameInput.value  = '';
  toolDescInput.value  = '';
  toolCmdInput.value   = '';
  toolCwdInput.value   = '';
  toolGroupInput.value = '';
  envTableEl.innerHTML = '';
  refreshGroupDatalist();
  clearFormErrors();
  openModal();
  toolNameInput.focus();
}

function openEditModal(toolId) {
  const tool = tools.find((t) => t.id === toolId);
  if (!tool) return;
  editingToolId = toolId;
  modalTitle.textContent = '编辑工具';
  toolNameInput.value  = tool.name        || '';
  toolDescInput.value  = tool.description || '';
  toolCmdInput.value   = tool.command     || '';
  toolCwdInput.value   = tool.cwd         || '';
  toolGroupInput.value = tool.group       || '';
  envTableEl.innerHTML = '';
  (tool.envVars || []).forEach(({ key, value }) => addEnvRow(key, value));
  refreshGroupDatalist();
  clearFormErrors();
  openModal();
  toolNameInput.focus();
}

function openModal()  { modalOverlay.classList.remove('hidden'); }
function closeModal() { modalOverlay.classList.add('hidden'); }

function refreshGroupDatalist() {
  const dl     = document.getElementById('group-datalist');
  const groups = [...new Set(tools.map(t => t.group || '').filter(Boolean))].sort();
  dl.innerHTML = groups.map(g => `<option value="${escHtml(g)}">`).join('');
}

function clearFormErrors() {
  toolNameInput.classList.remove('error');
  toolCmdInput.classList.remove('error');
}

async function saveTool() {
  const name        = toolNameInput.value.trim();
  const description = toolDescInput.value.trim();
  const command     = toolCmdInput.value.trim();
  const cwd         = toolCwdInput.value.trim();
  const group       = toolGroupInput.value.trim();
  const envVars     = collectEnvVars();

  let valid = true;
  clearFormErrors();

  if (!name) {
    toolNameInput.classList.add('error');
    toolNameInput.focus();
    valid = false;
  }
  if (!command) {
    toolCmdInput.classList.add('error');
    if (valid) toolCmdInput.focus();
    valid = false;
  }
  if (!valid) return;

  if (editingToolId) {
    const tool = tools.find((t) => t.id === editingToolId);
    if (tool) Object.assign(tool, { name, description, command, cwd, group, envVars });
  } else {
    tools.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name, description, command, cwd, group, envVars,
    });
  }

  await window.electronAPI.saveTools(tools);
  closeModal();
  renderToolList();

  // Refresh command section if the selected tool was edited
  if (editingToolId === selectedToolId) {
    const tool = tools.find((t) => t.id === selectedToolId);
    if (tool) {
      commandInput.value = tool.command || '';
      cwdInput.value     = tool.cwd     || '';
      renderEnvDisplay(tool);
    }
    updateButtons();
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────────
async function deleteTool(toolId) {
  if (runningTools.has(toolId)) {
    await window.electronAPI.stopCommand(toolId);
    runningTools.delete(toolId);
  }

  tools = tools.filter((t) => t.id !== toolId);
  toolOutputs.delete(toolId);
  toolAnsiStates.delete(toolId);
  await window.electronAPI.saveTools(tools);

  if (selectedToolId === toolId) {
    selectedToolId = null;
    commandInput.value = '';
    cwdInput.value = '';
    const envDisplay = document.getElementById('env-display');
    envDisplay.classList.add('hidden');
    envDisplay.innerHTML = '';
    updateButtons();
  }
  if (activeOutputToolId === toolId) {
    activeOutputToolId = null;
    outputArea.innerHTML =
      '<span class="output-placeholder">shell output after command executed</span>';
  }
  renderOutputTabs();
  renderToolList();
}

// ── Utilities ────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Import / Export ───────────────────────────────────────────────────────────
document.getElementById('btn-export-tools').addEventListener('click', async () => {
  const result = await window.electronAPI.exportTools(tools);
  if (!result.success && !result.canceled) alert(`导出失败: ${result.error}`);
});

document.getElementById('btn-import-tools').addEventListener('click', async () => {
  const result = await window.electronAPI.importTools();
  if (result.canceled) return;
  if (!result.success) { alert(`导入失败: ${result.error}`); return; }
  const incoming = result.tools;
  if (!incoming.length) { alert('配置文件中没有工具'); return; }
  const doReplace = confirm(
    `配置文件包含 ${incoming.length} 个工具。\n确定替换当前全部工具？\n\n（点取消则合并，筛除同名工具）`
  );
  if (doReplace) {
    tools = incoming;
  } else {
    const existingNames = new Set(tools.map(t => t.name));
    incoming.forEach(t => { if (!existingNames.has(t.name)) tools.push(t); });
  }
  await window.electronAPI.saveTools(tools);
  selectedToolId     = null;
  activeOutputToolId = null;
  commandInput.value = '';
  cwdInput.value     = '';
  outputArea.innerHTML = '<span class="output-placeholder">shell output after command executed</span>';
  updateButtons();
  renderToolList();
  renderOutputTabs();
});

// ── Output area right-click context menu ─────────────────────────────────────
outputArea.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.electronAPI.showOutputContextMenu(window.getSelection().toString());
});

window.electronAPI.onOutputContextAction((action) => {
  if (action === 'select-all') {
    const range = document.createRange();
    range.selectNodeContents(outputArea);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  } else if (action === 'copy-all') {
    navigator.clipboard.writeText(outputArea.innerText).catch(() => {});
  } else if (action === 'clear') {
    btnClearOutput.click();
  }
});

// ── Kick off ──────────────────────────────────────────────────────────────────
init();
