// One mock for every test file. listMembers is the call the pool verifies its
// roster with -- fleetStatus reports server info, not members, so a mock that
// answers member names from fleetStatus would hide a real bug.
export function createMockFleetApi({ members = [], missing = [] } = {}) {
  const registerCalls = [];
  const commandCalls = [];
  const promptCalls = [];
  const present = members.filter((name) => !missing.includes(name));

  return {
    registerCalls,
    commandCalls,
    promptCalls,
    async listMembers() {
      return { content: [{ type: 'text', text: present.join('\n') }] };
    },
    async fleetStatus() {
      return { content: [{ type: 'text', text: 'fleet server: running' }] };
    },
    async registerMember(options) {
      registerCalls.push(options);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload = 'hello-from-python';
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return {
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { response: 'pong' },
      };
    },
  };
}

export function rosterNames(size) {
  return Array.from({ length: size }, (_, index) => index + 1).flatMap((id) => [
    `WORKER-${id}-DOER`,
    `WORKER-${id}-REVIEWER`,
  ]);
}
