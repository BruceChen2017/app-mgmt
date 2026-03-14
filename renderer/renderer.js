'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let tools = [];
let selectedToolId = null;
let editingToolId  = null;   // null = add mode, string = edit mode
/** @type {Set<string>} toolIds currently running */
const runningTools = new Set();
/** Per-tool output buffers: Map<toolId, Array<{text,cls}>> */
const toolOutputs  = new Map();

// ── DOM refs ─────────────────────────────────────────────────────────────────
const toolListEl      = document.getElementById('tool-list');
const commandInput    = document.getElementById('command-input');
const btnStart        = document.getElementById('btn-start');
const btnStop         = document.getElementById('btn-stop');
const btnClearOutput  = document.getElementById('btn-clear-output');
const outputArea      = document.getElementById('output-area');
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const toolNameInput   = document.getElementById('tool-name');
const toolDescInput   = document.getElementById('tool-description');
const toolCmdInput    = document.getElementById('tool-command');

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  tools = await window.electronAPI.loadTools();
  renderToolList();

  window.electronAPI.onProcessOutput(({ toolId, data, stream }) => {
    const cls = stream === 'stderr' ? 'output-stderr' : 'output-text';
    pushOutput(toolId, data, cls);
    if (toolId === selectedToolId) {
      appendOutputNode(data, cls);
    }
  });

  window.electronAPI.onProcessExit(({ toolId, code }) => {
    runningTools.delete(toolId);
    const msg = `\n[进程已退出，退出码 ${code}]\n`;
    pushOutput(toolId, msg, 'output-system');
    if (toolId === selectedToolId) {
      appendOutputNode(msg, 'output-system');
      updateButtons();
    }
    renderToolList();
  });
}

// ── Tool list rendering ───────────────────────────────────────────────────────
function renderToolList() {
  toolListEl.innerHTML = '';

  if (tools.length === 0) {
    toolListEl.innerHTML =
      '<div class="tool-list-empty">还没有工具<br>' +
      '<span class="hint">点击 + 添加第一个工具</span></div>';
    return;
  }

  tools.forEach((tool) => {
    const isRunning  = runningTools.has(tool.id);
    const isSelected = tool.id === selectedToolId;

    const item = document.createElement('div');
    item.className =
      'tool-item' +
      (isSelected ? ' selected' : '') +
      (isRunning  ? ' running'  : '');
    item.dataset.id = tool.id;

    const dot = isRunning
      ? '<span class="running-dot" title="运行中"></span>'
      : '';

    item.innerHTML = `
      <div class="tool-item-content">
        <div class="tool-item-name">${escHtml(tool.name)}</div>
        <div class="tool-item-desc">${escHtml(tool.description || '')}</div>
      </div>
      ${dot}
      <div class="tool-item-actions">
        <button class="btn-edit-tool"   title="编辑">✎</button>
        <button class="btn-delete-tool" title="删除">✕</button>
      </div>
    `;

    item.querySelector('.tool-item-content').addEventListener('click', () => selectTool(tool.id));
    item.querySelector('.btn-edit-tool').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(tool.id);
    });
    item.querySelector('.btn-delete-tool').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTool(tool.id);
    });

    toolListEl.appendChild(item);
  });
}

// ── Tool selection ────────────────────────────────────────────────────────────
function selectTool(toolId) {
  selectedToolId = toolId;
  const tool = tools.find((t) => t.id === toolId);
  if (!tool) return;

  commandInput.value = tool.command || '';
  renderOutputForTool(toolId);
  updateButtons();
  renderToolList();
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
  if (!command) return;

  // Clear this tool's output buffer and show the command
  toolOutputs.set(selectedToolId, []);
  renderOutputForTool(selectedToolId);
  pushOutput(selectedToolId, `$ ${command}\n`, 'output-system');
  appendOutputNode(`$ ${command}\n`, 'output-system');

  runningTools.add(selectedToolId);
  updateButtons();
  renderToolList();

  const result = await window.electronAPI.startCommand(selectedToolId, command);
  if (!result.success) {
    runningTools.delete(selectedToolId);
    const errMsg = `Error: ${result.error}\n`;
    pushOutput(selectedToolId, errMsg, 'output-stderr');
    appendOutputNode(errMsg, 'output-stderr');
    updateButtons();
    renderToolList();
  }
});

btnStop.addEventListener('click', async () => {
  if (!selectedToolId) return;
  const result = await window.electronAPI.stopCommand(selectedToolId);
  if (result.success) {
    runningTools.delete(selectedToolId);
    const msg = '\n[进程已停止]\n';
    pushOutput(selectedToolId, msg, 'output-system');
    appendOutputNode(msg, 'output-system');
    updateButtons();
    renderToolList();
  }
});

// Also trigger Start on Enter key in command input
commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btnStart.disabled) btnStart.click();
});

// Re-evaluate Start button when command text changes
commandInput.addEventListener('input', updateButtons);

btnClearOutput.addEventListener('click', () => {
  if (selectedToolId) toolOutputs.set(selectedToolId, []);
  outputArea.innerHTML =
    '<span class="output-placeholder">shell output after command executed</span>';
});

// ── Output helpers ────────────────────────────────────────────────────────────
function pushOutput(toolId, text, cls) {
  if (!toolOutputs.has(toolId)) toolOutputs.set(toolId, []);
  toolOutputs.get(toolId).push({ text, cls });
}

function renderOutputForTool(toolId) {
  outputArea.innerHTML = '';
  const buf = toolOutputs.get(toolId);
  if (!buf || buf.length === 0) {
    outputArea.innerHTML =
      '<span class="output-placeholder">shell output after command executed</span>';
    return;
  }
  buf.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    outputArea.appendChild(span);
  });
  outputArea.scrollTop = outputArea.scrollHeight;
}

function appendOutputNode(text, cls) {
  const placeholder = outputArea.querySelector('.output-placeholder');
  if (placeholder) placeholder.remove();
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  outputArea.appendChild(span);
  outputArea.scrollTop = outputArea.scrollHeight;
}

// ── Modal (Add / Edit) ────────────────────────────────────────────────────────
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
    e.preventDefault();
    saveTool();
  }
});

function openAddModal() {
  editingToolId = null;
  modalTitle.textContent = '添加工具';
  toolNameInput.value = '';
  toolDescInput.value = '';
  toolCmdInput.value  = '';
  clearFormErrors();
  openModal();
  toolNameInput.focus();
}

function openEditModal(toolId) {
  const tool = tools.find((t) => t.id === toolId);
  if (!tool) return;
  editingToolId = toolId;
  modalTitle.textContent = '编辑工具';
  toolNameInput.value = tool.name        || '';
  toolDescInput.value = tool.description || '';
  toolCmdInput.value  = tool.command     || '';
  clearFormErrors();
  openModal();
  toolNameInput.focus();
}

function openModal()  { modalOverlay.classList.remove('hidden'); }
function closeModal() { modalOverlay.classList.add('hidden'); }

function clearFormErrors() {
  toolNameInput.classList.remove('error');
  toolCmdInput.classList.remove('error');
}

async function saveTool() {
  const name        = toolNameInput.value.trim();
  const description = toolDescInput.value.trim();
  const command     = toolCmdInput.value.trim();

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
    if (tool) {
      tool.name        = name;
      tool.description = description;
      tool.command     = command;
    }
  } else {
    tools.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      description,
      command,
    });
  }

  await window.electronAPI.saveTools(tools);
  closeModal();
  renderToolList();

  // Refresh command input if the selected tool was edited
  if (editingToolId === selectedToolId) {
    const tool = tools.find((t) => t.id === selectedToolId);
    if (tool) commandInput.value = tool.command || '';
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
  await window.electronAPI.saveTools(tools);

  if (selectedToolId === toolId) {
    selectedToolId = null;
    commandInput.value = '';
    outputArea.innerHTML =
      '<span class="output-placeholder">shell output after command executed</span>';
    updateButtons();
  }
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

// ── Kick off ──────────────────────────────────────────────────────────────────
init();
