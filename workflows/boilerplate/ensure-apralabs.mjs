import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function ensureApralabs() {
  const src = path.join(os.homedir(), '.apra-fleet', 'node_modules', '@apralabs');
  const destDir = path.join(repoRoot, 'node_modules');
  const dest = path.join(destDir, '@apralabs');

  if (!fs.existsSync(src)) {
    if (!fs.existsSync(path.join(dest, 'apra-fleet-workflow'))) {
      throw new Error(
        'Cannot resolve @apralabs/apra-fleet-workflow. Install Fleet (see README) or run: docker compose run --rm fleet node --test tests/boilerplate.test.mjs',
      );
    }
    return;
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
