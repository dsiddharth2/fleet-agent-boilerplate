import fs from 'node:fs/promises';
import path from 'node:path';
import { readHolder } from '../../pool/worker-lock.mjs';

export const meta = { name: 'inspect-members' };

// Purely observational. It deliberately never runs a command AS a member:
// inspecting a worker some run is holding would be the concurrent-same-member
// collision the pool exists to prevent. Folder contents come from this
// process's own filesystem, and busy/free from the worker's lock file.

async function folderReport(role, includeFiles) {
  let entries;
  try {
    entries = await fs.readdir(role.folder);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { name: role.name, folder: role.folder, exists: false, fileCount: 0, totalBytes: 0 };
    }
    throw err;
  }

  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const stat = await fs.stat(path.join(role.folder, entry));
    if (stat.isFile()) {
      fileCount += 1;
      totalBytes += stat.size;
    }
  }

  const report = { name: role.name, folder: role.folder, exists: true, fileCount, totalBytes };
  if (includeFiles) report.entries = entries;
  return report;
}

export async function main(context) {
  const { phase, log, args } = context;
  const reportPhase = args.reportPhase ?? (() => {});
  const signal = args.signal;
  const includeFiles = args.includeFiles === true;
  const roster = args.roster ?? [];

  const workers = [];
  for (const worker of roster) {
    if (signal?.aborted) {
      log(`cancelled before inspecting worker-${worker.id}`);
      break;
    }
    phase(`inspect worker-${worker.id}`);
    await reportPhase(`inspecting worker-${worker.id}`);

    const holder = await readHolder(worker.lockTarget);
    workers.push({
      id: worker.id,
      busy: holder.locked,
      heldSince: holder.heldSince,
      doer: await folderReport(worker.doer, includeFiles),
      reviewer: await folderReport(worker.reviewer, includeFiles),
    });
  }

  return { generatedAt: new Date().toISOString(), poolSize: roster.length, workers };
}
