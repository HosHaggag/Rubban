'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rubbanDesktop', Object.freeze({ platform: process.platform, openExternal: target => ipcRenderer.invoke('rubban:open-external', String(target)) }));
