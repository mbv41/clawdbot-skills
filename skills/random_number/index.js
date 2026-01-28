const userState = new Map();

export async function run({ bot, chatId, text }) {
  const args = text.trim().split(/\s+/).slice(1);
  
  if (args[0] === 'help' || text.trim() === '/random help') {
    await bot.sendMessage(chatId, '🎲 **Random Number Generator**\n\nUsage:\n• `/random` - Start interactive mode (I\'ll ask for your numbers)\n• `/random <min> <max>` - Get a random number between min and max\n\nExamples:\n• `/random 1 100` - Random number between 1 and 100\n• `/random -10 10` - Random number between -10 and 10');
    return true;
  }
  
  // Check if user provided both numbers directly
  if (args.length >= 2) {
    const min = parseInt(args[0], 10);
    const max = parseInt(args[1], 10);
    
    if (isNaN(min) || isNaN(max)) {
      await bot.sendMessage(chatId, '❌ Please provide valid numbers. Example: `/random 1 100`');
      return true;
    }
    
    if (min > max) {
      await bot.sendMessage(chatId, `❌ The first number (${min}) should be less than or equal to the second number (${max}).`);
      return true;
    }
    
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    await bot.sendMessage(chatId, `🎲 Random number between ${min} and ${max}:\n\n**${result}**`);
    return true;
  }
  
  // Check if user is in the middle of providing numbers
  const state = userState.get(chatId);
  
  if (state && state.waitingFor === 'max') {
    const max = parseInt(text.trim(), 10);
    
    if (isNaN(max)) {
      await bot.sendMessage(chatId, '❌ That\'s not a valid number. Please enter the maximum number:');
      return true;
    }
    
    const min = state.min;
    
    if (min > max) {
      await bot.sendMessage(chatId, `❌ The maximum (${max}) should be greater than or equal to the minimum (${min}). Please enter a valid maximum:`);
      return true;
    }
    
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    await bot.sendMessage(chatId, `🎲 Random number between ${min} and ${max}:\n\n**${result}**`);
    userState.delete(chatId);
    return true;
  }
  
  if (state && state.waitingFor === 'min') {
    const min = parseInt(text.trim(), 10);
    
    if (isNaN(min)) {
      await bot.sendMessage(chatId, '❌ That\'s not a valid number. Please enter the minimum number:');
      return true;
    }
    
    userState.set(chatId, { waitingFor: 'max', min });
    await bot.sendMessage(chatId, `✅ Minimum: ${min}\n\nNow enter the **maximum** number:`);
    return true;
  }
  
  // Start interactive mode
  userState.set(chatId, { waitingFor: 'min' });
  await bot.sendMessage(chatId, '🎲 **Random Number Generator**\n\nEnter the **minimum** number:');
  return true;
}
