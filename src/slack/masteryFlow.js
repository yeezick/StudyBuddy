import { getConcepts } from '../lib/concepts.js';
import { getAllMastery, masteryScore, isDue } from '../lib/mastery.js';

function masteryBar(score) {
  const filled = Math.round(score * 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

export async function buildMasterySnapshot(userId) {
  const concepts = await getConcepts(userId);
  if (concepts.length === 0) return null;

  const masteryObjects = await getAllMastery(userId, concepts.map((c) => c.id));
  return summarizeMastery(concepts, masteryObjects);
}

// Pure: concepts + their cards (same order) → the snapshot /mastery and the digest render.
export function summarizeMastery(concepts, masteryObjects, now = new Date()) {
  // Group by module, preserving insertion order
  const byModule = new Map();
  for (let i = 0; i < concepts.length; i++) {
    const moduleName = concepts[i].scope?.module ?? 'Uncategorized';
    if (!byModule.has(moduleName)) byModule.set(moduleName, []);
    byModule.get(moduleName).push({ concept: concepts[i], mastery: masteryObjects[i] });
  }

  const courseName = concepts[0].scope?.course ?? null;

  const modules = [...byModule.entries()].map(([name, items]) => {
    const avg = items.reduce((sum, { mastery }) => sum + masteryScore(mastery, now), 0) / items.length;
    // Display label comes from the seed (scope.moduleLabel on any concept in the module)
    const label = items.find(({ concept }) => concept.scope?.moduleLabel)?.concept.scope.moduleLabel;
    return { name, label: label ?? name, avg, count: items.length };
  });

  const dueToday = concepts
    .map((c, i) => ({ concept: c, mastery: masteryObjects[i] }))
    .filter(({ mastery }) => isDue(mastery, now))
    .map(({ concept }) => concept.name);

  return { courseName, modules, dueToday };
}

export function formatMasteryBlocks(snapshot) {
  const { courseName, modules, dueToday } = snapshot;

  const header = courseName
    ? `\ud83d\udcca *Mastery Snapshot \u2014 ${courseName}*`
    : '\ud83d\udcca *Mastery Snapshot*';

  const labels = modules.map(({ name, label }) => label ?? name);
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const barLines = modules
    .map(({ name, avg, count }, i) => {
      const pct = Math.round(avg * 100);
      return `${labels[i].padEnd(labelWidth)}  ${masteryBar(avg)}  ${String(pct).padStart(3)}%  (${count} concepts)`;
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

// Calibration (DEC-058 §3): how often answers at each confidence level were right, from the
// review events of the last 7 days. Explain-backs and answers without a confidence tap are
// left out; a level with no answers is omitted, and the whole line when fewer than 5 count.
export const CALIBRATION_MIN_N = 5;
const CALIBRATION_LEVELS = [[1, 'Guess'], [2, 'Medium'], [3, 'Sure']];

export function calibrationLine(events) {
  const rated = events.filter((e) => e.itemType !== 'explain_back' && [1, 2, 3].includes(e.confidence) && typeof e.correct === 'boolean');
  if (rated.length < CALIBRATION_MIN_N) return null;
  const parts = [];
  for (const [level, label] of CALIBRATION_LEVELS) {
    const atLevel = rated.filter((e) => e.confidence === level);
    if (atLevel.length === 0) continue;
    const pct = Math.round((atLevel.filter((e) => e.correct).length / atLevel.length) * 100);
    parts.push(`${label} ${pct}%${parts.length === 0 ? ' right' : ''} (${atLevel.length})`);
  }
  return `Calibration (7 days): ${parts.join(' \u00b7 ')}`;
}

// previousSnapshot: { modules: [{ name, avg }] } from mastery-snapshot Redis key 7 days ago
export function formatWeeklyDigestBlocks(snapshot, previousSnapshot, weekStats) {
  const { courseName, modules, dueToday } = snapshot;

  const header = courseName
    ? `\ud83d\udcca *Weekly Digest \u2014 ${courseName}*`
    : '\ud83d\udcca *Weekly Digest*';

  const prevMap = previousSnapshot
    ? Object.fromEntries(previousSnapshot.modules.map((m) => [m.name, m.avg]))
    : {};

  const labels = modules.map(({ name, label }) => label ?? name);
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const barLines = modules
    .map(({ name, avg, count }, i) => {
      const pct = Math.round(avg * 100);
      const delta = prevMap[name] != null ? Math.round((avg - prevMap[name]) * 100) : null;
      const deltaStr = delta != null ? `  (${delta >= 0 ? '+' : ''}${delta}% this week)` : '';
      return `${labels[i].padEnd(labelWidth)}  ${masteryBar(avg)}  ${String(pct).padStart(3)}%  (${count} concepts)${deltaStr}`;
    })
    .join('\n');

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${barLines}\`\`\`` } },
  ];

  if (dueToday.length > 0) {
    const dueText =
      '*Due for review today:*\n' + dueToday.map((name) => `\u2022 ${name}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: dueText } });
  }

  if (weekStats) {
    const { quizCount, conceptsTested } = weekStats;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `This week: ${quizCount} quiz${quizCount !== 1 ? 'zes' : ''} \u00b7 ${conceptsTested} concepts tested`,
      },
    });
    if (weekStats.calibration) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: weekStats.calibration } });
    }
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
