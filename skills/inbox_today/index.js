export async function run({ bot, chatId, text }) {
  // TODO: implement the skill logic
  await bot.sendMessage(chatId, "✅ Skill 'inbox_today' is installed, but not implemented yet.");
  return true;
}
