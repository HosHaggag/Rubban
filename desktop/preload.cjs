'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rubbanDesktop', Object.freeze({ platform: process.platform, openExternal: target => ipcRenderer.invoke('rubban:open-external', String(target)), setTheme: preference => ipcRenderer.invoke('rubban:set-theme', String(preference)),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('rubban:update-get'),
    check: () => ipcRenderer.invoke('rubban:update-check'),
    download: () => ipcRenderer.invoke('rubban:update-download'),
    install: () => ipcRenderer.invoke('rubban:update-install'),
    onState: listener => { const handler = (_event, state) => listener(state); ipcRenderer.on('rubban:update-state', handler); return () => ipcRenderer.removeListener('rubban:update-state', handler); },
  }) }));
