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
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  // Cancellation is cooperative: an in-flight Fleet call cannot be aborted, so
  // each check prevents the NEXT phase from starting. The check before agent()
  // is the one that matters, because that is the phase that spends tokens.
  const cancelled = () => signal?.aborted === true;

  phase('register BOILERPLATE-DOER and BOILERPLATE-REVIEWER');
  await reportPhase('registering members');
  await ensureMember(fleetApi, DOER, DOER_WORK, log);
  await ensureMember(fleetApi, REVIEWER, REVIEWER_WORK, log);
  if (cancelled()) return { cancelled: true };

  phase('status');
  await reportPhase('reading fleet status');
  const status = await fleetApi.fleetStatus();
  const statusText = toolText(status);
  const hasDoer = statusText.includes(DOER);
  const hasReviewer = statusText.includes(REVIEWER);
  log(`fleet status: ${DOER}=${hasDoer ? 'present' : 'missing'}, ${REVIEWER}=${hasReviewer ? 'present' : 'missing'}`);
  log(statusText);
  if (cancelled()) return { cancelled: true };

  phase('python command');
  await reportPhase('running the python command');
  const cmdResult = await command(`python3 "${DUMMY_PY}"`, {
    member_name: DOER,
    failSoft: true,
  });
  log(`command result: ${typeof cmdResult === 'string' ? cmdResult : JSON.stringify(cmdResult)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult };

  phase('transform returns value');
  await reportPhase('running the transform');
  const payload = await transform('dummy payload', () => ({ ok: true, source: 'transform' }));
  log(`transform result: ${JSON.stringify(payload)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };

  phase('agent smoke');
  await reportPhase('dispatching the agent prompt');
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };
  const reply = await agent('Reply with exactly: pong', { member_name: DOER });
  log(`agent result: ${reply}`);

  return { command: cmdResult, transform: payload, agent: reply };
}
