import { toolText } from './fleet-text.mjs';

export const DOER = 'BOILERPLATE-DOER';
export const NO_WORKFLOW = 'NONE';

export function buildRoutePrompt(registry, message) {
  const lines = registry
    .map((entry) => `- ${entry.name}: ${entry.description}`)
    .join('\n');
  return [
    'You are a router for a fleet of workflows. Pick the single best workflow for the user question.',
    'Workflows:',
    lines,
    `Question: ${message}`,
    `Reply with exactly one workflow name from the list, or ${NO_WORKFLOW} if no workflow fits. No other text.`,
  ].join('\n');
}

// Returns the matched registry entry, or null when DOER should answer directly.
export async function routeQuestion({ fleetApi, registry, message, memberName = DOER }) {
  if (!registry || registry.length === 0) return null;
  const result = await fleetApi.executePrompt({
    prompt: buildRoutePrompt(registry, message),
    member_name: memberName,
    // The raw client defaults resume to true; routing prompts are self-contained.
    resume: false,
  });
  if (result?.structuredContent?.isError) {
    throw new Error(toolText(result) || 'routing call failed');
  }
  const answer = toolText(result).trim().toLowerCase();
  return registry.find((entry) => entry.name.toLowerCase() === answer) ?? null;
}
