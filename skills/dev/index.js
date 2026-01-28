import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

const HOME = os.homedir();

// Repo + drafts live in your existing layout
const DRAFT_ROOT = path.join(HOME, "clawdbot", "clawdbot_data", "skill_drafts");
const REPO_WORKDIR = path.join(HOME, "clawdbot", "clawdbot_data", "skills_repo");

// Where to store pending Qs for a skill
function draftPaths(skillName) {
  const draftDir = path.join(DRAFT_ROOT, skillName);
  return {
    draftDir,
    skillJsonPath: path.join(draftDir, "skill.json"),
    indexJsPath: path.join(draftDir, "index.js"),
    pendingPath: path.join(draftDir, ".pending.json"),
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readFileSafe(p) {
  return fs.readFileSync(p, "utf8");
}
function writeFileSafe(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, "utf8");
}
function listDirs(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}
function splitForTelegram(text, max = 3500) {
  const chunks = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks;
}
function safeName(name) {
  if (!name) return null;
  const n = name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(n)) return null;
  return n;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: "pipe" }).toString("utf8").trim();
}

function ensureRepoReady() {
  const repoUrl = requireEnv("GITHUB_SKILLS_REPO_URL");
  const token = requireEnv("GITHUB_TOKEN");
  const branch = process.env.GITHUB_SKILLS_BRANCH || "main";

  // Use https token injection
  const authedUrl = repoUrl.replace(/^https:\/\//, `https://${token}@`);

  if (!fs.existsSync(path.join(REPO_WORKDIR, ".git"))) {
    ensureDir(path.dirname(REPO_WORKDIR));
    execSync(`git clone --branch ${branch} ${authedUrl} ${REPO_WORKDIR}`, { stdio: "pipe" });
  } else {
    git("fetch --all", REPO_WORKDIR);
    git(`checkout ${branch}`, REPO_WORKDIR);
    git("pull", REPO_WORKDIR);
  }

  return { branch };
}

function copyRepoToDraft(skillName) {
  const { draftDir, skillJsonPath, indexJsPath } = draftPaths(skillName);

  const repoSkillDir = path.join(REPO_WORKDIR, "skills", skillName);
  const repoSkillJson = path.join(repoSkillDir, "skill.json");
  const repoIndex = path.join(repoSkillDir, "index.js");

  if (!fs.existsSync(repoSkillJson) || !fs.existsSync(repoIndex)) {
    throw new Error(`Skill not found in repo: skills/${skillName}`);
  }

  ensureDir(draftDir);
  writeFileSafe(skillJsonPath, readFileSafe(repoSkillJson));
  writeFileSafe(indexJsPath, readFileSafe(repoIndex));
}

function copyDraftToRepo(skillName) {
  const { skillJsonPath, indexJsPath } = draftPaths(skillName);

  if (!fs.existsSync(skillJsonPath) || !fs.existsSync(indexJsPath)) {
    throw new Error(`Draft '${skillName}' missing skill.json or index.js. Try: /dev show ${skillName}`);
  }

  // validate JSON
  JSON.parse(readFileSafe(skillJsonPath));

  const destDir = path.join(REPO_WORKDIR, "skills", skillName);
  ensureDir(destDir);

  writeFileSafe(path.join(destDir, "skill.json"), readFileSafe(skillJsonPath));
  writeFileSafe(path.join(destDir, "index.js"), readFileSafe(indexJsPath));
}

function commitAndPush(skillName, message) {
  const branch = process.env.GITHUB_SKILLS_BRANCH || "main";

  try {
    git(`config user.email "clawdbot@local"`, REPO_WORKDIR);
    git(`config user.name "Clawdbot"`, REPO_WORKDIR);
  } catch {}

  git(`add skills/${skillName}`, REPO_WORKDIR);

  const status = git("status --porcelain", REPO_WORKDIR);
  if (!status) return { didCommit: false, branch };

  const msg = message && message.trim() ? message.trim() : `Add/update skill ${skillName}`;
  const safeMsg = msg.replace(/"/g, '\\"');

  git(`commit -m "${safeMsg}"`, REPO_WORKDIR);
  git(`push origin ${branch}`, REPO_WORKDIR);

  const head = git("rev-parse --short HEAD", REPO_WORKDIR);
  return { didCommit: true, branch, commit: head };
}

async function callClaude({ system, user }) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-5-20251101";

  const client = new Anthropic({ apiKey });

  const resp = await client.messages.create({
    model,
    max_tokens: 2800,
    system,
    messages: [{ role: "user", content: user }],
  });

  return (resp.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw);
}

// Generates a skill from plain English. Ask at most 2 blocker questions.
// MUST still draft code even if questions exist.
async function generateSkillFromSpec({ skillName, request, existing }) {
  const system =
    "You are Clawdbot Dev. The user gives a simple request. Default: assume reasonable defaults and ship. " +
    "Only ask questions if truly blocking. Ask at most 2 short questions. " +
    "Output ONLY JSON (or ```json fenced) with keys: skillJson (object), indexJs (string), optional questions (array). " +
    "The skill must export: export async function run({ bot, chatId, text }) { ... return true/false }. " +
    "Keep output robust and minimal. Include a /help response. " +
    "If external integration needed (Outlook/Gmail), include an /auth flow and required env vars in comments.";

  const user = [
    `Skill name: ${skillName}`,
    `User request: ${request}`,
    existing ? `Existing skill.json:\n${existing.skillJson}\n\nExisting index.js:\n${existing.indexJs}` : "No existing code.",
    "",
    "Remember: Output JSON only.",
  ].join("\n");

  const out = await callClaude({ system, user });
  const parsed = extractJsonBlock(out);

  if (!parsed.skillJson || typeof parsed.indexJs !== "string") {
    throw new Error("Claude output missing skillJson or indexJs");
  }

  if (parsed.questions && !Array.isArray(parsed.questions)) parsed.questions = null;
  if (Array.isArray(parsed.questions)) parsed.questions = parsed.questions.slice(0, 2);

  // normalize manifest
  parsed.skillJson.name = skillName;
  parsed.skillJson.entry = "index.js";
  if (!parsed.skillJson.version) parsed.skillJson.version = "0.1.0";
  if (!Array.isArray(parsed.skillJson.commands)) parsed.skillJson.commands = [];

  const cmd = `/${skillName}`;
  if (!parsed.skillJson.commands.includes(cmd)) parsed.skillJson.commands.unshift(cmd);

  return parsed;
}

function savePending(pendingPath, payload) {
  writeFileSafe(pendingPath, JSON.stringify(payload, null, 2) + "\n");
}
function loadPending(pendingPath) {
  if (!fs.existsSync(pendingPath)) return null;
  return JSON.parse(readFileSafe(pendingPath));
}
function clearPending(pendingPath) {
  if (fs.existsSync(pendingPath)) fs.rmSync(pendingPath, { force: true });
}

export async function run({ bot, chatId, text }) {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("/dev")) return false;

  ensureDir(DRAFT_ROOT);

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    await bot.sendMessage(
      chatId,
      [
        "Dev commands:",
        "- /dev make <skill> <request>",
        "- /dev revise <skill> <changes>",
        "- /dev answer <skill> <answers...>",
        "- /dev pull <skill>",
        "- /dev show <skill>",
        "- /dev publish <skill> \"commit msg\"",
        "- /dev list",
        "- /dev rm <skill>",
      ].join("\n")
    );
    return true;
  }

  const sub = parts[1];

  if (sub === "list") {
    const names = listDirs(DRAFT_ROOT);
    await bot.sendMessage(
      chatId,
      names.length ? "Drafted skills:\n" + names.map((n) => `- ${n}`).join("\n") : "No drafted skills yet. Use: /dev make <skill> <request>"
    );
    return true;
  }

  if (sub === "rm") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev rm <skill>");
      return true;
    }
    const { draftDir } = draftPaths(name);
    if (!fs.existsSync(draftDir)) {
      await bot.sendMessage(chatId, `No draft found for '${name}'.`);
      return true;
    }
    fs.rmSync(draftDir, { recursive: true, force: true });
    await bot.sendMessage(chatId, `🗑️ Deleted draft '${name}'.`);
    return true;
  }

  if (sub === "pull") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev pull <skill>");
      return true;
    }
    try {
      await bot.sendMessage(chatId, `⏳ Pulling '${name}' from GitHub into drafts...`);
      ensureRepoReady();
      copyRepoToDraft(name);
      await bot.sendMessage(chatId, `✅ Pulled. Review with: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Pull failed: ${err?.message || String(err)}`);
    }
    return true;
  }

  if (sub === "show") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev show <skill>");
      return true;
    }
    const { skillJsonPath, indexJsPath } = draftPaths(name);
    if (!fs.existsSync(skillJsonPath) || !fs.existsSync(indexJsPath)) {
      await bot.sendMessage(chatId, `No draft found for '${name}'. Use: /dev make ${name} <request>`);
      return true;
    }

    const combined =
`skills/${name}/skill.json
\`\`\`json
${readFileSafe(skillJsonPath)}\`\`\`

skills/${name}/index.js
\`\`\`js
${readFileSafe(indexJsPath)}\`\`\`
`;

    for (const chunk of splitForTelegram(combined)) await bot.sendMessage(chatId, chunk);
    return true;
  }

  if (sub === "publish") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, 'Usage: /dev publish <skill> "commit message"');
      return true;
    }
    const msgStart = trimmed.indexOf(name) + name.length;
    const commitMsg = trimmed.slice(msgStart).trim().replace(/^"|"$/g, "");

    try {
      await bot.sendMessage(chatId, `⏳ Publishing '${name}' to GitHub...`);
      ensureRepoReady();
      copyDraftToRepo(name);
      const res = commitAndPush(name, commitMsg);
      if (!res.didCommit) await bot.sendMessage(chatId, `✅ Repo already up-to-date for '${name}'. Nothing to commit.`);
      else await bot.sendMessage(chatId, `✅ Published '${name}' (commit ${res.commit}).`);
      await bot.sendMessage(chatId, `Ready to install: /install ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Publish failed: ${err?.message || String(err)}`);
    }
    return true;
  }

  if (sub === "make" || sub === "revise") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, `Usage: /dev ${sub} <skill> <request...>`);
      return true;
    }

    const request = parts.slice(3).join(" ").trim();
    if (!request) {
      await bot.sendMessage(chatId, `Usage: /dev ${sub} ${name} <request...>`);
      return true;
    }

    const { draftDir, skillJsonPath, indexJsPath, pendingPath } = draftPaths(name);
    ensureDir(draftDir);

    const existing =
      fs.existsSync(skillJsonPath) && fs.existsSync(indexJsPath)
        ? { skillJson: readFileSafe(skillJsonPath), indexJs: readFileSafe(indexJsPath) }
        : null;

    try {
      await bot.sendMessage(chatId, `🧠 ${sub === "make" ? "Building" : "Revising"} '${name}'...`);

      const gen = await generateSkillFromSpec({ skillName: name, request, existing });

      writeFileSafe(skillJsonPath, JSON.stringify(gen.skillJson, null, 2) + "\n");
      writeFileSafe(indexJsPath, gen.indexJs.endsWith("\n") ? gen.indexJs : gen.indexJs + "\n");

      if (Array.isArray(gen.questions) && gen.questions.length > 0) {
        savePending(pendingPath, { skillName: name, lastRequest: request, questions: gen.questions });

        await bot.sendMessage(
          chatId,
          `⚠️ I can ship this now, but I have ${gen.questions.length} blocker question(s):\n` +
            gen.questions.map((q, i) => `${i + 1}) ${q}`).join("\n") +
            `\n\nReply with:\n/dev answer ${name} <your answers>`
        );
        await bot.sendMessage(chatId, `Draft ready for review: /dev show ${name}`);
        return true;
      }

      await bot.sendMessage(chatId, `✅ Draft ready. ⏳ Publishing '${name}' to GitHub...`);
      ensureRepoReady();
      copyDraftToRepo(name);
      const res = commitAndPush(name, `${sub}: ${name}`);

      if (!res.didCommit) await bot.sendMessage(chatId, `✅ Repo already up-to-date for '${name}'. Nothing to commit.`);
      else await bot.sendMessage(chatId, `✅ Published '${name}' (commit ${res.commit}).`);

      await bot.sendMessage(chatId, `Done. Install when ready: /install ${name}\nOr review: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ ${sub} failed: ${err?.message || String(err)}`);
    }

    return true;
  }

  if (sub === "answer") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev answer <skill> <answers...>");
      return true;
    }

    const answers = parts.slice(3).join(" ").trim();
    if (!answers) {
      await bot.sendMessage(chatId, `Usage: /dev answer ${name} <answers...>`);
      return true;
    }

    const { skillJsonPath, indexJsPath, pendingPath } = draftPaths(name);
    const pending = loadPending(pendingPath);

    if (!pending) {
      await bot.sendMessage(chatId, `No pending questions for '${name}'. Use: /dev make ${name} <request>`);
      return true;
    }

    const existing =
      fs.existsSync(skillJsonPath) && fs.existsSync(indexJsPath)
        ? { skillJson: readFileSafe(skillJsonPath), indexJs: readFileSafe(indexJsPath) }
        : null;

    const combinedRequest =
      `${pending.lastRequest}\n\nUser answers:\n${answers}\n\n(Proceed with best defaults; no more questions unless truly blocked.)`;

    try {
      await bot.sendMessage(chatId, `🧠 Applying answers and finishing '${name}'...`);

      const gen = await generateSkillFromSpec({ skillName: name, request: combinedRequest, existing });

      writeFileSafe(skillJsonPath, JSON.stringify(gen.skillJson, null, 2) + "\n");
      writeFileSafe(indexJsPath, gen.indexJs.endsWith("\n") ? gen.indexJs : gen.indexJs + "\n");
      clearPending(pendingPath);

      await bot.sendMessage(chatId, `✅ Updated draft. ⏳ Publishing '${name}' to GitHub...`);
      ensureRepoReady();
      copyDraftToRepo(name);
      const res = commitAndPush(name, `answer: ${name}`);

      if (!res.didCommit) await bot.sendMessage(chatId, `✅ Repo already up-to-date for '${name}'. Nothing to commit.`);
      else await bot.sendMessage(chatId, `✅ Published '${name}' (commit ${res.commit}).`);

      await bot.sendMessage(chatId, `Done. Install when ready: /install ${name}\nOr review: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ answer failed: ${err?.message || String(err)}`);
    }

    return true;
  }

  await bot.sendMessage(chatId, "Unknown subcommand. Send /dev for help.");
  return true;
}
