export async function getDMChannel(client, userId) {
  const result = await client.conversations.open({ users: userId });
  if (!result.ok || !result.channel?.id) {
    throw new Error(`Failed to open DM channel for ${userId}: ${result.error ?? 'unknown error'}`);
  }
  return result.channel.id;
}
