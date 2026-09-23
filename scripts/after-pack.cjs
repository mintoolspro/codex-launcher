const { spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const sign = spawnSync('codesign', [
    '--force',
    '--deep',
    '--sign', '-',
    '--timestamp=none',
    appPath
  ], { encoding: 'utf8' });

  if (sign.status !== 0) {
    throw new Error(`Ad-hoc signing failed for ${appPath}:\n${sign.stderr || sign.stdout}`);
  }

  const verify = spawnSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath
  ], { encoding: 'utf8' });

  if (verify.status !== 0) {
    throw new Error(`Code-signature verification failed for ${appPath}:\n${verify.stderr || verify.stdout}`);
  }

  console.log(`  • verified complete ad-hoc signature  app=${appPath}`);
};
