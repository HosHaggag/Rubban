'use strict';
require('../server/env-compat.cjs');
// macOS (and Linux desktop) launches do not inherit the login shell's PATH; read it once.
if (process.platform !== 'win32') require('../server/shell-env.cjs').importShellEnvironment();
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createBackend } = require('../server/core.cjs');
const { createExtras } = require('../server/extras.cjs');

app.setName('Rubban');
const root = path.resolve(__dirname, '..');
const portableRoot = app.isPackaged ? path.dirname(process.execPath) : root;
// Windows is portable: data sits next to the app folder. On macOS the app bundle is read-only and
// replaced on update, so data lives in ~/Library/Application Support/Rubban.
const packagedData = () => (process.platform === 'win32' ? path.join(path.dirname(portableRoot), 'Rubban-Data') : path.join(app.getPath('appData'), 'Rubban'));
let dataDir = process.env.RUBBAN_DATA_DIR || (app.isPackaged ? packagedData() : path.join(portableRoot, 'data'));
// First launch under the Rubban name: copy settings from the earlier Marsad or Prism data folder
// (copied, not moved, so an older version still finds its own).
if (!process.env.RUBBAN_DATA_DIR && app.isPackaged && !fs.existsSync(dataDir)) {
  const legacyNames = ['Marsad', 'Prism'];
  const candidates = process.platform === 'win32'
    ? legacyNames.flatMap(name => [path.join(path.dirname(portableRoot), `${name}-Data`), path.join(os.homedir(), name, `${name}-Data`)])
    : legacyNames.map(name => path.join(app.getPath('appData'), name));
  const legacy = candidates.find(candidate => fs.existsSync(candidate));
  if (legacy) {
    try { fs.cpSync(legacy, dataDir, { recursive: true, filter: source => !/[\\/](?:connection\.json|SingletonLock|SingletonCookie|SingletonSocket)$/.test(source) }); }
    catch { /* Start with fresh settings rather than fail. */ }
  }
}
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', path.join(dataDir, 'desktop-profile'));
app.setPath('sessionData', path.join(dataDir, 'desktop-profile'));
app.setAppUserModelId('dev.rubban.desktop');
const smoke = process.argv.includes('--smoke-test');
let backend, connection, window, closing = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(fatal);
}

async function start() {
  // Bundled CLIs (tools/kubectl[.exe], tools/helm[.exe]) win over PATH when they are present.
  const bundledTools = path.join(root, 'tools');
  const bundled = name => { const file = path.join(bundledTools, process.platform === 'win32' ? `${name}.exe` : name); return fs.existsSync(file) ? file : undefined; };
  backend = createBackend({ dataDir, extras: createExtras(), kubectlPath: bundled('kubectl'), helmPath: bundled('helm') });
  connection = await backend.start();
  fs.writeFileSync(path.join(dataDir, 'connection.json'), JSON.stringify({ ...connection, pid: process.pid }, null, 2), { mode: 0o600 });
  // Deny every permission except clipboard writes from Rubban's own page (Copy buttons).
  const rubbanOrigin = new URL(connection.url).origin;
  const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permission === 'clipboard-sanitized-write' && originOf(details?.requestingUrl) === rubbanOrigin));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'clipboard-sanitized-write' && requestingOrigin === rubbanOrigin);
  window = new BrowserWindow({
    title: 'Rubban · رُبّان', width: 1540, height: 970, minWidth: 1050, minHeight: 700,
    icon: path.join(root, 'assets', 'rubban.png'),
    backgroundColor: '#1f2123', show: !smoke, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false },
  });
  const allowed = new URL(connection.url).origin;
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== allowed) event.preventDefault(); });
  async function openExternalLink(target) {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only web links can open externally.');
    await shell.openExternal(parsed.href);
  }
  // New windows never open inside Rubban; web links (for example from an embedded RabbitMQ
  // console) go directly to the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => { openExternalLink(url).catch(() => {}); return { action: 'deny' }; });
  ipcMain.handle('rubban:open-external', async (event, target) => {
    if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== allowed) throw new Error('Invalid sender.');
    await openExternalLink(target);
  });
  const about = () => dialog.showMessageBox(window, { title: 'Rubban', message: `Rubban ${app.getVersion()}`, detail: 'An independent Kubernetes workbench. See FEATURE-PARITY.md for implementation and validation coverage.' });
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Rubban', submenu: [
      ...(mac ? [{ label: 'About Rubban', click: about }, { type: 'separator' }] : []),
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => window.reload() },
      ...(mac ? [{ type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }] : []),
      { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => window.webContents.toggleDevTools() }] },
    ...(mac ? [{ role: 'windowMenu' }] : []),
    { label: 'Help', submenu: [{ label: 'About Rubban', click: about }] },
  ]));
  const rendererErrors = [];
  window.webContents.on('console-message', (_event, details, legacyMessage) => {
    if (typeof details === 'object' && details.level === 'error') rendererErrors.push(details.message);
    else if (details === 3) rendererErrors.push(String(legacyMessage));
  });
  await window.loadURL(connection.url);
  if (smoke) {
    await new Promise(resolve => setTimeout(resolve, 2200));
    const info = await window.webContents.executeJavaScript('({title:document.title,ready:document.readyState,bodyLength:document.body.innerText.length,body:document.body.innerText.slice(0,3000)})');
    const output = process.env.RUBBAN_SMOKE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'desktop-smoke.json'), JSON.stringify({ ...info, rendererErrors }, null, 2));
      const shot = await window.webContents.capturePage();
      fs.writeFileSync(path.join(output, 'desktop-preview.png'), shot.toPNG());
    }
    console.log(JSON.stringify({ smoke: true, title: info.title, ready: info.ready, bodyLength: info.bodyLength, rendererErrors }));
    app.quit();
  }
}
async function fatal(error) {
  console.error(error.stack || error.message);
  try { await backend?.close(); } catch {}
  try { fs.unlinkSync(path.join(dataDir, 'connection.json')); } catch {}
  if (!smoke) dialog.showErrorBox('Rubban could not start', error.message);
  app.exit(1);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closing || !backend) return;
  event.preventDefault(); closing = true;
  Promise.resolve(backend.close()).finally(() => {
    try { fs.unlinkSync(path.join(dataDir, 'connection.json')); } catch {}
    app.quit();
  });
});
