import { getConcepts } from '../lib/concepts.js';
import { getAllMastery } from '../lib/mastery.js';

function masteryBar(score) {
  const filled = Math.round(score * 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

export async function buildMasterySnapshot(userId) {
  const concepts = await getConcepts(userId);
  if (concepts.length === 0) return null;

  const masteryObjects = await getAllMastery(userId, concepts.map((c) => c.id));

  // Group by module, preserving insertion order
  const byModule = new Map();
  for (let i = 0; i < concepts.length; i++) {
    const moduleName = concepts[i].scope?.module ?? 'Uncategorized';
    if (!byModule.has(moduleName)) byModule.set(moduleName, []);
    byModule.get(moduleName).push({ concept: concepts[i], mastery: masteryObjects[i] });
  }

  const courseName = concepts[0].scope?.course ?? null;

  const modules = [...byModule.entries()].map(([name, items]) => {
    const avg = items.reduce((sum, { mastery }) => sum + (mastery.score ?? 0), 0) / items.length;
    return { name, avg, count: items.length };
  });

  const now = new Date();
  const dueToday = concepts
    .map((c, i) => ({ concept: c, mastery: masteryObjects[i] }))
    .filter(({ mastery }) => mastery.nextReviewAt && new Date(mastery.nextReviewAt) <= now)
    .map(({ concept }) => concept.name);

  return { courseName, modules, dueToday };
}

export function formatMasteryBlocks(snapshot) {
  const { courseName, modules, dueToday } = snapshot;

  const header = courseName
    ? `\ud83d\udcca *Mastery Snapshot \u2014 ${courseName}*`
    : '\ud83d\udcca *Mastery Snapshot*';

  const barLines = modules
    .map(({ name, avg, count }) => {
      const pct = Math.round(avg * 100);
      return `${name.padEnd(12)}  ${masteryBar(avg)}  ${String(pct).padStart(3)}%  (${count} concepts)`;
    })
    .join('\n');

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: header },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${barLines}\`\`\`` },
    },
  ];

  if (dueToday.length > 0) {
    const dueText =
      '*Due for review today:*\n' + dueToday.map((name) => `\u2022 ${name}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: dueText } });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '`/quizinit` to drill weak concepts now.' },
  });

  return blocks;
}

export async function postMasterySnapshot(client, userId, channelId) {
  const snapshot = await buildMasterySnapshot(userId);

  if (!snapshot) {
    await client.chat.postMessage({
      channel: channelId,
      text: 'No concepts in your library yet.',
    });
    return;
  }

  await client.chat.postMessage({
    channel: channelId,
    blocks: formatMasteryBlocks(snapshot),
    text: '\ud83d\udcca Mastery Snapshot',
  });
}
