const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadTools: () => ipcRenderer.invoke('load-tools'),
  saveTools: (tools) => ipcRenderer.invoke('save-tools', tools),
  startCommand: (toolId, command, cwd, envVars) =>
    ipcRenderer.invoke('start-command', { toolId, command, cwd, envVars }),
  stopCommand: (toolId) =>
    ipcRenderer.invoke('stop-command', { toolId }),
  onProcessOutput: (callback) =>
    ipcRenderer.on('process-output', (_event, data) => callback(data)),
  onProcessExit: (callback) =>
    ipcRenderer.on('process-exit', (_event, data) => callback(data)),
  exportTools: (tools) => ipcRenderer.invoke('export-tools', tools),
  importTools: ()      => ipcRenderer.invoke('import-tools'),
  showOutputContextMenu: (selectedText) => ipcRenderer.send('show-output-context-menu', selectedText),
  onOutputContextAction: (callback) => ipcRenderer.on('output-context-action', (_e, action) => callback(action)),
});
