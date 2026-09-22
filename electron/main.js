'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, clipboard, shell, dialog } = require('electron');
const { Controller } = require('../src/controller');
const { createPanelHandler } = require('../src/panel');

let controller;
let tray;
let window;
let quitting = false;

const trayText = {
  en: { running: '● Codex running', stopped: '○ Codex stopped', gateway: 'Gateway', selected: 'Selected models', settings: 'Open Settings', overview: 'Open Overview', traces: 'Open Traces', stop: 'Stop Codex', launch: 'Launch Codex', home: 'Open CODEX_HOME', copy: 'Copy gateway URL', quit: 'Quit', ready: 'ready', starting: 'starting…', launchError: 'Could not launch Codex' },
  zh: { running: '● Codex 正在运行', stopped: '○ Codex 已停止', gateway: '网关', selected: '已选模型', settings: '打开设置', overview: '打开用量总览', traces: '打开调用追踪', stop: '停止 Codex', launch: '启动 Codex', home: '打开 CODEX_HOME', copy: '复制网关地址', quit: '退出 Launcher', ready: '就绪', starting: '启动中…', launchError: '无法启动 Codex' }
};
function tr(key) { return trayText[app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'][key]; }

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
  tray.setToolTip(`Codex Launcher — ${status.appRunning ? tr('running').slice(2) : tr('ready')}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.appRunning ? tr('running') : tr('stopped'), enabled: false },
    { label: `${tr('gateway')}: ${status.port || tr('starting')}`, enabled: false },
    { label: `${tr('selected')}: ${status.selectedModels}`, enabled: false },
    { type: 'separator' },
    { label: tr('settings'), click: () => createWindow('settings') },
    { label: tr('overview'), click: () => createWindow('overview') },
    { label: tr('traces'), click: () => createWindow('traces') },
    { type: 'separator' },
    { label: status.appRunning ? tr('stop') : tr('launch'), click: async () => {
      try { status.appRunning ? controller.stop() : await controller.launch(); updateTray(); }
      catch (error) { dialog.showErrorBox(tr('launchError'), error.message); }
    } },
    { label: tr('home'), click: () => shell.openPath(controller.paths.codexHome) },
    { label: tr('copy'), click: () => clipboard.writeText(controller.gateway.url) },
    { type: 'separator' },
    { label: tr('quit'), click: () => { quitting = true; app.quit(); } }
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
