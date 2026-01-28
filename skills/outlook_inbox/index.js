// Required ENV vars:
// MICROSOFT_CLIENT_ID - Azure AD app client ID
// MICROSOFT_CLIENT_SECRET - Azure AD app client secret
// MICROSOFT_TENANT_ID - Azure AD tenant ID (or "common" for multi-tenant)
// MICROSOFT_REDIRECT_URI - OAuth redirect URI

import { ConfidentialClientApplication } from '@azure/msal-node';

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`
  }
};

const SCOPES = ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/User.Read'];

// In-memory token store (use persistent DB in production)
const tokenStore = new Map();

export async function run({ bot, chatId, text, userId }) {
  const args = text.trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  if (command === '/help' || command === '/outlook' && args[1] === 'help') {
    await bot.sendMessage(chatId, 
`📧 *Outlook Inbox Summary*

Commands:
• \`/outlook\` - Summarize today's emails
• \`/outlook auth\` - Authenticate with Microsoft 365
• \`/outlook status\` - Check auth status
• \`/inbox\` - Alias for /outlook

Features:
✅ Summarizes today's emails
✅ Extracts action items/to-dos
✅ Tracks frequent senders
✅ Shows email importance`, { parse_mode: 'Markdown' });
    return true;
  }

  if (args[1] === 'auth') {
    return await handleAuth(bot, chatId, userId);
  }

  if (args[1] === 'status') {
    const hasToken = tokenStore.has(userId);
    await bot.sendMessage(chatId, hasToken ? '✅ Authenticated with Microsoft 365' : '❌ Not authenticated. Use `/outlook auth`', { parse_mode: 'Markdown' });
    return true;
  }

  // Main flow: fetch and summarize emails
  const token = tokenStore.get(userId);
  if (!token) {
    await bot.sendMessage(chatId, '🔐 Please authenticate first with `/outlook auth`', { parse_mode: 'Markdown' });
    return true;
  }

  await bot.sendMessage(chatId, '📬 Fetching today\'s emails...');

  try {
    const emails = await fetchTodaysEmails(token);
    
    if (emails.length === 0) {
      await bot.sendMessage(chatId, '📭 No emails received today.');
      return true;
    }

    const summary = generateSummary(emails);
    const todos = extractTodos(emails);
    const frequentSenders = trackFrequentSenders(emails);

    let response = `📧 *Today's Inbox Summary*\n`;
    response += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    response += `📊 *Overview:* ${emails.length} emails received\n\n`;
    
    response += `📝 *Summary:*\n${summary}\n\n`;
    
    response += `✅ *Action Items/To-Dos:*\n`;
    if (todos.length > 0) {
      todos.forEach((todo, i) => {
        response += `${i + 1}. ${todo}\n`;
      });
    } else {
      response += `No action items detected.\n`;
    }
    
    response += `\n👥 *Frequent Senders:*\n`;
    frequentSenders.slice(0, 5).forEach(sender => {
      const importanceIcon = sender.hasImportant ? '🔴' : '⚪';
      response += `${importanceIcon} ${sender.name}: ${sender.count} email(s)\n`;
    });

    await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    return true;

  } catch (error) {
    if (error.message.includes('401') || error.message.includes('token')) {
      tokenStore.delete(userId);
      await bot.sendMessage(chatId, '🔐 Session expired. Please re-authenticate with `/outlook auth`', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, `❌ Error fetching emails: ${error.message}`);
    }
    return false;
  }
}

async function handleAuth(bot, chatId, userId) {
  try {
    const pca = new ConfidentialClientApplication(msalConfig);
    const authUrl = await pca.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3000/auth/callback',
      state: userId
    });
    
    await bot.sendMessage(chatId, 
`🔐 *Microsoft 365 Authentication*

Click the link below to authorize access to your Outlook inbox:

[Authorize Access](${authUrl})

After authorizing, send me the code you receive with:
\`/outlook code YOUR_CODE_HERE\``, { parse_mode: 'Markdown', disable_web_page_preview: true });
    
    return true;
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Auth error: ${error.message}`);
    return false;
  }
}

async function fetchTodaysEmails(token) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${todayISO}&$orderby=receivedDateTime desc&$top=50&$select=subject,from,bodyPreview,importance,receivedDateTime,isRead`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.value || [];
}

function generateSummary(emails) {
  const unread = emails.filter(e => !e.isRead).length;
  const important = emails.filter(e => e.importance === 'high').length;
  const subjects = emails.slice(0, 5).map(e => `• ${truncate(e.subject || '(No subject)', 50)}`).join('\n');
  
  let summary = `${unread} unread, ${important} marked important.\n\n`;
  summary += `*Recent:*\n${subjects}`;
  
  return summary;
}

function extractTodos(emails) {
  const todos = [];
  const actionKeywords = /\b(please|action required|todo|to-do|need you to|can you|could you|urgent|asap|deadline|by end of day|eod|follow up|review|approve|submit|complete|send|schedule|call|meeting)\b/i;
  
  for (const email of emails) {
    const text = `${email.subject || ''} ${email.bodyPreview || ''}`.toLowerCase();
    
    if (actionKeywords.test(text)) {
      const todoItem = `[${email.from?.emailAddress?.name || 'Unknown'}] ${truncate(email.subject || email.bodyPreview, 60)}`;
      if (!todos.includes(todoItem)) {
        todos.push(todoItem);
      }
    }
  }
  
  return todos.slice(0, 10);
}

function trackFrequentSenders(emails) {
  const senderMap = new Map();
  
  for (const email of emails) {
    const addr = email.from?.emailAddress?.address || 'unknown';
    const name = email.from?.emailAddress?.name || addr;
    
    if (!senderMap.has(addr)) {
      senderMap.set(addr, { name, count: 0, hasImportant: false });
    }
    
    const sender = senderMap.get(addr);
    sender.count++;
    if (email.importance === 'high') {
      sender.hasImportant = true;
    }
  }
  
  return Array.from(senderMap.values())
    .sort((a, b) => {
      if (a.hasImportant !== b.hasImportant) return b.hasImportant ? 1 : -1;
      return b.count - a.count;
    });
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len - 3) + '...' : str;
}
