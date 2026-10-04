const config = require('../config');
const { HttpError } = require('../errors');

const SYSTEM = 'You help people write clear task descriptions for a team task tracker. ' +
  'Reply with plain text only, no markdown headings. Be concise and concrete.';

/** Calls the Anthropic Messages API. Throws HttpError(502) on upstream failure. */
async function complete(prompt, maxTokens = 400) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.aiModel,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => {
    throw new HttpError(502, 'AI provider unreachable');
  });
  if (!res.ok) throw new HttpError(502, `AI provider error (${res.status})`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/**
 * Expands a short idea into a task description. Without an API key a simple template is
 * returned so the endpoint stays usable in development (`generated_by` tells which was used).
 */
async function generateDescription(input) {
  if (!config.anthropicKey) {
    return {
      description: `Goal: ${input}\n\nAcceptance criteria:\n- Define the expected outcome\n- Complete the work\n- Review and confirm with the team`,
      generated_by: 'template',
    };
  }
  const text = await complete(
    `Write a task description (2-4 sentences plus a short acceptance-criteria list) for this task idea:\n\n${input}`,
  );
  return { description: text, generated_by: config.aiModel };
}

/** Summarises a task and its comment thread. */
async function summarizeTask(task, comments) {
  if (!config.anthropicKey) {
    const last = comments.at(-1);
    return {
      summary: `${task.title} [${task.status}]. ${comments.length} comment(s).` + (last ? ` Latest: "${last.body.slice(0, 120)}"` : ''),
      generated_by: 'template',
    };
  }
  const thread = comments.map((c) => `${c.author}: ${c.body}`).join('\n');
  const text = await complete(
    `Summarise this task in 2-3 sentences, including current status and open questions.\n\nTitle: ${task.title}\nStatus: ${task.status}\nDescription: ${task.description}\nComments:\n${thread || '(none)'}`,
    300,
  );
  return { summary: text, generated_by: config.aiModel };
}

module.exports = { generateDescription, summarizeTask };
