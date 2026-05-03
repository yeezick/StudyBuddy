import { boltApp } from './app.js';
import { startQuiz } from './quizFlow.js';
import { postMasterySnapshot } from './masteryFlow.js';

function parseQuizArgs(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { mode: 'all' };

  const moduleMatch = trimmed.match(/^module\s+"([^"]+)"$/i);
  if (moduleMatch) return { mode: 'scope', scope: { module: moduleMatch[1] } };

  const lessonMatch = trimmed.match(/^lesson\s+"([^"]+)"$/i);
  if (lessonMatch) return { mode: 'scope', scope: { lesson: lessonMatch[1] } };

  const promptMatch = trimmed.match(/^"([^"]+)"$/);
  if (promptMatch) return { mode: 'free_form_prompt', freeFormPrompt: promptMatch[1] };

  return { mode: 'unknown', raw: trimmed };
}

function parseStudyArgs(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { sub: 'unknown', raw: '' };

  if (trimmed === 'end') return { sub: 'end' };

  const startMatch = trimmed.match(/^start(?:\s+(\d+\s*[hm]))?\s+"([^"]+)"$/i);
  if (startMatch) {
    return { sub: 'start', duration: startMatch[1]?.trim() ?? null, topic: startMatch[2] };
  }

  return { sub: 'unknown', raw: trimmed };
}

export function registerCommands() {
  boltApp.command('/quizinit', async ({ command, ack, client, respond }) => {
    await ack();
    const parsed = parseQuizArgs(command.text);

    if (parsed.mode === 'unknown') {
      await respond({
        response_type: 'ephemeral',
        text: 'Unrecognized input. Try:\n\u2022 `/quizinit` \u2014 all concepts\n\u2022 `/quizinit module "Module 2"`\n\u2022 `/quizinit lesson "L3"`\n\u2022 `/quizinit "explain RAG failure modes"`',
      });
      return;
    }

    const userId = process.env.SINGLE_USER_ID;
    try {
      await startQuiz(client, userId, command.user_id, command.channel_id, parsed);
    } catch (err) {
      console.error('[quizinit] startQuiz failed:', err);
      await client.chat.postMessage({
        channel: command.channel_id,
        text: '\u26a0\ufe0f Something went wrong starting the quiz. Check server logs.',
      });
    }
  });

  boltApp.command('/focus', async ({ command, ack, respond }) => {
    await ack();
    const parsed = parseStudyArgs(command.text);
    await respond({
      response_type: 'ephemeral',
      text: `📚 \`/focus\` received — Step 10 will implement.\nParsed: \`${JSON.stringify(parsed)}\``,
    });
  });

  boltApp.command('/mastery', async ({ command, ack, client }) => {
    await ack();
    const userId = process.env.SINGLE_USER_ID;
    try {
      await postMasterySnapshot(client, userId, command.channel_id);
    } catch (err) {
      console.error('[mastery] postMasterySnapshot failed:', err);
      await client.chat.postMessage({
        channel: command.channel_id,
        text: '\u26a0\ufe0f Something went wrong fetching your mastery. Check server logs.',
      });
    }
  });

  boltApp.command('/brief', async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: '🟢 `/brief` received — Step 8 will implement.',
    });
  });
}
