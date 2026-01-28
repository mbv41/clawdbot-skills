import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

const DRAFT_ROOT = path.join(os.homedir(), "clawdbot", "clawdbot_data", "skill_drafts");
const REPO_WORKDIR = path.join(os.homedir(), "clawdbot", "clawdbot_data", "skills_repo");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function safeName(name) {
  if (!name) return null;
  const n = name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(n)) return null;
  return n;
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

function draftPaths(skillName) {
  const draftDir = path.join(DRAFT_ROOT, skillName);
  return {
    draftDir,
    skillJsonPath: path.join(draftDir, "skill.json"),
    indexJsPath: path.join(draftDir, "index.js"),
    pendingPath: path.join(draftDir, ".pending.json"),
  };
}

/* ✅ NEW: copy skill from GitHub repo into drafts */
function copyRepoToDraft(skillName) {
  const { draftDir, skillJsonPath, indexJsPath } = draftPaths(skillName);

  const repoDir = path.join(REPO_WORKDIR, "skills", skillName);
  const repoSkillJson = path.join(repoDir, "skill.json");
  const repoIndexJs = path.join(repoDir, "index.js");

  if (!fs.existsSync(repoSkillJson) || !fs.existsSync(repoIndexJs)) {
    throw new Error(`Skill not found in repo: skills/${skillName}`);
  }

  ensureDir(draftDir);
  writeFileSafe(skillJsonPath, readFileSafe(repoSkillJson));
  writeFileSafe(indexJsPath, readFileSafe(repoIndexJs));
}

function copyDraftToRepo(skillName) {
  const { skillJsonPath, indexJsPath } = draftPaths(skillName);

  if (!fs.existsSync(skillJsonPath) || !fs.existsSync(indexJsPath)) {
    throw new Error(`Draft '${skillName}' missing skill.json or index.js.`);
  }

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

async function generateSkillFromSpec({ skillName, request, existing }) {
  const system =
    "You are Clawdbot Dev. The user provides simple language describing what they want. " +
    "Default behavior: assume reasonable defaults and implement a working skill. " +
    "Only ask questions if missing information is a true blocker. Ask at most 2 short questions. " +
    "Output ONLY JSON with keys: skillJson, indexJs, and optionally questions.";

  const user = [
    `Skill name: ${skillName}`,
    `User request: ${request}`,
    existing
      ? `Existing skill.json:\n${existing.skillJson}\n\nExisting index.js:\n${existing.indexJs}`
      : "No existing code.",
  ].join("\n");

  const out = await callClaude({ system, user });
  const parsed = extractJsonBlock(out);

  if (!parsed.skillJson || typeof parsed.indexJs !== "string") {
    throw new Error("Claude output missing skillJson or indexJs");
  }

  if (!Array.isArray(parsed.skillJson.commands)) parsed.skillJson.commands = [];
  const cmd = `/${skillName}`;
  if (!parsed.skillJson.commands.includes(cmd)) parsed.skillJson.commands.unshift(cmd);

  parsed.skillJson.name = skillName;
  parsed.skillJson.entry = "index.js";
  if (!parsed.skillJson.version) parsed.skillJson.version = "0.1.0";

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
  const sub = parts[1];

  if (!sub) {
    await bot.sendMessage(chatId,
      "Dev commands:\n" +
      "- /dev make <skill> <request>\n" +
      "- /dev revise <skill> <changes>\n" +
      "- /dev pull <skill>\n" +
      "- /dev show <skill>\n" +
      "- /dev publish <skill>\n" +
      "- /dev list\n"
    );
    return true;
  }

  if (sub === "pull") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev pull <skillname>");
      return true;
    }
    try {
      await bot.sendMessage(chatId, `⏳ Pulling '${name}' from GitHub...`);
      ensureRepoReady();
      copyRepoToDraft(name);
      await bot.sendMessage(chatId, `✅ Pulled. Review with: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Pull failed: ${err.message}`);
    }
    return true;
  }

  /* existing make / revise / show / publish / answer logic remains unchanged */

  await bot.sendMessage(chatId, "Unknown subcommand. Send /dev for help.");
  return true;
}
