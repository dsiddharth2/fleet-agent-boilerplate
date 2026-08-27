import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const meta = { name: 'inspect-members' };

const DOER = 'BOILERPLATE-DOER';
const REVIEWER = 'BOILERPLATE-REVIEWER';

// Default to the members this repo owns. A shared Fleet server may host other
// projects' members, and reporting on those would leak unrelated information.
const DEFAULT_MEMBERS = [DOER, REVIEWER];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const INSPECT_PY = fileURLToPath(new URL('./inspect.py', import.meta.url));
const MEMBER_TARGETS = new Map([
  [DOER, { name: DOER, workFolder: path.join(repoRoot, 'workdir', DOER) }],
  [REVIEWER, { name: REVIEWER, workFolder: path.join(repoRoot, 'workdir', REVIEWER) }],
]);

function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// The engine returns { ok, output, error } — verified from a live run. A
// failSoft failure carries an empty output and puts the reason in `error`, so
// read that first and skip empty candidates rather than returning ''.
function commandText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw.ok === false) {
    const detail = raw.error ?? raw.output;
    return typeof detail === 'string' && detail.trim().length > 0 ? detail : 'command failed';
  }
  for (const candidate of [raw.output, raw.stdout, raw.structuredContent?.stdout]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return toolText(raw);
}

function parseReport(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // Keep scanning earlier lines.
      }
    }
  }
  return null;
}

function memberListedInStatus(statusText, name) {
  return statusText.split(/[\n\r]/).some((line) => line.includes(name));
}

export async function main(context) {
  const { phase, command, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('inspect-members.js requires args.fleetApi');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const includeFiles = args.includeFiles === true;
  const requestedMembers =
    Array.isArray(args.members) && args.members.length > 0 ? args.members : DEFAULT_MEMBERS;
  const targets = requestedMembers.map((name) => {
    const target = MEMBER_TARGETS.get(name);
    if (!target) {
      throw new Error(`Unsupported member: ${String(name)}`);
    }
    return target;
  });

  phase('status');
  await reportPhase('reading fleet status');
  const statusText = toolText(await fleetApi.fleetStatus());

  const members = [];
  for (const { name, workFolder } of targets) {
    if (signal?.aborted) {
      log(`cancelled before inspecting ${name}`);
      break;
    }

    if (!memberListedInStatus(statusText, name)) {
      log(`${name} is not registered`);
      members.push({ name, present: false });
      continue;
    }

    phase(`inspect ${name}`);
    await reportPhase(`inspecting ${name}`);
    const flags = includeFiles ? ' --files' : '';
    const raw = await command(
      `python3 "${INSPECT_PY}" --root "${workFolder}"${flags}`,
      { member_name: name, failSoft: true },
    );
    const text = commandText(raw);
    const report = parseReport(text);
    if (report) {
      members.push({ name, present: true, report });
    } else {
      members.push({ name, present: true, error: text.trim() || 'no report produced' });
    }
  }

  return { generatedAt: new Date().toISOString(), members };
}
