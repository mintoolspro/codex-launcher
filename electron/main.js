'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, clipboard, shell, dialog } = require('electron');
const { Controller } = require('../src/controller');
const { createPanelHandler } = require('../src/panel');

let controller;
let tray;
let window;
let quitting = false;

function logFatal(kind, error) {
  console.error(`[${kind}]`, error);
  if (app.isReady()) dialog.showErrorBox('Codex Launcher', `${kind}: ${error?.message || error}`);
}
process.on('uncaughtException', (error) => logFatal('Unexpected error', error));
process.on('unhandledRejection', (error) => logFatal('Unhandled rejection', error));

function createWindow(route = '') {
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      width: 1080, height: 760, minWidth: 820, minHeight: 620,
      title: 'Codex Launcher',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  }
  const url = `http://127.0.0.1:${controller.gateway.port}/${route ? `#${route}` : ''}`;
  window.loadURL(url);
  window.once('ready-to-show', () => window.show());
  window.show(); window.focus();
  return window;
}

function updateTray() {
  if (!tray) return;
  const status = controller.status();
  tray.setToolTip(`Codex Launcher — ${status.appRunning ? 'Codex running' : 'ready'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.appRunning ? '● Codex running' : '○ Codex stopped', enabled: false },
    { label: `Gateway: ${status.port || 'starting…'}`, enabled: false },
    { label: `Selected models: ${status.selectedModels}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Settings', click: () => createWindow('settings') },
    { label: 'Open Overview', click: () => createWindow('overview') },
    { type: 'separator' },
    { label: status.appRunning ? 'Stop Codex' : 'Launch Codex', click: async () => {
      try { status.appRunning ? controller.stop() : await controller.launch(); updateTray(); }
      catch (error) { dialog.showErrorBox('Could not launch Codex', error.message); }
    } },
    { label: 'Open CODEX_HOME', click: () => shell.openPath(controller.paths.codexHome) },
    { label: 'Copy gateway URL', click: () => clipboard.writeText(controller.gateway.url) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  controller = new Controller();
  controller.setPanelHandler(createPanelHandler(controller));
  await controller.start();
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(image);
  tray.on('click', () => createWindow('settings'));
  updateTray();
  setInterval(updateTray, 3000).unref();
  createWindow('settings');
}).catch((error) => logFatal('Startup failed', error));

app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; controller?.stop(); });
app.on('will-quit', () => { controller?.gateway?.close(); });
