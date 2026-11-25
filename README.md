# Local Fallback для OpenCode

Плагин для OpenCode V2: когда у облачной модели заканчивается лимит, сессия
переключается на локальную модель (LM Studio / Ollama / llama.cpp) и продолжает
работу с файлами через tool calls.

---

## Для AI-ассистента (прочитай первым)

Если тебя попросили установить этот плагин — сделай следующее:

1. Скопируй папку `plugins/limit-fallback` в `~/.config/opencode/plugins/`
   (на Windows: `C:\Users\<user>\.config\opencode\plugins\limit-fallback`).
2. Добавь провайдера `localqwen` из `opencode.example.json` в глобальный
   `~/.config/opencode/opencode.json`, не удаляя существующие настройки.
3. Проверь, что локальный сервер запущен (LM Studio: порт 1235, Ollama: 11434),
   и открой `http://127.0.0.1:1236/` — там интерфейс, где указывается URL и имя
   локальной модели.
4. Убедись, что в `opencode.json` есть `"compaction": { "auto": false }`, иначе
   при переключении на модель с маленьким контекстом сессия будет сжиматься.
5. **Кратко объясни пользователю на его языке**, что установлено, какие команды
   появились (`/local`, `/local-setup`) и что настройки открываются по адресу
   `http://127.0.0.1:1236/`.

Ничего не перезапускай: OpenCode подхватывает плагины и конфиг на лету.

---

## Что это

- Ловит ошибки лимита (`QuotaExceeded`, 429, `Free usage limit reached`,
  `rate limit`, `insufficient credits`).
- **Не переключает модель сам** — пишет в сессию уведомление с предложением
  выполнить `/local`.
- По команде `/local` переключает текущую сессию на локальную модель и просит
  продолжить задачу с того же места.
- Поднимает локальный OpenAI-совместимый шим на `127.0.0.1:1236`, который
  превращает текстовые tool-call'ы Qwen в настоящие `tool_calls`, поэтому
  локальная модель умеет читать и править файлы.
- Перед сообщением пользователя модель всегда получает блок инструкций о
  доступных командах и правилах работы.
- Даёт веб-интерфейс для настройки локального сервера и модели.

## Требования

- OpenCode V2.
- Локальный OpenAI-совместимый сервер: LM Studio (по умолчанию порт 1235),
  Ollama (11434) или llama.cpp (8080).
- Модель, способная работать с кодом: рекомендуется `qwen2.5-coder-7b-instruct`
  или больше.
- Свободный порт 1236 для шима.

## Быстрая установка

1. Скачай/распакуй эту папку.
2. Открой OpenCode и напиши:

   > Установи плагин из папки `opencode-local-fallback`: скопируй
   > `plugins/limit-fallback` в `~/.config/opencode/plugins/`, добавь провайдера
   > `localqwen` из `opencode.example.json` в `opencode.json` и коротко объясни,
   > что получилось.

3. Запусти локальный сервер с моделью.
4. Открой `http://127.0.0.1:1236/` и укажи URL сервера и имя модели.
5. В OpenCode выполни `/local` (или выбери команду в палитре `Ctrl+P`).

## Ручная установка

```powershell
# Windows
Copy-Item -Recurse .\plugins\limit-fallback "$env:USERPROFILE\.config\opencode\plugins\limit-fallback"
```

```bash
# Linux / macOS
cp -r ./plugins/limit-fallback ~/.config/opencode/plugins/limit-fallback
```

Затем добавь в `~/.config/opencode/opencode.json`:

```json
{
  "compaction": { "auto": false },
  "providers": {
    "localqwen": {
      "name": "Local Qwen (LM Studio)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:1236/v1",
        "apiKey": "local-shim"
      },
      "models": {
        "qwen2.5-coder-7b-instruct": {
          "name": "Qwen2.5 Coder 7B (local)",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 32768, "output": 4096 }
        }
      }
    }
  }
}
```

## Интерфейс настроек

Открой `http://127.0.0.1:1236/` (или выполни `/local-setup`):

- **Путь / URL до локального сервера** — например `http://127.0.0.1:1235/v1`.
  Пустое поле означает автопоиск портов 1234/1235/11434/8080.
- **Имя модели** — `qwen2.5-coder-7b-instruct`.
- **Максимум токенов ответа**.
- **JSON-режим** — по умолчанию выключен, для Qwen2.5-Coder так лучше.
- Кнопка **«Проверить подключение»** показывает список моделей сервера.

Настройки сохраняются в `~/.local/share/opencode/limit-fallback.json` и
применяются сразу, без перезапуска.

## Команды

| Команда | Что делает |
| --- | --- |
| `/local` | Переключить сессию на локальную модель и продолжить задачу |
| `/local-setup` | Показать адрес интерфейса настроек и текущие параметры |
| `/compact` | Ручная компактизация (работает всегда) |

## Как это работает

1. OpenCode отправляет запрос в шим `127.0.0.1:1236/v1`.
2. Шим собирает системный промпт: сначала инструкция о командах, затем системный
   промпт OpenCode, затем протокол инструментов.
3. Запрос уходит в LM Studio/Ollama.
4. Ответ парсится: поддерживаются `<tool_call>{...}</tool_call>`, голый JSON,
   `json`-блоки, `{"tool_calls":[...]}`, `<function=...>` и код-блоки
   `sh` / `ts path=...`.
5. Вызовы превращаются в настоящие OpenAI `tool_calls` и отдаются в OpenCode
   (включая SSE-стрим).
6. При переполнении контекста шим сам урезает историю и повторяет запрос.

## Ограничения

- Локальная 7B иногда выбирает не тот инструмент или фабрикует вывод — это
  ограничение модели, а не парсера.
- Контекст 32k: очень длинные сессии будут урезаны шимом.
- Автопереключения нет: только уведомление и ручной `/local`.
- Автоматическая компактизация отключена намеренно (`compaction.auto: false`),
  потому что у локальной модели маленький контекст и она сжимала бы сессию при
  каждом переключении.

## Лицензия

MIT. См. `LICENSE`.

---

# Local Fallback for OpenCode (English)

An OpenCode V2 plugin: when the cloud model runs out of quota, the session
switches to a local model (LM Studio / Ollama / llama.cpp) and keeps working with
files through tool calls.

## For the AI assistant (read first)

If you were asked to install this plugin:

1. Copy `plugins/limit-fallback` into `~/.config/opencode/plugins/`.
2. Merge the `localqwen` provider from `opencode.example.json` into the global
   `~/.config/opencode/opencode.json` without removing existing settings.
3. Make sure the local server is running (LM Studio: 1235, Ollama: 11434) and
   open `http://127.0.0.1:1236/` to set the server URL and model name.
4. Keep `"compaction": { "auto": false }` in `opencode.json`; otherwise a model
   with a small context window compacts the session on every switch.
5. **Briefly explain to the user in their language** what was installed, which
   commands appeared (`/local`, `/local-setup`), and that settings live at
   `http://127.0.0.1:1236/`.

No restart is required: OpenCode reloads plugins and config on the fly.

## What it does

- Detects quota errors (`QuotaExceeded`, 429, `Free usage limit reached`,
  `rate limit`, `insufficient credits`).
- **Does not switch automatically** — it posts a notice suggesting `/local`.
- `/local` switches the current session to the local model and asks it to
  continue from where it stopped.
- Runs a local OpenAI-compatible shim on `127.0.0.1:1236` that converts Qwen's
  text tool calls into real `tool_calls`, so the local model can read and edit
  files.
- Always sends an instruction block about commands and rules before the user's
  message.
- Provides a web UI to configure the local server and model.

## Requirements

- OpenCode V2.
- A local OpenAI-compatible server: LM Studio (port 1235), Ollama (11434), or
  llama.cpp (8080).
- A code-capable model: `qwen2.5-coder-7b-instruct` or larger is recommended.
- Port 1236 free for the shim.

## Quick install

1. Download/unpack this folder.
2. Open OpenCode and write:

   > Install the plugin from `opencode-local-fallback`: copy
   > `plugins/limit-fallback` to `~/.config/opencode/plugins/`, add the
   > `localqwen` provider from `opencode.example.json` to `opencode.json`, and
   > briefly explain the result.

3. Start your local server with the model.
4. Open `http://127.0.0.1:1236/` and set the server URL and model name.
5. Run `/local` in OpenCode (or pick it from the `Ctrl+P` palette).

## Manual install

```bash
cp -r ./plugins/limit-fallback ~/.config/opencode/plugins/limit-fallback
```

Then add the provider block shown above to `~/.config/opencode/opencode.json`.

## Settings UI

Open `http://127.0.0.1:1236/` (or run `/local-setup`):

- **Local server path / URL** — e.g. `http://127.0.0.1:1235/v1`. Empty means
  auto-detect ports 1234/1235/11434/8080.
- **Model name** — `qwen2.5-coder-7b-instruct`.
- **Max response tokens**.
- **JSON mode** — off by default; Qwen2.5-Coder behaves better without it.
- **Test connection** lists the models exposed by the server.

Settings are stored in `~/.local/share/opencode/limit-fallback.json` and applied
immediately.

## Commands

| Command | Purpose |
| --- | --- |
| `/local` | Switch the session to the local model and continue |
| `/local-setup` | Show the settings URL and current parameters |
| `/compact` | Manual compaction (always available) |

## How it works

1. OpenCode sends requests to the shim at `127.0.0.1:1236/v1`.
2. The shim builds the system prompt: command instructions first, then
   OpenCode's system prompt, then the tool protocol.
3. The request goes to LM Studio/Ollama.
4. The response is parsed from `<tool_call>{...}</tool_call>`, bare JSON,
   `json` blocks, `{"tool_calls":[...]}`, `<function=...>`, and fenced
   `sh` / `ts path=...` blocks.
5. Calls become real OpenAI `tool_calls` (including SSE streaming).
6. On context overflow the shim trims history and retries automatically.

## Limitations

- A 7B model sometimes picks the wrong tool or invents output — that is a model
  limitation, not a parser bug.
- 32k context: very long sessions get trimmed by the shim.
- No automatic switching: notification plus manual `/local` only.
- Automatic compaction is intentionally disabled (`compaction.auto: false`)
  because the local model has a small context window.

## License

MIT. See `LICENSE`.
