import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isIsolatedDesktopCommand } = require('../src/launch');

test('stop targeting matches only the isolated official Codex process', () => {
  const home = '/Users/test/.codex-launcher/desktop';
  assert.equal(isIsolatedDesktopCommand(`/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=${home}`, home), true);
  assert.equal(isIsolatedDesktopCommand(`/Applications/Codex Launcher.app/Contents/MacOS/Codex Launcher --user-data-dir=${home}`, home), false);
  assert.equal(isIsolatedDesktopCommand('/Applications/Codex.app/Contents/MacOS/Codex', home), false);
});
