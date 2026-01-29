import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Dev skill provides:
 * - /dev make|revise ... (LLM generates a skill, drafts saved, auto-publish)
 * - /dev show/list/rm/pull/publish
 * - /dev edit <path> <instruction...> (safe file editing within allowed roots)
 *
 * Requires env vars:
 * - ANTHROPIC_API_KEY
 * - GITHUB_SKILLS_REPO_URL   (https URL to your skills repo)
 * - GITHUB_TOKEN            (token with repo write access)
 * Optional:
 * - ANTHROPIC_MODEL         (default claude-opus-4-5-20251101)
 * - GITHUB_SKILLS_BRANCH    (default main)
 */

const HOME = os.homedir();
const DRAFT_ROOT = path.join(HOME, "clawdbot", "clawdbot_data", "skill_drafts");
const REPO_WORKDIR = path.join(HOME, "clawdbot", "clawdbot_data", "skills_repo");

// ===== helpers =====
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

function draftPaths(skillName) {
  const draftDir = path.join(DRAFT_ROOT, skillName);
  return {
    draftDir,
    skillJsonPath: path.join(draftDir, "skill.json"),
    indexJsPath: path.join(draftDir, "index.js"),
    pendingPath: path.join(draftDir, ".pending.json"),
  };
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

function copyRepoSkillToDraft(skillName) {
  const repoSkillDir = path.join(REPO_WORKDIR, "skills", skillName);
  if (!fs.existsSync(repoSkillDir)) {
    throw new Error(`Skill not found in repo: skills/${skillName}`);
  }

  const srcSkillJson = path.join(repoSkillDir, "skill.json");
  const srcIndex = path.join(repoSkillDir, "index.js");

  if (!fs.existsSync(srcSkillJson) || !fs.existsSync(srcIndex)) {
    throw new Error(`Repo skill '${skillName}' missing skill.json or index.js`);
  }

  // validate JSON
  JSON.parse(readFileSafe(srcSkillJson));

  const { draftDir, skillJsonPath, indexJsPath } = draftPaths(skillName);
  ensureDir(draftDir);

  writeFileSafe(skillJsonPath, readFileSafe(srcSkillJson));
  writeFileSafe(indexJsPath, readFileSafe(srcIndex));
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

// ===== Anthropic call =====
async function callClaude({ system, user }) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-5-20251101";

  const client = new Anthropic({ apiKey });

  const resp = await client.messages.create({
    model,
    max_tokens: 4200,
    system,
    messages: [{ role: "user", content: user }],
  });

  return (resp.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
}

// ===== /dev make output parsing =====
// Expected format:
// ```skilljson
// { ... valid JSON ... }
// ```
// ```js
// ... full index.js ...
// ```
// optional:
// ```questions
// ["...", "..."]
// ```
function extractMakeBlocks(text) {
  const skillJsonMatch = text.match(/```skilljson\s*([\s\S]*?)(?:\s*```|$)/i);
  const jsMatch = text.match(/```(?:js|javascript)\s*([\s\S]*?)(?:\s*```|$)/i);

  if (!skillJsonMatch || !jsMatch) {
    const preview = (text || "").slice(0, 900);
    throw new Error("Model output missing ```skilljson``` or ```js``` block. Preview:\n" + preview);
  }

  const skillJsonRaw = skillJsonMatch[1].trim();
  const indexJs = jsMatch[1].replace(/\r\n/g, "\n");

  let skillJson;
  try {
    skillJson = JSON.parse(skillJsonRaw);
  } catch {
    const preview = skillJsonRaw.slice(0, 900);
    throw new Error("```skilljson``` was not valid JSON. Preview:\n" + preview);
  }

  const qMatch = text.match(/```questions\s*([\s\S]*?)(?:\s*```|$)/i);
  let questions = null;
  if (qMatch) {
    try {
      const parsed = JSON.parse(qMatch[1].trim());
      if (Array.isArray(parsed)) questions = parsed.slice(0, 2);
    } catch {}
  }

  return { skillJson, indexJs, questions };
}

// ✅ ask blocker questions, otherwise ship
async function generateSkillFromSpec({ skillName, request, existing }) {
  const system =
    "You are Clawdbot Dev.\n" +
    "The user provides simple language describing what they want.\n" +
    "Default: assume reasonable defaults and implement a working skill.\n" +
    "Only ask questions if missing information is a true blocker. Ask at most 2 short, direct questions.\n" +
    "OUTPUT FORMAT: (no extra commentary)\n" +
    "1) ```skilljson containing ONLY valid JSON for skill.json\n" +
    "2) ```js containing the full index.js\n" +
    "3) OPTIONAL: ```questions containing a JSON array of strings (blocker questions)\n" +
    "Skill requirements:\n" +
    "- Must export: export async function run({ bot, chatId, text }) { ... return true/false }\n" +
    "- Must include /help behavior.\n" +
    "- Keep code minimal & robust.\n" +
    "- Do not use filesystem/network unless explicitly requested.\n" +
    "- If external integration requested (Outlook/Gmail), include an /auth subcommand and list required env vars in comments.";

  const user = [
    `Skill name: ${skillName}`,
    `User request: ${request}`,
    existing
      ? `Existing skill.json:\n${existing.skillJson}\n\nExisting index.js:\n${existing.indexJs}`
      : "No existing code.",
    "",
    "Remember: output ONLY the specified fenced blocks.",
  ].join("\n");

  const out = await callClaude({ system, user });
  const parsed = extractMakeBlocks(out);

  // normalize manifest
  if (!Array.isArray(parsed.skillJson.commands)) parsed.skillJson.commands = [];
  const cmd = `/${skillName}`;
  if (!parsed.skillJson.commands.includes(cmd)) parsed.skillJson.commands.unshift(cmd);

  parsed.skillJson.name = skillName;
  parsed.skillJson.entry = "index.js";
  if (!parsed.skillJson.version) parsed.skillJson.version = "0.1.0";

  return parsed;
}

// ===== /dev edit (safe file editing) =====
const ALLOWED_ROOTS = [path.join(HOME, "clawdbot"), path.join(HOME, "clawdbot_data")];

function resolveSafeTarget(userPath) {
  if (!userPath) return null;

  // Allow relative paths relative to ~/clawdbot
  const raw = userPath.trim();
  const base = path.join(HOME, "clawdbot");
  const abs = raw.startsWith("/") ? raw : path.join(base, raw);

  let realParent;
  try {
    const parent = fs.existsSync(abs) ? abs : path.dirname(abs);
    realParent = fs.realpathSync(parent);
  } catch {
    realParent = path.resolve(abs);
  }

  const ok = ALLOWED_ROOTS.some((r) => {
    const rr = fs.existsSync(r) ? fs.realpathSync(r) : path.resolve(r);
    return realParent === rr || realParent.startsWith(rr + path.sep);
  });

  if (!ok) return null;
  return path.resolve(abs);
}

function backupPathFor(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(filePath);
  const dir = path.dirname(filePath);
  return path.join(dir, `.bak.${base}.${ts}`);
}

function writeFileAtomicWithBackup(filePath, content) {
  ensureDir(path.dirname(filePath));

  if (fs.existsSync(filePath)) {
    const bak = backupPathFor(filePath);
    fs.copyFileSync(filePath, bak);
  }

  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function maybeSyntaxCheck(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    execSync(`node -c "${filePath.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
  }
}

function maybeRestartPm2(filePath) {
  const name = path.basename(filePath);
  if (name === "telegram-claude.js") {
    try {
      execSync("pm2 restart clawdbot --update-env", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// Multi-part sentinel-based extraction (handles long files reliably)
async function callClaudeFileEdit({ filePath, oldContent, instruction }) {
  const system =
    "You are a careful software engineer.\n" +
    "Update the given file to satisfy the instruction.\n" +
    "Preserve existing behavior unless required; keep changes minimal.\n" +
    "\n" +
    "CRITICAL OUTPUT RULE:\n" +
    "You MUST return the full updated file content using ONE of these formats:\n" +
    "\n" +
    "FORMAT A (single part):\n" +
    "BEGIN_FILE\n" +
    "<full file content>\n" +
    "END_FILE\n" +
    "\n" +
    "FORMAT B (multi-part for long files):\n" +
    "BEGIN_FILE_PART i/N\n" +
    "<this part's content>\n" +
    "END_FILE_PART\n" +
    "(repeat for all parts, in order, i from 1 to N)\n" +
    "\n" +
    "No markdown. No code fences. No explanations. No extra text.\n" +
    "If you cannot comply, output exactly: FAIL";

  const baseUser = [
    `File path: ${filePath}`,
    `Instruction: ${instruction}`,
    "",
    "CURRENT FILE:",
    "-----BEGIN_CURRENT-----",
    oldContent,
    "-----END_CURRENT-----",
    "",
    "Remember: output ONLY the markers and the file content (or FAIL).",
  ].join("\n");

  function norm(outText) {
    return (outText || "").replace(/\r\n/g, "\n").trim();
  }

  function extractSingle(outText) {
    const t = norm(outText);
    if (t === "FAIL") return null;
    const m = t.match(/BEGIN_FILE\s*\n([\s\S]*?)\nEND_FILE\s*$/);
    if (!m) return null;
    return { mode: "single", content: m[1] };
  }

  function extractParts(outText) {
    const t = norm(outText);
    if (t === "FAIL") return null;

    const re = /BEGIN_FILE_PART\s+(\d+)\/(\d+)\s*\n([\s\S]*?)\nEND_FILE_PART/g;
    const parts = [];
    let m;
    while ((m = re.exec(t)) !== null) {
      parts.push({
        i: Number(m[1]),
        n: Number(m[2]),
        content: m[3],
      });
    }
    if (parts.length === 0) return null;

    const n = parts[0].n;
    if (!n || parts.some((p) => p.n !== n)) return null;

    const byI = new Map();
    for (const p of parts) byI.set(p.i, p.content);

    return { mode: "parts", n, byI };
  }

  function preview(outText) {
    return norm(outText).slice(0, 420).replace(/\n/g, "\\n");
  }

  const clientAttempts = 6;

  let out = await callClaude({ system, user: baseUser });

  const single = extractSingle(out);
  if (single) {
    const c = single.content;
    return c.endsWith("\n") ? c : c + "\n";
  }

  let partsState = extractParts(out);
  if (!partsState) {
    out = await callClaude({
      system: system + "\n\nYOU MUST COMPLY. Output ONLY markers and file content.",
      user:
        baseUser +
        "\n\nSECOND ATTEMPT: If the file is long, use BEGIN_FILE_PART i/N blocks. No extra text.",
    });

    const single2 = extractSingle(out);
    if (single2) {
      const c = single2.content;
      return c.endsWith("\n") ? c : c + "\n";
    }

    partsState = extractParts(out);
  }

  if (!partsState) {
    throw new Error("Model did not return BEGIN_FILE/END_FILE content. Preview: " + preview(out));
  }

  const n = partsState.n;
  const byI = partsState.byI;

  for (let attempt = 0; attempt < clientAttempts; attempt++) {
    if (byI.size >= n) break;

    const missing = [];
    for (let i = 1; i <= n; i++) if (!byI.has(i)) missing.push(i);

    const ask =
      baseUser +
      "\n\nYou previously returned a multi-part file.\n" +
      `Total parts: ${n}\n` +
      `Missing parts: ${missing.join(", ")}\n\n` +
      "Return ONLY the missing parts using EXACTLY this format (no extra text):\n" +
      "BEGIN_FILE_PART i/N\n" +
      "<content>\n" +
      "END_FILE_PART\n" +
      "(repeat for each missing part)\n";

    out = await callClaude({ system, user: ask });

    const got = extractParts(out);
    if (!got || got.n !== n) {
      const s = extractSingle(out);
      if (s) {
        const c = s.content;
        return c.endsWith("\n") ? c : c + "\n";
      }
      continue;
    }

    for (const [i, c] of got.byI.entries()) byI.set(i, c);
  }

  if (byI.size < n) {
    const missing = [];
    for (let i = 1; i <= n; i++) if (!byI.has(i)) missing.push(i);
    throw new Error(
      `Model returned multi-part file but missing parts: ${missing.join(", ")}. Last preview: ${preview(out)}`
    );
  }

  let content = "";
  for (let i = 1; i <= n; i++) content += byI.get(i);

  return content.endsWith("\n") ? content : content + "\n";
}

// ===== command handler =====
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
        "- /dev make <skillname> <what you want in plain English>",
        "- /dev revise <skillname> <changes in plain English>",
        "- /dev answer <skillname> <your answers...>",
        "- /dev pull <skillname>",
        "- /dev show <skillname>",
        '- /dev publish <skillname> "commit msg"',
        "- /dev edit <path> <instruction...>   (allowed: ~/clawdbot, ~/clawdbot_data)",
        "- /dev list",
        "- /dev rm <skillname>",
      ].join("\n")
    );
    return true;
  }

  const sub = parts[1];

  if (sub === "list") {
    const names = listDirs(DRAFT_ROOT);
    await bot.sendMessage(
      chatId,
      names.length ? "Drafted skills:\n" + names.map((n) => `- ${n}`).join("\n") : "No drafted skills yet. Use: /dev make <skillname> <request>"
    );
    return true;
  }

  if (sub === "rm") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev rm <skillname>");
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

  if (sub === "show") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev show <skillname>");
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

  if (sub === "pull") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev pull <skillname>");
      return true;
    }

    try {
      await bot.sendMessage(chatId, `⏳ Pulling '${name}' from GitHub...`);
      ensureRepoReady();
      copyRepoSkillToDraft(name);
      await bot.sendMessage(chatId, `✅ Pulled. Review with: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Pull failed: ${err?.message || String(err)}`);
    }
    return true;
  }

  if (sub === "publish") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, 'Usage: /dev publish <skillname> "commit message"');
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
      else await bot.sendMessage(chatId, `✅ Published '${name}' to GitHub (commit ${res.commit}).`);
      await bot.sendMessage(chatId, `Ready to install: /install ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Publish failed: ${err?.message || String(err)}`);
    }
    return true;
  }

  // /dev edit <path> <instruction...>
  if (sub === "edit") {
    const targetArg = parts[2];
    const instruction = trimmed.split(/\s+/).slice(3).join(" ").trim();

    if (!targetArg || !instruction) {
      await bot.sendMessage(
        chatId,
        "Usage: /dev edit <path> <what to change...>\nExample: /dev edit telegram-claude.js Add /requests command"
      );
      return true;
    }

    const targetPath = resolveSafeTarget(targetArg);
    if (!targetPath) {
      await bot.sendMessage(
        chatId,
        "⚠️ That path is not allowed.\nAllowed roots:\n- ~/clawdbot/\n- ~/clawdbot_data/\nTip: use relative paths like: telegram-claude.js or src/core/commands.js"
      );
      return true;
    }

    if (!fs.existsSync(targetPath)) {
      await bot.sendMessage(chatId, `⚠️ File not found: ${targetPath}`);
      return true;
    }

    try {
      await bot.sendMessage(chatId, `🛠️ Editing:\n${targetPath}\n\nInstruction: ${instruction}`);

      const oldContent = readFileSafe(targetPath);
      const newContent = await callClaudeFileEdit({ filePath: targetPath, oldContent, instruction });

      writeFileAtomicWithBackup(targetPath, newContent);

      try {
        maybeSyntaxCheck(targetPath);
      } catch (e) {
        await bot.sendMessage(chatId, `⚠️ Wrote file but syntax check failed. A backup was saved.\nError: ${e?.message || e}`);
        return true;
      }

      const restarted = maybeRestartPm2(targetPath);
      await bot.sendMessage(chatId, `✅ Updated file saved.${restarted ? " (pm2 restarted clawdbot)" : ""}\nBackup created automatically in the same folder.`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ edit failed: ${err?.message || String(err)}`);
    }

    return true;
  }

  // /dev make or /dev revise
  if (sub === "make" || sub === "revise") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, `Usage: /dev ${sub} <skillname> <request...>`);
      return true;
    }

    const request = trimmed.split(/\s+/).slice(3).join(" ").trim();
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

      // blocker questions
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

      // auto-publish
      await bot.sendMessage(chatId, `✅ Draft ready. ⏳ Publishing '${name}' to GitHub...`);
      ensureRepoReady();
      copyDraftToRepo(name);
      const res = commitAndPush(name, `${sub}: ${name}`);

      if (!res.didCommit) await bot.sendMessage(chatId, `✅ Repo already up-to-date for '${name}'. Nothing to commit.`);
      else await bot.sendMessage(chatId, `✅ Published '${name}' to GitHub (commit ${res.commit}).`);

      await bot.sendMessage(chatId, `Done. Install when ready: /install ${name}\nOr review: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ ${sub} failed: ${err?.message || String(err)}`);
    }

    return true;
  }

  // /dev answer <skill> <answers...>
  if (sub === "answer") {
    const name = safeName(parts[2]);
    if (!name) {
      await bot.sendMessage(chatId, "Usage: /dev answer <skillname> <answers...>");
      return true;
    }

    const answers = trimmed.split(/\s+/).slice(3).join(" ").trim();
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
      else await bot.sendMessage(chatId, `✅ Published '${name}' to GitHub (commit ${res.commit}).`);

      await bot.sendMessage(chatId, `Done. Install when ready: /install ${name}\nOr review: /dev show ${name}`);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ answer failed: ${err?.message || String(err)}`);
    }

    return true;
  }

  await bot.sendMessage(chatId, "Unknown subcommand. Send /dev for help.");
  return true;
}
