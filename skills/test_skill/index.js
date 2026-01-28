/**
 * Test Skill - Replies 'ok' to any triggered message
 */

export async function run({ bot, chatId, text }) {
  const trimmed = (text || '').trim().toLowerCase();

  if (trimmed === '/help') {
    await bot.sendMessage(chatId, 'Test Skill\n\nCommands:\n/test or /ok - Get an "ok" reply\n/help - Show this help message');
    return true;
  }

  await bot.sendMessage(chatId, 'ok');
  return true;
}
