const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
// Map of toolId -> child process
const runningProcesses = {};

const toolsFilePath = path.join(app.getPath('userData'), 'tools.json');

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

ipcMain.handle('start-command', (_event, { toolId, command, cwd }) => {
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

  try {
    const child = spawn(command, [], {
      shell: true,
      cwd: effectiveCwd,
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
