import { runBoilerplate } from '../workflows/boilerplate/main.mjs';

// Routable workflows. To make a new workflow routable, append
// { name, description, run } here — no router or route changes needed.
// `description` is what the LLM router reads to pick a workflow; write it
// for a classifier, not a human changelog.
export const defaultRegistry = [
  {
    name: 'boilerplate',
    description:
      'Runs the boilerplate demo workflow end to end: registers BOILERPLATE members, ' +
      'runs the dummy python command, the transform, and the agent smoke test. ' +
      'Choose this when the user asks to run the demo/boilerplate workflow or to verify fleet plumbing.',
    async run({ fleetApi }) {
      const result = await runBoilerplate({ fleetApi });
      return `boilerplate workflow completed: ${JSON.stringify(result)}`;
    },
  },
];
