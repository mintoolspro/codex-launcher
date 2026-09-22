#!/usr/bin/env node

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Controller } = require('../src/controller');
const { createPanelHandler } = require('../src/panel');

const command = process.argv[2] || 'serve';
const controller = new Controller();
controller.setPanelHandler(createPanelHandler(controller));

async function main() {
  if (command === 'status') return console.log(JSON.stringify(controller.status(), null, 2));
  if (command === 'stop') return console.log(JSON.stringify(controller.stop(), null, 2));
  await controller.start();
  if (command === 'launch') await controller.launch();
  else if (command !== 'serve') throw new Error('Usage: codex-launcher [serve|launch|status|stop]');
  console.log(`Codex Launcher panel: http://127.0.0.1:${controller.gateway.port}`);
  const shutdown = async () => { await controller.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
