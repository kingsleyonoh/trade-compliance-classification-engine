import https from "node:https";
import path from "node:path";

export interface TelegramNotificationEnv {
  KLEVAR_TELEGRAM_BOT_TOKEN?: string;
  KLEVAR_TELEGRAM_CHAT_ID?: string;
  KLEVAR_TELEGRAM_NOTIFY?: string;
  KLEVAR_TELEGRAM_NOTIFY_COMPLETE?: string;
}

export interface RuntimeNotification {
  cwd: string;
  status: "failed" | "complete";
  batch?: number;
  phase?: string;
  message: string;
}

export function telegramEnabled(env: TelegramNotificationEnv = process.env): boolean {
  if (env.KLEVAR_TELEGRAM_NOTIFY === "0" || env.KLEVAR_TELEGRAM_NOTIFY === "false") return false;
  return Boolean(env.KLEVAR_TELEGRAM_BOT_TOKEN && env.KLEVAR_TELEGRAM_CHAT_ID);
}

export function shouldNotifyRuntimeFinish(event: RuntimeNotification, env: TelegramNotificationEnv = process.env): boolean {
  if (!telegramEnabled(env)) return false;
  if (event.status === "failed") return true;
  return env.KLEVAR_TELEGRAM_NOTIFY_COMPLETE === "1" || env.KLEVAR_TELEGRAM_NOTIFY_COMPLETE === "true";
}

export async function notifyRuntimeFinish(event: RuntimeNotification, env: TelegramNotificationEnv = process.env): Promise<void> {
  if (!shouldNotifyRuntimeFinish(event, env)) return;
  await sendTelegramMessage(env.KLEVAR_TELEGRAM_BOT_TOKEN!, env.KLEVAR_TELEGRAM_CHAT_ID!, formatRuntimeNotification(event));
}

export function formatRuntimeNotification(event: RuntimeNotification): string {
  const icon = event.status === "failed" ? "❌" : "✅";
  const project = path.basename(event.cwd);
  const lines = [
    `${icon} Klevar YOLO ${event.status}`,
    `Project: ${project}`,
    event.batch ? `Batch: ${String(event.batch).padStart(3, "0")}` : undefined,
    event.phase ? `Phase: ${event.phase}` : undefined,
    `Reason: ${event.message}`,
    "Next: open Pi and run /yolo-explain or /yolo-dashboard"
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
  const options: https.RequestOptions = {
    hostname: "api.telegram.org",
    path: `/bot${encodeURIComponent(token)}/sendMessage`,
    method: "POST",
    timeout: 10_000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    }
  };
  await new Promise<void>((resolve, reject) => {
    const req = https.request(options, (res) => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Telegram notification failed with HTTP ${res.statusCode}: ${response.slice(0, 200)}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram notification timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
