import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger";

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : undefined;
const MAX_DURATION_SECONDS = 27 * 60;
const MAX_FILE_BYTES = 20_000_000;
const MAX_QUEUE_SIZE = 2;
const TRANSCRIBE_SCRIPT = fileURLToPath(
  new URL("./bot/transcribe.py", import.meta.url),
);

type TelegramFile = {
  file_id: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
  video?: TelegramFile;
  document?: TelegramFile;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type Transcription = {
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
};

let updateOffset = 0;
let isPolling = false;
let isProcessing = false;
const queue: TelegramUpdate[] = [];

export function startTelegramBot(): void {
  if (!BOT_TOKEN || !TELEGRAM_API) {
    logger.info("Telegram bot is disabled: TELEGRAM_BOT_TOKEN is not configured");
    return;
  }

  if (isPolling) return;
  isPolling = true;
  void pollTelegramUpdates();
}

async function telegramCall<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (!TELEGRAM_API) throw new Error("Telegram bot is not configured");
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 30_000),
  });

  const body = (await response.json()) as TelegramResponse<T> & {
    description?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(`Telegram ${method} request failed`);
  }
  return body.result;
}

async function pollTelegramUpdates(): Promise<void> {
  try {
    const bot = await telegramCall<{ username?: string }>("getMe", {});
    logger.info(
      { username: bot.username ?? "unknown" },
      "Telegram subtitle bot connected",
    );
  } catch {
    logger.error("Telegram bot could not connect; check the saved bot token");
    isPolling = false;
    return;
  }

  while (isPolling) {
    try {
      const updates = await telegramCall<TelegramUpdate[]>("getUpdates", {
        offset: updateOffset,
        timeout: 25,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        const message = update.message;
        if (!message) continue;

        if (queue.length >= MAX_QUEUE_SIZE) {
          await sendMessage(
            message.chat.id,
            "Сейчас очередь заполнена. Попробуй отправить видео чуть позже.",
          );
          continue;
        }
        queue.push(update);
      }

      void processQueue();
    } catch {
      logger.warn("Telegram polling request failed; retrying shortly");
      await delay(5_000);
    }
  }
}

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (queue.length > 0) {
      const update = queue.shift();
      if (!update) continue;
      try {
        await handleUpdate(update);
      } catch {
        logger.warn("Could not handle a Telegram update");
      }
    }
  } finally {
    isProcessing = false;
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  if (message.text?.startsWith("/start") || message.text?.startsWith("/help")) {
    await sendMessage(
      message.chat.id,
      "Пришли видео длительностью до 27 минут — я распознаю речь на языке оригинала и верну файл .srt с таймкодами. Через стандартный Telegram Bot API можно скачать файл размером до 20 МБ.",
    );
    return;
  }

  const video = getVideoFile(message);
  if (!video) {
    if (message.text || message.document) {
      await sendMessage(
        message.chat.id,
        "Отправь видео как видео или как файл. Максимальная длительность — 27 минут.",
      );
    }
    return;
  }

  if (video.file_size && video.file_size > MAX_FILE_BYTES) {
    await sendMessage(
      message.chat.id,
      "Файл больше 20 МБ, а стандартный Telegram Bot API не даёт боту скачать видео крупнее. Попробуй сильно сжать видео или отправить файл меньшего размера.",
    );
    return;
  }

  await sendMessage(
    message.chat.id,
    "Видео принято. Проверяю длительность и распознаю речь. На длинном видео обработка может занять время.",
  );

  try {
    await processVideo(message.chat.id, video);
  } catch {
    logger.error("Telegram video transcription failed");
    await sendMessage(
      message.chat.id,
      "Не получилось обработать это видео. Проверь, что в нём есть слышимая речь, и попробуй отправить файл ещё раз.",
    );
  }
}

function getVideoFile(message: TelegramMessage): TelegramFile | undefined {
  if (message.video) return message.video;
  const document = message.document;
  if (!document) return undefined;

  const mimeType = document.mime_type?.toLowerCase() ?? "";
  const fileName = document.file_name?.toLowerCase() ?? "";
  const hasVideoExtension = /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg)$/i.test(
    fileName,
  );
  return mimeType.startsWith("video/") || hasVideoExtension
    ? document
    : undefined;
}

async function processVideo(
  chatId: number,
  video: TelegramFile,
): Promise<void> {
  const telegramFile = await telegramCall<{ file_path?: string; file_size?: number }>(
    "getFile",
    { file_id: video.file_id },
  );
  if (!telegramFile.file_path) throw new Error("Telegram returned no file path");
  if ((telegramFile.file_size ?? video.file_size ?? 0) > MAX_FILE_BYTES) {
    await sendMessage(
      chatId,
      "Файл больше 20 МБ, поэтому стандартный Telegram Bot API не может передать его боту.",
    );
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "subtitle-bot-"));
  const inputPath = path.join(tempDir, "input-video");
  const audioPath = path.join(tempDir, "audio.wav");
  const subtitlesPath = path.join(tempDir, "subtitles.srt");

  try {
    await downloadTelegramFile(telegramFile.file_path, inputPath);
    const durationText = await runProcess("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const duration = Number.parseFloat(durationText);
    if (!Number.isFinite(duration)) {
      throw new Error("Could not read video duration");
    }
    if (duration > MAX_DURATION_SECONDS) {
      await sendMessage(chatId, "Видео длиннее 27 минут. Отправь более короткий файл.");
      return;
    }

    await runProcess("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);

    await sendMessage(chatId, "Звук извлечён. Запускаю распознавание речи.");
    const resultText = await runProcess(
      "uv",
      ["run", "python", TRANSCRIBE_SCRIPT, audioPath],
      60 * 60 * 1000,
    );
    const result = JSON.parse(resultText) as Transcription;
    const srt = formatSrt(result.segments);
    if (!srt.trim()) {
      await sendMessage(chatId, "Не удалось распознать речь в этом видео.");
      return;
    }

    await writeFile(subtitlesPath, srt, "utf8");
    const language = result.language || "не определён";
    await sendDocument(
      chatId,
      subtitlesPath,
      `Субтитры готовы. Распознанный язык: ${language}.`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function downloadTelegramFile(
  filePath: string,
  destination: string,
): Promise<void> {
  if (!BOT_TOKEN) throw new Error("Telegram bot is not configured");
  const encodedPath = filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const response = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${encodedPath}`,
    { signal: AbortSignal.timeout(90_000) },
  );
  if (!response.ok) throw new Error("Telegram file download failed");

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("Telegram file is larger than the allowed download size");
  }
  await writeFile(destination, bytes);
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  await telegramCall("sendMessage", { chat_id: chatId, text });
}

async function sendDocument(
  chatId: number,
  filePath: string,
  caption: string,
): Promise<void> {
  if (!TELEGRAM_API) throw new Error("Telegram bot is not configured");
  const content = await readFile(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption);
  form.set(
    "document",
    new Blob([new Uint8Array(content)], { type: "application/x-subrip" }),
    "subtitles.srt",
  );

  const response = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { ok: boolean };
  if (!response.ok || !body.ok) {
    throw new Error("Telegram could not send the subtitle file");
  }
}

function formatSrt(
  segments: Transcription["segments"],
): string {
  return segments
    .map((segment, index) => {
      const text = segment.text.trim().replace(/\r?\n/g, " ");
      if (!text) return "";
      return `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)},${String(remainder).padStart(3, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${command} timed out`));
      } else if (code !== 0) {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
