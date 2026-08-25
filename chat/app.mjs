import crypto from 'node:crypto';
import express from 'express';
import { authenticate as defaultAuthenticate } from './auth.mjs';
import { toolText } from './fleet-text.mjs';
import { defaultRegistry } from './registry.mjs';
import { routeQuestion, DOER } from './router.mjs';

const MAX_HISTORY = 20; // messages kept per session (user + assistant combined)

function buildDirectPrompt(history, message) {
  const transcript = [...history, { role: 'user', content: message }]
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join('\n');
  return [
    'You are a helpful assistant in a chat conversation.',
    'Conversation so far:',
    transcript,
    "Reply with only the assistant's next message, no preamble.",
  ].join('\n');
}

export function createChatApp({
  fleetApi,
  registry = defaultRegistry,
  authenticate = defaultAuthenticate,
  memberName = DOER,
  maxHistory = MAX_HISTORY,
} = {}) {
  if (!fleetApi) {
    throw new Error('createChatApp requires fleetApi');
  }
  const sessions = new Map();
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/chat', authenticate, async (req, res) => {
    const { message, sessionId } = req.body ?? {};
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message (non-empty string) is required' });
      return;
    }
    const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : crypto.randomUUID();
    const history = sessions.get(id) ?? [];

    let reply;
    let workflowName = 'direct';
    try {
      const entry = await routeQuestion({ fleetApi, registry, message, memberName });
      if (entry) {
        workflowName = entry.name;
        reply = await entry.run({ fleetApi, message, history });
      } else {
        const result = await fleetApi.executePrompt({
          prompt: buildDirectPrompt(history, message),
          member_name: memberName,
          // The raw client defaults resume to true; chat prompts are self-contained.
          resume: false,
        });
        if (result?.structuredContent?.isError) {
          res.status(502).json({ error: toolText(result) || 'agent dispatch failed' });
          return;
        }
        reply = toolText(result);
      }
    } catch (err) {
      res.status(502).json({ error: err?.message ?? String(err) });
      return;
    }

    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    sessions.set(id, history.slice(-maxHistory));
    res.json({ sessionId: id, reply, workflow: workflowName });
  });

  return app;
}
