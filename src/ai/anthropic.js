import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-sonnet-4-6';

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

export async function callJSON({ system, user, max_tokens = 4096 }) {
  const first = await anthropic.messages.create({
    model: MODEL,
    max_tokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
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
    });
    return tryParse(extractText(retry));
  }
}
