import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const meta = { name: 'boilerplate' };

const DOER = 'BOILERPLATE-DOER';
const REVIEWER = 'BOILERPLATE-REVIEWER';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const DUMMY_PY = fileURLToPath(new URL('./dummy.py', import.meta.url));
const DOER_WORK = path.join(repoRoot, 'workdir', DOER);
const REVIEWER_WORK = path.join(repoRoot, 'workdir', REVIEWER);

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

function memberListedInStatus(statusText, name) {
  return statusText.split(/[\n\r]/).some((line) => line.includes(name));
}

async function memberPresent(fleetApi, name) {
  return memberListedInStatus(toolText(await fleetApi.fleetStatus()), name);
}

async function ensureMember(fleetApi, name, workFolder, log) {
  fs.mkdirSync(workFolder, { recursive: true });
  if (await memberPresent(fleetApi, name)) {
    log(`${name} already present; skipping registration`);
    return;
  }
  try {
    await fleetApi.registerMember({
      friendly_name: name,
      work_folder: workFolder,
      member_type: 'local',
    });
    log(`registered ${name}`);
  } catch (err) {
    if (await memberPresent(fleetApi, name)) {
      log(`${name} already present; skipping registration`);
      return;
    }
    throw err;
  }
}

export async function main(context) {
  const { phase, command, transform, agent, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('boilerplate.js requires args.fleetApi');
  }

  phase('register BOILERPLATE-DOER and BOILERPLATE-REVIEWER');
  await ensureMember(fleetApi, DOER, DOER_WORK, log);
  await ensureMember(fleetApi, REVIEWER, REVIEWER_WORK, log);

  phase('status');
  const status = await fleetApi.fleetStatus();
  const statusText = toolText(status);
  const hasDoer = statusText.includes(DOER);
  const hasReviewer = statusText.includes(REVIEWER);
  log(`fleet status: ${DOER}=${hasDoer ? 'present' : 'missing'}, ${REVIEWER}=${hasReviewer ? 'present' : 'missing'}`);
  log(statusText);

  phase('python command');
  const cmdResult = await command(`python3 "${DUMMY_PY}"`, {
    member_name: DOER,
    failSoft: true,
  });
  log(`command result: ${typeof cmdResult === 'string' ? cmdResult : JSON.stringify(cmdResult)}`);

  phase('transform returns value');
  const payload = await transform('dummy payload', () => ({ ok: true, source: 'transform' }));
  log(`transform result: ${JSON.stringify(payload)}`);

  phase('agent smoke');
  const reply = await agent('Reply with exactly: pong', { member_name: DOER });
  log(`agent result: ${reply}`);

  return { command: cmdResult, transform: payload, agent: reply };
}
