const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
// Map of toolId -> child process
const runningProcesses = {};

const toolsFilePath = path.join(app.getPath('userData'), 'tools.json');
const globalsFilePath = path.join(app.getPath('userData'), 'globals.json');

function loadGlobals() {
  if (fs.existsSync(globalsFilePath)) {
    try {
      const raw = fs.readFileSync(globalsFilePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function saveGlobals(globals) {
  fs.writeFileSync(globalsFilePath, JSON.stringify(globals, null, 2), 'utf-8');
}

function loadTools() {
  if (fs.existsSync(toolsFilePath)) {
    try {
      const raw = fs.readFileSync(toolsFilePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function saveTools(tools) {
  fs.writeFileSync(toolsFilePath, JSON.stringify(tools, null, 2), 'utf-8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Tool Manager',
    backgroundColor: '#1e1e1e',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Kill all running processes before quitting
  Object.values(runningProcesses).forEach((child) => {
    try { child.kill(); } catch (_) {}
  });
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('load-tools', () => loadTools());

ipcMain.handle('save-tools', (_event, tools) => {
  saveTools(tools);
  return true;
});

ipcMain.handle('load-globals', () => loadGlobals());

ipcMain.handle('save-globals', (_event, globals) => {
  saveGlobals(globals);
  return true;
});

ipcMain.handle('start-command', (_event, { toolId, command, cwd, envVars }) => {
  if (runningProcesses[toolId]) {
    return { success: false, error: 'Already running' };
  }

  let effectiveCwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
  if (cwd && cwd.trim()) {
    const resolved = path.resolve(cwd.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { success: false, error: `工作目录不存在: ${cwd}` };
    }
    effectiveCwd = resolved;
  }

  const spawnEnv = { ...process.env };
  const globalVars = loadGlobals();
  
  if (Array.isArray(globalVars)) {
    globalVars.forEach(({ key, value }) => {
      if (key && key.trim()) spawnEnv[key.trim()] = value ?? '';
    });
  }

  if (Array.isArray(envVars)) {
    envVars.forEach(({ key, value }) => {
      if (key && key.trim()) spawnEnv[key.trim()] = value ?? '';
    });
  }

  try {
    const child = spawn(command, [], {
      shell: true,
      cwd: effectiveCwd,
      env: spawnEnv,
      windowsHide: true,
    });

    runningProcesses[toolId] = child;

    child.stdout.on('data', (data) => {
      if (!mainWindow) return;
      mainWindow.webContents.send('process-output', {
        toolId,
        data: data.toString(),
        stream: 'stdout',
      });
    });

    child.stderr.on('data', (data) => {
      if (!mainWindow) return;
      mainWindow.webContents.send('process-output', {
        toolId,
        data: data.toString(),
        stream: 'stderr',
      });
    });

    child.on('close', (code) => {
      delete runningProcesses[toolId];
      if (!mainWindow) return;
      mainWindow.webContents.send('process-exit', { toolId, code });
    });

    child.on('error', (err) => {
      delete runningProcesses[toolId];
      if (!mainWindow) return;
      mainWindow.webContents.send('process-output', {
        toolId,
        data: `Error: ${err.message}\n`,
        stream: 'stderr',
      });
      mainWindow.webContents.send('process-exit', { toolId, code: 1 });
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-command', (_event, { toolId }) => {
  const child = runningProcesses[toolId];
  if (!child) {
    return { success: false, error: 'Not running' };
  }

  try {
    if (process.platform === 'win32') {
      // taskkill /t kills the whole process tree
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        shell: false,
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
    }
    delete runningProcesses[toolId];
    return { success: true };
  } catch (err) {
    delete runningProcesses[toolId];
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-tools', async (_event, tools) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出工具配置',
    defaultPath: 'tools.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(tools, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-log', async (_event, { toolName, textContent }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出日志',
    defaultPath: `${toolName || 'tool'}.log`,
    filters: [{ name: 'Log File', extensions: ['log', 'txt'] }],
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(filePath, textContent, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Output area context menu ────────────────────────────────────────────────
ipcMain.on('show-output-context-menu', (event, selectedText) => {
  const menu = Menu.buildFromTemplate([
    {
      label: '\u590d\u5236\u9009\u4e2d\u5185\u5bb9',
      enabled: !!selectedText,
      click: () => clipboard.writeText(selectedText),
    },
    {
      label: '\u590d\u5236\u5168\u90e8\u8f93\u51fa',
      click: () => event.sender.send('output-context-action', 'copy-all'),
    },
    { type: 'separator' },
    {
      label: '\u5168\u9009',
      click: () => event.sender.send('output-context-action', 'select-all'),
    },
    { type: 'separator' },
    {
      label: '\u6e05\u7a7a\u8f93\u51fa',
      click: () => event.sender.send('output-context-action', 'clear'),
    },
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

ipcMain.handle('import-tools', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '导入工具配置',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { success: false, canceled: true };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return { success: false, error: '无效的配置文件格式' };
    return { success: true, tools: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
