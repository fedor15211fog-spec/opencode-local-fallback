/**
 * limit-fallback
 *
 * Когда у облачной модели заканчивается дневной/месячный лимит (QuotaExceeded,
 * 429, "usage limit reached", "rate limit" ...), плагин НЕ переключает модель
 * сам. Он только пишет в сессию уведомление: "лимит кончился, нажми /local".
 *
 * Переключение — вручную, по кнопке:
 *   - команда /local в палитре команд (Ctrl+P) или как слэш-команда;
 *   - после нажатия сессия переключается на локальную Qwen2.5 Coder
 *     (LM Studio / Bionic) и ей отправляется "продолжай с того места".
 *
 * Локальная модель работает в OpenCode, а не в Bionic, поэтому у неё есть
 * файловые инструменты. Плагин поднимает локальный OpenAI-совместимый шим,
 * который превращает текстовые tool-call'ы Qwen в настоящие OpenAI
 * tool_calls: без этого Qwen2.5-Coder в LM Studio не умеет вызывать
 * инструменты.
 *
 * Провайдер localqwen (http://127.0.0.1:1236/v1) прописан в opencode.json.
 */

import { Plugin } from "@opencode/plugin"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

const DEFAULT_CONTINUATION =
  "[local fallback] The main model hit its usage limit. You are now running on the local Qwen2.5 Coder. " +
  "Continue the task from exactly where it stopped. Do not restart, do not redo finished steps, and do not repeat " +
  "the previous answer. Check the current state (files, diffs, tests) if needed and keep going until the task is done."

const limitNotice = (model: string) =>
  `Usage limit reached on ${model}. Automatic switching is disabled. ` +
  `Run /local (or open the command palette and pick "Continue on local Qwen") to switch this session to the local ` +
  `Qwen2.5 Coder and continue from where it stopped.`

type Options = {
  providerID: string
  modelID: string
  shimPort: number
  upstream: string
  upstreamModel: string
  maxTokens: number
  jsonMode: boolean
  continuation: string
  logFile: string
}

function readOptions(ctx: any): Options {
  const o = (ctx?.options ?? {}) as Record<string, any>
  const env = process.env
  return {
    providerID: String(o.provider ?? env.OPENCODE_FALLBACK_PROVIDER ?? "localqwen"),
    modelID: String(o.model ?? env.OPENCODE_FALLBACK_MODEL ?? "qwen2.5-coder-7b-instruct"),
    shimPort: Number(o.port ?? env.OPENCODE_FALLBACK_PORT ?? 1236),
    upstream: String(o.upstream ?? env.OPENCODE_FALLBACK_UPSTREAM ?? ""),
    upstreamModel: String(
      o.upstreamModel ?? env.OPENCODE_FALLBACK_UPSTREAM_MODEL ?? "qwen2.5-coder-7b-instruct",
    ),
    maxTokens: Number(o.maxTokens ?? env.OPENCODE_FALLBACK_MAX_TOKENS ?? 4096),
    jsonMode: String(o.jsonMode ?? env.OPENCODE_FALLBACK_JSON_MODE ?? "0") !== "0",
    continuation: String(o.continuation ?? env.OPENCODE_FALLBACK_CONTINUATION ?? DEFAULT_CONTINUATION),
    logFile: String(
      o.logFile ??
        env.OPENCODE_FALLBACK_LOG ??
        join(env.USERPROFILE ?? env.HOME ?? ".", ".local", "share", "opencode", "limit-fallback.log"),
    ),
  }
}

// ---------------------------------------------------------------------------
// Настройки локальной модели (сохраняются в JSON и правятся через веб-UI)
// ---------------------------------------------------------------------------

type StoredSettings = {
  upstream?: string
  upstreamModel?: string
  maxTokens?: number
  jsonMode?: boolean
}

function settingsFile(opts: Options): string {
  return join(dirname(opts.logFile), "limit-fallback.json")
}

function readSettings(opts: Options): StoredSettings {
  try {
    const raw = readFileSync(settingsFile(opts), "utf8")
    const value = JSON.parse(raw)
    return value && typeof value === "object" ? (value as StoredSettings) : {}
  } catch {
    return {}
  }
}

function writeSettings(opts: Options, values: StoredSettings): StoredSettings {
  const next: StoredSettings = {}
  if (typeof values.upstream === "string" && values.upstream.trim()) next.upstream = values.upstream.trim()
  if (typeof values.upstreamModel === "string" && values.upstreamModel.trim())
    next.upstreamModel = values.upstreamModel.trim()
  const maxTokens = Number(values.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) next.maxTokens = Math.min(Math.floor(maxTokens), 32768)
  if (typeof values.jsonMode === "boolean") next.jsonMode = values.jsonMode
  mkdirSync(dirname(settingsFile(opts)), { recursive: true })
  writeFileSync(settingsFile(opts), JSON.stringify(next, null, 2), "utf8")
  return next
}

function applySettings(opts: Options, values: StoredSettings) {
  if (typeof values.upstream === "string" && values.upstream.trim()) opts.upstream = values.upstream.trim()
  if (typeof values.upstreamModel === "string" && values.upstreamModel.trim())
    opts.upstreamModel = values.upstreamModel.trim()
  const maxTokens = Number(values.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) opts.maxTokens = Math.min(Math.floor(maxTokens), 32768)
  if (typeof values.jsonMode === "boolean") opts.jsonMode = values.jsonMode
}

function currentSettings(opts: Options) {
  return {
    upstream: opts.upstream,
    upstreamModel: opts.upstreamModel,
    maxTokens: opts.maxTokens,
    jsonMode: opts.jsonMode,
    shimURL: `http://127.0.0.1:${opts.shimPort}/v1`,
    providerID: opts.providerID,
    modelID: opts.modelID,
    settingsFile: settingsFile(opts),
  }
}

function settingsPage(opts: Options): string {
  const data = JSON.stringify(currentSettings(opts)).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local fallback — настройки</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; background: #141414; color: #e8e8e8; }
  main { max-width: 620px; margin: 40px auto; padding: 0 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: #9a9a9a; margin: 0 0 28px; }
  fieldset { border: 1px solid #2f2f2f; border-radius: 10px; padding: 18px; margin: 0 0 18px; }
  legend { padding: 0 8px; color: #b9b9b9; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; }
  label { display: block; margin: 0 0 14px; }
  label span { display: block; margin-bottom: 6px; color: #cfcfcf; }
  input[type=text], input[type=number] {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #3a3a3a;
    background: #1d1d1d; color: #fff; font: inherit; outline: none;
  }
  input:focus { border-color: #ff9500; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  button {
    padding: 10px 16px; border-radius: 8px; border: 0; font: inherit; font-weight: 600;
    cursor: pointer; background: #ff9500; color: #1a1a1a;
  }
  button.ghost { background: #2c2c2c; color: #e8e8e8; }
  button:disabled { opacity: .5; cursor: default; }
  code { background: #1d1d1d; padding: 2px 6px; border-radius: 5px; }
  .hint { color: #8a8a8a; font-size: 13px; margin-top: 6px; }
  .status { margin-top: 16px; padding: 12px 14px; border-radius: 8px; background: #1d1d1d; border: 1px solid #2f2f2f; white-space: pre-wrap; }
  .ok { color: #6ee7a8; }
  .err { color: #ff7a7a; }
</style>
</head>
<body>
<main>
  <h1>Local fallback</h1>
  <p class="sub">Куда плагин ходит за локальной моделью. Изменения применяются сразу, перезапуск не нужен.</p>

  <form id="form">
    <fieldset>
      <legend>Локальный сервер</legend>
      <label><span>Путь / URL до локального сервера</span>
        <input type="text" name="upstream" id="upstream" placeholder="http://127.0.0.1:1235/v1" spellcheck="false">
        <div class="hint">LM Studio: <code>http://127.0.0.1:1235/v1</code>, Ollama: <code>http://127.0.0.1:11434/v1</code>, llama.cpp: <code>http://127.0.0.1:8080/v1</code>. Пусто — автопоиск портов.</div>
      </label>
      <label><span>Имя модели</span>
        <input type="text" name="upstreamModel" id="upstreamModel" placeholder="qwen2.5-coder-7b-instruct" spellcheck="false">
      </label>
    </fieldset>

    <fieldset>
      <legend>Ограничения</legend>
      <label><span>Максимум токенов ответа</span>
        <input type="number" name="maxTokens" id="maxTokens" min="128" max="32768" step="128">
      </label>
      <label style="display:flex;align-items:center;gap:10px;margin:0">
        <input type="checkbox" name="jsonMode" id="jsonMode" style="width:auto">
        <span style="margin:0">JSON-режим (response_format). Для Qwen2.5-Coder лучше выключен.</span>
      </label>
    </fieldset>

    <div class="row">
      <button type="submit" id="save">Сохранить</button>
      <button type="button" class="ghost" id="test">Проверить подключение</button>
      <button type="button" class="ghost" id="open">Открыть /v1</button>
    </div>
    <div class="status" id="status"></div>
  </form>
</main>
<script>
  const initial = ${data};
  const form = document.getElementById("form");
  const status = document.getElementById("status");
  const setStatus = (text, cls) => { status.className = "status " + (cls || ""); status.textContent = text; };

  document.getElementById("upstream").value = initial.upstream || "";
  document.getElementById("upstreamModel").value = initial.upstreamModel || "";
  document.getElementById("maxTokens").value = initial.maxTokens || 4096;
  document.getElementById("jsonMode").checked = !!initial.jsonMode;
  setStatus("Шим: " + initial.shimURL + "\\nПровайдер: " + initial.providerID + "/" + initial.modelID + "\\nФайл настроек: " + initial.settingsFile);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("save");
    button.disabled = true;
    try {
      const body = {
        upstream: document.getElementById("upstream").value.trim(),
        upstreamModel: document.getElementById("upstreamModel").value.trim(),
        maxTokens: Number(document.getElementById("maxTokens").value),
        jsonMode: document.getElementById("jsonMode").checked,
      };
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || "save failed");
      setStatus("Сохранено.\\n" + JSON.stringify(result.settings, null, 2), "ok");
    } catch (error) {
      setStatus("Ошибка: " + error.message, "err");
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("test").addEventListener("click", async () => {
    setStatus("Проверяю…");
    try {
      const response = await fetch("/api/test", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || "test failed");
      setStatus("Подключение OK.\\nМодели: " + (result.models || []).join(", "), "ok");
    } catch (error) {
      setStatus("Не достучался: " + error.message, "err");
    }
  });

  document.getElementById("open").addEventListener("click", () => {
    const url = (document.getElementById("upstream").value.trim() || initial.upstream || "").replace(/\\/v1\\/?$/, "");
    if (url) window.open(url, "_blank");
  });
</script>
</body>
</html>`
}

function makeLogger(file: string) {
  let warned = false
  return (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > 2_000_000) appendFileSync(file, "")
      } catch {}
      appendFileSync(file, line)
    } catch (error) {
      if (!warned) {
        warned = true
        console.error("[limit-fallback] cannot write log:", error)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Классификация ошибок лимита
// ---------------------------------------------------------------------------

const LIMIT_RE =
  /(free\s+usage\s+limit|usage\s+limit|rate[\s-]?limit|quota|too\s+many\s+requests|limit\s+(?:reached|exceeded)|insufficient\s+(?:credit|credits|funds|balance|quota)|daily\s+(?:limit|quota)|out\s+of\s+credits|billing|subscription|402|429)/i

const CONTEXT_RE =
  /(context\s+(?:window|length|limit)|maximum\s+context|prompt\s+is\s+too\s+long|input\s+is\s+too\s+long|too\s+many\s+tokens|token\s+limit|exceeds?\s+the\s+maximum)/i

function isLimitError(error: any): boolean {
  if (!error) return false
  const text = [error.type, error.name, error.message, error.response?.body]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("\n")
  if (CONTEXT_RE.test(text)) return false
  if (error.status === 429) return true
  if (LIMIT_RE.test(text)) return !CONTEXT_RE.test(text)
  return false
}

// ---------------------------------------------------------------------------
// Шим: OpenAI-совместимый фасад над LM Studio + текстовыми tool-call'ами Qwen
// ---------------------------------------------------------------------------

const ESSENTIAL_TOOLS = [
  "read",
  "write",
  "edit",
  "patch",
  "bash",
  "shell",
  "glob",
  "grep",
  "list",
  "ls",
  "todo",
  "todowrite",
]

// Qwen2.5-Coder не обучен tool-call'ам, поэтому имя инструмента в ответе может
// быть любым: "Read", "read_file", "run", "execute", "create_file"...
const SHELL_TOOL_RE = /^(bash|shell|sh|exec|execute|terminal|run|command|powershell|pwsh|cmd)$/i
const WRITE_TOOL_RE = /^(write|create|createfile|create_file|writefile|write_file|save|savefile)$/i
const READ_TOOL_RE = /^(read|cat|view|open|readfile|read_file|show)$/i
const EDIT_TOOL_RE = /^(edit|patch|replace|applypatch|apply_patch|strreplace|str_replace|update)$/i

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function toolNameOf(tool: any): string {
  return String(tool?.function?.name ?? tool?.name ?? "")
}

function toolSchemaOf(tool: any): any {
  return tool?.function?.parameters ?? tool?.parameters ?? {}
}

/** Приводит имя инструмента из ответа модели к реальному имени из запроса. */
function resolveToolName(raw: string, tools: any[]): string | null {
  const names = tools.map(toolNameOf).filter(Boolean)
  if (!names.length) return null
  if (names.includes(raw)) return raw

  const n = norm(raw)
  const exact = names.find((name) => norm(name) === n)
  if (exact) return exact

  const prefixed = names.find((name) => norm(name).startsWith(n) || n.startsWith(norm(name)))
  if (prefixed) return prefixed

  const kind = [SHELL_TOOL_RE, WRITE_TOOL_RE, READ_TOOL_RE, EDIT_TOOL_RE].find((re) => re.test(raw))
  if (kind) {
    const match = names.find((name) => kind.test(name))
    if (match) return match
  }
  return null
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max) + `\n...[truncated ${value.length - max} chars]`
}

function textOf(content: any): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (!part || typeof part !== "object") return ""
        if (part.type === "text" || part.type === "input_text") return part.text ?? ""
        if (part.type === "tool_result") return textOf(part.content)
        if (part.type === "image" || part.type === "file") return "[attachment omitted by local fallback]"
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (typeof content === "object") return JSON.stringify(content)
  return String(content)
}

function parseArguments(value: any): any {
  if (typeof value !== "string") return value ?? {}
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

// Группы синонимов аргументов: модель может прислать file_path вместо path и т.п.
const ARG_GROUPS: string[][] = [
  ["path", "filepath", "file", "filename", "target", "targetfile", "absolutepath", "dir", "directory", "uri", "location", "source"],
  ["content", "text", "data", "body", "contents", "newcontent", "value", "code"],
  ["command", "cmd", "script", "shellcommand", "run", "exec", "line", "commands"],
  ["oldstring", "oldtext", "old", "search", "find", "before", "from"],
  ["newstring", "newtext", "replace", "replacement", "new", "after", "to"],
  ["pattern", "regex", "query", "glob", "search"],
  ["description", "desc", "title", "summary", "reason"],
  ["offset", "start", "begin", "line"],
  ["limit", "count", "max", "lines", "end"],
]

function argGroup(key: string): string[] | null {
  const n = norm(key)
  for (const group of ARG_GROUPS) {
    if (group.some((item) => norm(item) === n)) return group
  }
  return null
}

/** Подгоняет аргументы вызова под JSON-схему реального инструмента. */
function coerceArgs(tool: any, rawArgs: any): any {
  const schema = toolSchemaOf(tool)
  const props: Record<string, any> =
    schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {}
  const propNames = Object.keys(props)
  const required: string[] = Array.isArray(schema?.required) ? schema.required : []

  let input = typeof rawArgs === "string" ? parseArguments(rawArgs) : rawArgs
  if (input === null || input === undefined) input = {}
  if (typeof input !== "object" || Array.isArray(input)) {
    const target = required[0] ?? propNames[0]
    return target ? { [target]: input } : {}
  }
  if (propNames.length === 0) return input

  const out: Record<string, any> = {}
  const extras: [string, any][] = []

  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    const nk = norm(key)
    const exact = propNames.find((name) => norm(name) === nk)
    if (exact) {
      out[exact] = value
      continue
    }
    const group = argGroup(key)
    const byGroup = group
      ? propNames.find((name) => group.some((item) => norm(item) === norm(name)) && out[name] === undefined)
      : undefined
    if (byGroup) out[byGroup] = value
    else extras.push([key, value])
  }

  for (const [key, value] of extras) {
    const group = argGroup(key)
    const free = group
      ? propNames.find((name) => group.some((item) => norm(item) === norm(name)) && out[name] === undefined)
      : undefined
    if (free) out[free] = value
  }

  if (Object.keys(out).length === 0) return input

  const missing = required.filter((name) => out[name] === undefined)
  if (missing.length === 1) {
    const leftovers = Object.keys(out).filter((key) => !propNames.includes(key))
    if (leftovers.length === 1) {
      out[missing[0]] = out[leftovers[0]]
      delete out[leftovers[0]]
    }
  }
  return out
}

const SHELL_LANGS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "shell",
  "console",
  "terminal",
  "cmd",
  "bat",
  "batch",
  "powershell",
  "ps1",
  "pwsh",
  "shellsession",
])

type Fenced = { info: string; lang: string; body: string; start: number; end: number }

function fencedBlocks(text: string): Fenced[] {
  const blocks: Fenced[] = []
  const re = /```([^\n`]*)\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const info = String(match[1] ?? "").trim()
    const lang = (info.split(/[\s:=]+/)[0] ?? "").toLowerCase().replace(/^\./, "")
    blocks.push({ info, lang, body: match[2] ?? "", start: match.index, end: match.index + match[0].length })
  }
  return blocks
}

/** Ищет путь к файлу в строке-заголовке блока: ```ts path=src/a.ts / ```src/a.ts */
function pathFromInfo(info: string, lang: string): string | null {
  const tagged = info.match(/(?:path|file|filename)\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/i)
  if (tagged) return tagged[1].replace(/^["']|["']$/g, "")
  const tokens = info.split(/\s+/).slice(1)
  for (const token of tokens) {
    const clean = token.replace(/^["']|["']$/g, "")
    if (!clean || clean.toLowerCase() === lang) continue
    if (/[./\\]/.test(clean) || /\.\w{1,8}$/.test(clean)) return clean
  }
  return null
}

function cutRanges(text: string, ranges: { start: number; end: number }[]): string {
  if (!ranges.length) return text
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let out = ""
  let cursor = 0
  for (const range of sorted) {
    if (range.start < cursor) continue
    out += text.slice(cursor, range.start)
    cursor = range.end
  }
  return out + text.slice(cursor)
}

function toUpstreamMessages(body: any) {
  const systems: string[] = []
  const messages: { role: "user" | "assistant"; content: string }[] = []

  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue
    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message.content)
      if (text) systems.push(text)
      continue
    }

    if (message.role === "assistant") {
      let text = textOf(message.content)
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (calls.length > 0) {
        const blocks = calls
          .map((call: any) => {
            const name = call?.function?.name ?? call?.name ?? "unknown"
            const args = parseArguments(call?.function?.arguments ?? call?.arguments)
            return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`
          })
          .join("\n")
        text = [text, blocks].filter(Boolean).join("\n")
      }
      if (text) messages.push({ role: "assistant", content: text })
      continue
    }

    if (message.role === "tool") {
      const text = truncate(textOf(message.content), 12_000)
      messages.push({ role: "user", content: `<tool_response>\n${text}\n</tool_response>` })
      continue
    }

    const text = textOf(message.content)
    if (text) messages.push({ role: "user", content: text })
  }

  return { systems, messages }
}

function pickTools(tools: any[]): any[] {
  if (!tools.length) return []
  const filtered = tools.filter((tool) => ESSENTIAL_TOOLS.includes(norm(toolNameOf(tool))))
  return filtered.length > 0 ? filtered : tools
}

function describeTools(tools: any[]): string {
  return tools
    .map((tool) => {
      const fn = tool?.function ?? {}
      const schema = fn.parameters ?? {}
      const props = schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : []
      return JSON.stringify({
        name: fn.name,
        description: truncate(String(fn.description ?? ""), 200),
        required: Array.isArray(schema?.required) ? schema.required : props,
        properties: props,
      })
    })
    .join("\n")
}

function commandsInstruction(): string {
  return [
    "# Session instructions",
    "",
    "You are answering inside OpenCode through a local fallback model.",
    "This instruction always comes first; the user's message arrives after it.",
    "",
    "OpenCode commands the user can run (you cannot execute them yourself, only mention them when useful):",
    "- /local — switch this session to the local model and continue the current task.",
    "- /local-setup — show the local model settings page (server URL, model, limits).",
    "- /compact — compact the conversation manually.",
    "",
    "Your own capabilities are the tools listed below. To act, call a tool. Never pretend a command ran.",
    "Answer in the same language the user writes in (Russian for Russian messages).",
  ].join("\n")
}

function toolProtocol(tools: any[]): string {
  if (tools.length === 0) return ""
  const platform =
    process.platform === "win32"
      ? "- Environment: Windows. In shell commands use Windows syntax (dir, type, echo, copy) and Windows paths like C:\\Users\\..., never /c/... paths."
      : "- Environment: Unix. Use standard sh commands."
  const example = tools[0]
  const exampleName = toolNameOf(example)
  const exampleSchema = toolSchemaOf(example)
  const exampleProps = exampleSchema?.properties && typeof exampleSchema.properties === "object" ? Object.keys(exampleSchema.properties) : []
  const exampleArgs = Object.fromEntries(exampleProps.slice(0, 2).map((key) => [key, "<value>"] as [string, string]))
  return [
    "# Tools",
    "",
    "You are an autonomous coding agent working inside a repository. You act by calling tools.",
    "Available tools (JSON: name, description, required argument names, all argument names):",
    "<tools>",
    describeTools(tools),
    "</tools>",
    "",
    "## How to call a tool",
    "Output ONE line per call, in exactly this format, with valid JSON and double quotes:",
    '<tool_call>{"name": "<tool name>", "arguments": {<arguments>}}</tool_call>',
    "",
    `Example: <tool_call>${JSON.stringify({ name: exampleName, arguments: exampleArgs })}</tool_call>`,
    "",
    "## Hard rules",
    platform,
    "- NEVER print shell commands or file contents in ``` fenced blocks. That does nothing.",
    "- To run a command, call the shell tool. To read a file, call the read tool. To change a file, call the write or edit tool.",
    "- Use the exact argument names listed above for the tool.",
    "- After a tool call, stop and wait. Results arrive as <tool_response>...</tool_response>.",
    "- Do not invent tool output. Do not describe what you would do — do it.",
    "- When the task is fully done, reply with plain text and no <tool_call> block.",
  ].join("\n")
}

/** Компактная JSON-схема, чтобы модель отвечала только вызовами инструментов. */
function buildResponseFormat(tools: any[]): any | null {
  if (!tools.length) return null
  const shrink = (value: any): any => {
    if (Array.isArray(value)) return value.map(shrink)
    if (!value || typeof value !== "object") return value
    const out: Record<string, any> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === "description" || key === "examples" || key === "default" || key === "title") continue
      out[key] = shrink(item)
    }
    return out
  }
  const variants = tools.map((tool) => ({
    type: "object",
    properties: {
      message: { type: "string" },
      name: { const: toolNameOf(tool) },
      arguments: shrink(toolSchemaOf(tool) ?? { type: "object", properties: {} }),
    },
    required: ["name", "arguments", "message"],
    additionalProperties: false,
  }))
  return {
    type: "json_schema",
    json_schema: {
      name: "agent_tool_call",
      strict: false,
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          tool_calls: { type: "array", items: { anyOf: variants } },
        },
        required: ["message", "tool_calls"],
        additionalProperties: false,
      },
    },
  }
}

type Calls = { calls: any[]; content: string }

function jsonSpans(text: string): { start: number; end: number; raw: string; value: any }[] {
  const spans: { start: number; end: number; raw: string; value: any }[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < text.length; j++) {
      const char = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === "{") depth++
      else if (char === "}") {
        depth--
        if (depth === 0) {
          const raw = text.slice(i, j + 1)
          let value: any
          try {
            value = JSON.parse(raw)
          } catch {}
          if (value) spans.push({ start: i, end: j + 1, raw, value })
          i = j
          break
        }
      }
    }
  }
  return spans
}

function extractToolCalls(text: string, tools: any[]): Calls {
  const found: { tool: any; args: any; sig: string }[] = []
  const cuts: { start: number; end: number }[] = []
  const notes: string[] = []
  const seen = new Set<string>()

  const add = (rawName: string, rawArgs: any) => {
    const name = resolveToolName(rawName, tools)
    if (!name) return false
    const tool = tools.find((candidate) => toolNameOf(candidate) === name)
    const args = coerceArgs(tool, rawArgs ?? {})
    const sig = `${name}:${JSON.stringify(args)}`
    if (seen.has(sig)) return true
    seen.add(sig)
    found.push({ tool, args, sig })
    return true
  }

  // 1. <tool_call>{"name":..,"arguments":..}</tool_call>, голый JSON, ```json блоки
  for (const span of jsonSpans(text)) {
    const value = span.value
    if (!value || typeof value !== "object") continue

    const list = Array.isArray(value.tool_calls) ? value.tool_calls : Array.isArray(value.calls) ? value.calls : null
    if (list) {
      let touched = false
      for (const item of list) {
        const rawName = item?.name ?? item?.function?.name ?? item?.tool
        if (typeof rawName !== "string") continue
        const ok = add(rawName, item?.arguments ?? item?.args ?? item?.function?.arguments ?? {})
        touched = touched || ok
      }
      if (typeof value.message === "string" && value.message.trim()) notes.push(value.message.trim())
      if (touched) cuts.push({ start: span.start, end: span.end })
      continue
    }

    const rawName = value.name ?? value.tool ?? value.function ?? value.tool_name
    if (typeof rawName !== "string") continue
    if (add(rawName, value.arguments ?? value.args ?? value.parameters ?? value.input ?? value.params)) {
      cuts.push({ start: span.start, end: span.end })
    }
    if (found.length >= 8) break
  }

  // 2. <function=name>{"..."}</function> и <name>{"..."}</name>
  if (!found.length) {
    const xmlRe = /<function[=:\s]+([\w.-]+)\s*>([\s\S]*?)<\/function>/gi
    let match: RegExpExecArray | null
    while ((match = xmlRe.exec(text))) {
      const parsed = parseArguments(match[2].trim())
      if (add(match[1], parsed)) cuts.push({ start: match.index, end: match.index + match[0].length })
    }
  }

  // 3. Фолбэк: модель написала ```sh/```bash вместо вызова shell-инструмента
  if (!found.length) {
    const shellTool = tools.find((tool) => SHELL_TOOL_RE.test(toolNameOf(tool)))
    const writeTool = tools.find((tool) => WRITE_TOOL_RE.test(toolNameOf(tool)))
    for (const block of fencedBlocks(text)) {
      const body = block.body.trim()
      if (!body) continue
      if (SHELL_LANGS.has(block.lang)) {
        if (!shellTool) continue
        add(toolNameOf(shellTool), { command: body })
        cuts.push({ start: block.start, end: block.end })
        continue
      }
      if (writeTool && block.lang) {
        const path = pathFromInfo(block.info, block.lang)
        if (!path) continue
        add(toolNameOf(writeTool), { path, content: block.body })
        cuts.push({ start: block.start, end: block.end })
      }
    }
  }

  let content = cutRanges(text, cuts)
  content = content
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "")
    .replace(/<\/?tool_calls?>/gi, "")
    .replace(/<\/?tools>/gi, "")
    .replace(/<function[=:\s]+[\w.-]+\s*>/gi, "")
    .replace(/<\/function>/gi, "")
    .replace(/\[TOOL_REQUEST\]|\[END_TOOL_REQUEST\]/gi, "")
    .replace(/```[a-z0-9]*\s*```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  content = [content, ...notes].filter(Boolean).join("\n\n")

  return {
    content,
    calls: found.slice(0, 8).map((call) => ({
      id: `call_${randomBytes(12).toString("hex")}`,
      type: "function",
      function: {
        name: toolNameOf(call.tool),
        arguments: JSON.stringify(call.args ?? {}),
      },
    })),
  }
}

const upstreamCache = new Map<string, { url: string; at: number }>()

async function resolveUpstream(explicit: string): Promise<string> {
  if (explicit) return explicit.replace(/\/+$/, "")
  const cached = upstreamCache.get("default")
  if (cached && Date.now() - cached.at < 30_000) return cached.url
  for (const port of [1235, 1234]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) {
        const url = `http://127.0.0.1:${port}/v1`
        upstreamCache.set("default", { url, at: Date.now() })
        return url
      }
    } catch {}
  }
  return "http://127.0.0.1:1234/v1"
}

async function callUpstream(url: string, payload: any) {
  const response = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  const raw = await response.text()
  if (!response.ok) {
    const error: any = new Error(`local model error ${response.status}: ${truncate(raw, 500)}`)
    error.status = response.status
    error.body = raw
    throw error
  }
  return JSON.parse(raw)
}

function buildSystem(systems: string[], tools: any[]): string {
  const base = systems.filter(Boolean).join("\n\n")
  const protocol = toolProtocol(tools)
  // Порядок важен: сначала инструкция о командах/правилах, затем системный
  // промпт OpenCode, затем протокол инструментов. Сообщение пользователя
  // всегда идёт после этого системного блока.
  return [commandsInstruction(), base, protocol].filter(Boolean).join("\n\n")
}

function sse(res: ServerResponse, payload: any) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const toolSignatureLogged = new Set<string>()

async function handleChat(body: any, opts: Options, log: (message: string) => void) {
  const requestedTools = Array.isArray(body.tools) ? body.tools : []
  const tools = pickTools(requestedTools)
  const { systems, messages } = toUpstreamMessages(body)

  const signature = tools.map(toolNameOf).join(",")
  if (signature && !toolSignatureLogged.has(signature)) {
    toolSignatureLogged.add(signature)
    log(`shim: tools offered by OpenCode: ${signature}`)
  }

  const system = buildSystem(systems, tools)
  const payload: any = {
    model: opts.upstreamModel,
    messages: [{ role: "system", content: system }, ...messages].filter((m) => m.content),
    temperature: typeof body.temperature === "number" ? Math.min(Math.max(body.temperature, 0), 1.5) : 0.2,
    max_tokens: Math.min(Number(body.max_tokens) || opts.maxTokens, opts.maxTokens),
    stream: false,
  }
  const responseFormat = opts.jsonMode && tools.length ? buildResponseFormat(tools) : null
  if (responseFormat) payload.response_format = responseFormat

  let trimmed = 0
  let data: any
  for (;;) {
    const upstream = await resolveUpstream(opts.upstream)
    try {
      data = await callUpstream(upstream, payload)
      break
    } catch (error: any) {
      const text = `${error?.message ?? ""}\n${error?.body ?? ""}`
      if (error?.status === 400 && payload.response_format && /response_format|json_schema|grammar|structured/i.test(text)) {
        delete payload.response_format
        opts.jsonMode = false
        log("shim: upstream rejected response_format, retrying without it")
        continue
      }
      if (error?.status === 400 && CONTEXT_RE.test(text) && trimmed < 3) {
        trimmed++
        const keep = trimmed === 1 ? 0.75 : trimmed === 2 ? 0.5 : 0.3
        const dropCount = Math.max(0, payload.messages.length - 2 - Math.floor((payload.messages.length - 2) * keep))
        if (dropCount > 0) payload.messages.splice(1, dropCount)
        for (const message of payload.messages) {
          if (typeof message.content === "string" && message.content.length > 6000) {
            message.content = truncate(message.content, 6000)
          }
        }
        log(`shim: context overflow, trimmed ${dropCount} messages and retrying`)
        continue
      }
      throw error
    }
  }

  const choice = data?.choices?.[0] ?? {}
  const nativeCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
  const text = textOf(choice?.message?.content ?? "")

  let parsed: Calls
  if (nativeCalls.length) {
    parsed = {
      content: text.trim(),
      calls: nativeCalls
        .map((call: any) => {
          const rawName = String(call?.function?.name ?? call?.name ?? "")
          const tool = tools.find((candidate) => toolNameOf(candidate) === rawName)
          return {
            id: call?.id ?? `call_${randomBytes(12).toString("hex")}`,
            type: "function",
            function: {
              name: tool ? rawName : (resolveToolName(rawName, tools) ?? rawName),
              arguments: JSON.stringify(coerceArgs(tool, parseArguments(call?.function?.arguments ?? call?.arguments ?? {}))),
            },
          }
        })
        .filter((call: any) => call.function.name),
    }
  } else {
    parsed = tools.length ? extractToolCalls(text, tools) : { calls: [], content: text.trim() }
  }

  const usage = {
    prompt_tokens: data?.usage?.prompt_tokens ?? 0,
    completion_tokens: data?.usage?.completion_tokens ?? 0,
    total_tokens: data?.usage?.total_tokens ?? 0,
  }

  log(
    `shim: ${requestedTools.length} tools -> ${tools.length}, ${messages.length} msgs, json=${payload.response_format ? "on" : "off"}, ` +
      `${parsed.calls.length} call(s)${parsed.calls.length ? ` [${parsed.calls.map((c: any) => c.function.name).join(",")}]` : ""}, ` +
      `${usage.prompt_tokens} in / ${usage.completion_tokens} out`,
  )

  return {
    id: `chatcmpl-local-${randomBytes(8).toString("hex")}`,
    created: Math.floor(Date.now() / 1000),
    model: opts.upstreamModel,
    content: parsed.content,
    calls: parsed.calls,
    usage,
  }
}

type Shim = { server: Server; port: number }

function startShim(opts: Options, log: (message: string) => void): Promise<Shim> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const started = Date.now()
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1")
          if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "content-type": "text/plain" })
            res.end("limit-fallback shim ok")
            return
          }
          if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/settings")) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            res.end(settingsPage(opts))
            return
          }
          if (req.method === "GET" && url.pathname === "/api/settings") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ settings: currentSettings(opts) }))
            return
          }
          if (req.method === "POST" && url.pathname === "/api/settings") {
            const body = await readJson(req)
            const settings = writeSettings(opts, body ?? {})
            applySettings(opts, settings)
            log(
              `settings: upstream=${opts.upstream || "auto"} model=${opts.upstreamModel} ` +
                `maxTokens=${opts.maxTokens} json=${opts.jsonMode}`,
            )
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true, settings: currentSettings(opts) }))
            return
          }
          if (req.method === "POST" && url.pathname === "/api/test") {
            const upstream = await resolveUpstream(opts.upstream)
            const response = await fetch(`${upstream}/models`, { signal: AbortSignal.timeout(10_000) })
            const raw = await response.text()
            if (!response.ok) {
              const error: any = new Error(`HTTP ${response.status}: ${truncate(raw, 300)}`)
              error.status = response.status
              throw error
            }
            let models: string[] = []
            try {
              const parsed = JSON.parse(raw)
              models = (parsed?.data ?? [])
                .map((item: any) => String(item?.id ?? ""))
                .filter(Boolean)
            } catch {}
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true, upstream, models }))
            return
          }
          if (req.method === "GET" && url.pathname === "/v1/models") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                object: "list",
                data: [{ id: opts.modelID, object: "model", owned_by: "local" }],
              }),
            )
            return
          }
          if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            const body = await readJson(req)
            const result = await handleChat(body, opts, log)
            const wantsStream = body?.stream === true
            if (!wantsStream) {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(
                JSON.stringify({
                  id: result.id,
                  object: "chat.completion",
                  created: result.created,
                  model: result.model,
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: result.content || null,
                        ...(result.calls.length ? { tool_calls: result.calls } : {}),
                      },
                      finish_reason: result.calls.length ? "tool_calls" : "stop",
                    },
                  ],
                  usage: result.usage,
                }),
              )
              return
            }

            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            })
            const base = {
              id: result.id,
              object: "chat.completion.chunk",
              created: result.created,
              model: result.model,
            }
            sse(res, {
              ...base,
              choices: [{ index: 0, delta: { role: "assistant", content: result.content || "" }, finish_reason: null }],
            })
            result.calls.forEach((call: any, index: number) => {
              sse(res, {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: call.id,
                          type: "function",
                          function: { name: call.function.name, arguments: call.function.arguments },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              })
            })
            sse(res, {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: result.calls.length ? "tool_calls" : "stop",
                },
              ],
              usage: result.usage,
            })
            res.write("data: [DONE]\n\n")
            res.end()
            log(`shim: stream done in ${Date.now() - started}ms`)
            return
          }
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { message: "not found" } }))
        } catch (error: any) {
          log(`shim: error ${error?.stack ?? error}`)
          if (!res.headersSent) {
            res.writeHead(error?.status === 400 ? 400 : 502, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: { message: String(error?.message ?? error), type: "local_fallback_error" },
              }),
            )
          } else {
            try {
              res.end()
            } catch {}
          }
        }
      })()
    })

    server.on("error", (error) => reject(error))
    server.listen(opts.shimPort, "127.0.0.1", () => {
      log(`shim: listening on http://127.0.0.1:${opts.shimPort}/v1`)
      resolve({ server, port: opts.shimPort })
    })
  })
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 32 * 1024 * 1024) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

// ---------------------------------------------------------------------------
// Плагин: ловим лимит (только уведомление) + ручное переключение по /local
// ---------------------------------------------------------------------------

const STATE_KEY = "__opencodeLimitFallbackV1"
const SHIM_VERSION = 5
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type State = {
  refs: number
  version: number
  shim: Shim | null
  shimStarting: Promise<Shim | null> | null
  abort: AbortController | null
  eventsStarted: boolean
  handled: Map<string, number>
  log: (message: string) => void
}

function state(): State {
  const global = globalThis as any
  if (!global[STATE_KEY]) {
    global[STATE_KEY] = {
      refs: 0,
      version: 0,
      shim: null,
      shimStarting: null,
      abort: null,
      eventsStarted: false,
      handled: new Map<string, number>(),
      log: () => {},
    } satisfies State
  }
  return global[STATE_KEY] as State
}

async function ensureShim(s: State, opts: Options) {
  if (s.shim) return
  if (s.shimStarting) {
    await s.shimStarting
    return
  }
  s.shimStarting = startShim(opts, s.log)
    .then((shim) => {
      s.shim = shim
      return shim
    })
    .catch((error: any) => {
      s.log(`shim: failed to start on ${opts.shimPort}: ${error?.message ?? error}`)
      return null
    })
    .finally(() => {
      s.shimStarting = null
    })
  await s.shimStarting
}

// ctx.model.list() в разных сборках отдаёт либо массив, либо { data: [...] },
// либо карту providerID -> модели. Приводим всё к плоскому массиву.
function modelArray(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.models)) return value.models
  if (value && typeof value === "object") {
    const flat: any[] = []
    for (const [providerID, entry] of Object.entries(value)) {
      if (Array.isArray(entry)) {
        for (const model of entry) flat.push({ providerID, ...(model as any) })
        continue
      }
      const models = (entry as any)?.models
      if (Array.isArray(models)) {
        for (const model of models) flat.push({ providerID, ...model })
      }
    }
    return flat
  }
  return []
}

async function switchToLocal(ctx: any, s: State, opts: Options, sessionID: string, reason: string) {
  const session = await ctx.session.get({ sessionID })
  const current = session?.model
  const from = current ? `${current.providerID}/${current.id}` : "cloud model"
  if (current?.providerID === opts.providerID) {
    s.log(`switch: ${sessionID} already on ${opts.providerID}`)
    await ctx.session
      .synthetic({ sessionID, text: `This session is already running on the local model ${from}.` })
      .catch(() => {})
    return false
  }

  const models = modelArray(await ctx.model.list().catch(() => []))
  const modelID = (m: any) => m?.id ?? m?.modelID
  const target =
    models.find((m: any) => m.providerID === opts.providerID && modelID(m) === opts.modelID) ??
    models.find(
      (m: any) =>
        ["lmstudio", "ollama", "vllm", opts.providerID].includes(m.providerID) &&
        /qwen.*coder/i.test(String(modelID(m) ?? "")),
    ) ??
    // Даже если список моделей пришёл в неизвестном формате, пробуем прописанный провайдер напрямую.
    { providerID: opts.providerID, id: opts.modelID }

  try {
    await ctx.session.interrupt({ sessionID, resume: false })
  } catch {}
  await sleep(300)

  try {
    await ctx.session.switchModel({
      sessionID,
      model: { providerID: target.providerID, id: target.id },
    })
  } catch (error: any) {
    s.log(`switch: model switch failed for ${sessionID}: ${error?.message ?? error}`)
    await ctx.session
      .synthetic({
        sessionID,
        text:
          `Could not switch to ${target.providerID}/${target.id}: ${error?.message ?? error}. ` +
          `Check the localqwen provider in ~/.config/opencode/opencode.json and that the plugin shim is running.`,
      })
      .catch(() => {})
    return false
  }

  const after = await ctx.session.get({ sessionID })
  if (after?.model?.providerID !== target.providerID) {
    s.log(`switch: model did not stick for ${sessionID}`)
    return false
  }

  s.handled.set(sessionID, Date.now())
  s.log(`switch: ${sessionID} ${from} -> ${target.providerID}/${target.id} (${reason})`)

  await ctx.session
    .synthetic({
      sessionID,
      text: `Switched this session from ${from} to the local model ${target.providerID}/${target.id}.`,
    })
    .catch(() => {})

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ctx.session.prompt({ sessionID, text: opts.continuation })
      return true
    } catch (error: any) {
      s.log(`switch: prompt attempt ${attempt + 1} failed: ${error?.message ?? error}`)
      await sleep(1500)
    }
  }
  return true
}

async function notifyLimit(ctx: any, s: State, opts: Options, sessionID: string) {
  if (!sessionID) return
  const last = s.handled.get(sessionID) ?? 0
  if (Date.now() - last < 60_000) return
  s.handled.set(sessionID, Date.now())

  let from = "the cloud model"
  try {
    const session = await ctx.session.get({ sessionID })
    if (session?.model) from = `${session.model.providerID}/${session.model.id}`
  } catch {}

  s.log(`limit: notifying ${sessionID} (no auto-switch)`)
  await ctx.session.synthetic({ sessionID, text: limitNotice(from) }).catch((error: any) => {
    s.log(`limit: synthetic failed for ${sessionID}: ${error?.message ?? error}`)
  })
}

async function watchEvents(ctx: any, s: State, opts: Options, signal: AbortSignal) {
  try {
    for await (const event of ctx.event.subscribe({
      types: ["session.step.failed", "session.execution.failed", "session.retry.scheduled"],
      signal,
    })) {
      const data = (event as any)?.data ?? {}
      const error = data.error
      const summary = [error?.type, error?.status, error?.message].filter(Boolean).join(" | ")
      s.log(`event ${(event as any).type} session=${data.sessionID ?? "?"} ${truncate(String(summary), 300)}`)
      if (!isLimitError(error)) continue
      await notifyLimit(ctx, s, opts, data.sessionID)
    }
  } catch (error: any) {
    if (!signal.aborted) s.log(`events: subscribe failed: ${error?.message ?? error}`)
  }
}

export default Plugin.define({
  id: "limit-fallback",
  async setup(ctx) {
    const s = state()
    const opts = readOptions(ctx)
    const stored = readSettings(opts)
    applySettings(opts, stored)
    s.refs++
    s.log = makeLogger(opts.logFile)
    s.log(
      `setup: refs=${s.refs} dir=${ctx.location?.directory ?? "?"} ` +
        `upstream=${opts.upstream || "auto"} model=${opts.upstreamModel}`,
    )

    if (s.shim && s.version !== SHIM_VERSION) {
      s.log(`shim: code changed ${s.version} -> ${SHIM_VERSION}, restarting`)
      try {
        s.shim.server.close()
      } catch {}
      s.shim = null
    }
    s.version = SHIM_VERSION

    await ensureShim(s, opts)

    if (!s.eventsStarted) {
      s.eventsStarted = true
      s.abort = new AbortController()
      void watchEvents(ctx, s, opts, s.abort.signal)
    }

    // Ручное переключение: /local — единственный способ уйти на локальную модель.
    await ctx.command
      .transform((editor: any) => {
        editor.add({
          name: "local",
          description: "Continue this session on the local Qwen2.5 Coder",
          execute: async ({ sessionID }: any) => {
            await switchToLocal(ctx, s, opts, sessionID, "manual /local")
          },
        })
        editor.add({
          name: "local-setup",
          description: "Show the local model settings page (server URL, model, limits)",
          execute: async ({ sessionID }: any) => {
            const url = `http://127.0.0.1:${opts.shimPort}/`
            await ctx.session
              .synthetic({
                sessionID,
                text:
                  `Local model settings: ${url}\n` +
                  `Current server: ${opts.upstream || "auto-detect"}\n` +
                  `Current model: ${opts.upstreamModel}\n` +
                  `Settings file: ${settingsFile(opts)}`,
              })
              .catch(() => {})
          },
        })
      })
      .catch((error: any) => s.log(`command: register failed: ${error?.message ?? error}`))

    return () => {
      s.refs--
      s.log(`dispose: refs=${s.refs}`)
      if (s.refs > 0) return
      s.abort?.abort()
      s.abort = null
      s.eventsStarted = false
      s.shim?.server.close()
      s.shim = null
    }
  },
})
