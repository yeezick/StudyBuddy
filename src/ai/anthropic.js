import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const MODEL = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in .env');
}

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(message) {
  const block = message.content?.find((b) => b.type === 'text');
  return block?.text ?? '';
}

function stripFences(text) {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function tryParse(text) {
  return JSON.parse(stripFences(text));
}

// Streams one reply: `onText` gets the text so far after each chunk. Resolves with the parsed
// JSON; a reply that is not valid JSON rejects (no second attempt, unlike callJSON).
export async function streamJSON({ system, user, max_tokens = 4096, onText }) {
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  stream.on('text', (_delta, snapshot) => onText(snapshot));
  return tryParse(extractText(await stream.finalMessage()));
}

// `requestOptions` go to the SDK as-is (e.g. { signal, maxRetries }) on both attempts.
export async function callJSON({ system, user, max_tokens = 4096, requestOptions }) {
  const first = await anthropic.messages.create({
    model: MODEL,
    max_tokens,
    system,
    messages: [{ role: 'user', content: user }],
  }, requestOptions);
  const firstText = extractText(first);
  try {
    return tryParse(firstText);
  } catch {
    const retry = await anthropic.messages.create({
      model: MODEL,
      max_tokens,
      system: `${system}\n\nCRITICAL: Return ONLY valid JSON. No preamble, no markdown fences, no commentary.`,
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'That was not valid JSON. Return ONLY the JSON value.' },
      ],
    }, requestOptions);
    return tryParse(extractText(retry));
  }
}
