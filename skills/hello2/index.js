export async function run({ bot, chatId }) {
  await bot.sendMessage(chatId, "🚀 Hello2 installed from GitHub!");
  return true;
}
