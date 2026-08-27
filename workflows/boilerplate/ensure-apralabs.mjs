import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function findApralabsSource() {
  const fleetLocal = path.join(os.homedir(), '.apra-fleet', 'node_modules', '@apralabs');
  if (
    fs.existsSync(fleetLocal) &&
    fs.existsSync(path.join(fleetLocal, 'apra-fleet-workflow'))
  ) {
    return fleetLocal;
  }

  // npm global prefix — where `npm install -g @apralabs/apra-fleet` lands.
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const npmGlobal = path.join(prefix, 'node_modules', '@apralabs');
    if (
      fs.existsSync(npmGlobal) &&
      fs.existsSync(path.join(npmGlobal, 'apra-fleet-workflow'))
    ) {
      return npmGlobal;
    }
  } catch {
    // npm not available or errored — skip this source.
  }

  return null;
}

export function ensureApralabs() {
  const destDir = path.join(repoRoot, 'node_modules');
  const dest = path.join(destDir, '@apralabs');

  if (fs.existsSync(path.join(dest, 'apra-fleet-workflow'))) {
    return;
  }

  const src = findApralabsSource();
  if (!src) {
    throw new Error(
      'Cannot resolve @apralabs/apra-fleet-workflow. Install Fleet (see README) or run: docker compose run --rm fleet node --test tests/boilerplate.test.mjs',
    );
  }

  fs.mkdirSync(destDir, { recursive: true });

  let destIsCorrect = false;
  try {
    destIsCorrect = fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(src);
  } catch {
    destIsCorrect = false;
  }

  if (!destIsCorrect) {
    fs.rmSync(dest, { recursive: true, force: true });
    // 'junction' needs no admin rights on Windows; the type arg is ignored on POSIX.
    fs.symlinkSync(src, dest, 'junction');
  }
}
