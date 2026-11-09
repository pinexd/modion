'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modion', {
  call: (method, args) => ipcRenderer.invoke('modion', method, args),
  onDownload: (cb) => ipcRenderer.on('download', (_e, data) => cb(data)),
});
