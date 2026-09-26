import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import apiPackage from "../package.json" with { type: "json" };

export const API_VERSION = apiPackage.version;

const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const bool = z.preprocess((value) => value === "true", z.boolean());

const envSchema = z.object({
  APP_ENV: z.enum(["dev", "demo", "production"]).default("dev"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  API_PUBLIC_URL: z.url().default("http://localhost:4100"),
  WEB_PUBLIC_URL: z.url().default("http://localhost:5173"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(10),
  SUPABASE_SECRET_KEY: z.string().optional(),
  MCP_ENABLED: bool.default(false),
  VOICE_ENABLED: bool.default(false),
  SMS_ENABLED: bool.default(false),
  OPERATIONS_PAUSED: bool.default(false),
  OPERATIONS_PAUSE_MESSAGE: z.string().trim().min(1).max(240).default("Les créations d’appels et de SMS sont temporairement suspendues pour maintenance. Réessayez un peu plus tard."),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  TWILIO_PUSH_CREDENTIAL_SID_IOS: z.string().optional(),
  TWILIO_PUSH_CREDENTIAL_SID_ANDROID: z.string().optional(),
  TWILIO_ALLOWED_DESTINATIONS: z.string().default("+33"),
  SMS_ALLOWED_RECIPIENTS: z.string().default(""),
  MAX_ACTIVE_CALL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  MAX_RINGING_DEVICES: z.coerce.number().int().min(1).max(8).default(4),
}).superRefine((value, ctx) => {
  if (value.MCP_ENABLED && (!value.SUPABASE_SECRET_KEY || (value.APP_ENV !== "dev" && (!value.API_PUBLIC_URL.startsWith("https://") || !value.WEB_PUBLIC_URL.startsWith("https://"))))) {
    ctx.addIssue({ code: "custom", path: ["MCP_ENABLED"], message: "Le MCP exige une clé Supabase serveur et des URL HTTPS hors développement." });
  }
  if (value.VOICE_ENABLED && (!value.TWILIO_ACCOUNT_SID || !value.TWILIO_API_KEY_SID || !value.TWILIO_API_KEY_SECRET || !value.TWILIO_TWIML_APP_SID || !value.TWILIO_AUTH_TOKEN || !value.SUPABASE_SECRET_KEY)) {
    ctx.addIssue({ code: "custom", path: ["VOICE_ENABLED"], message: "La voix exige les credentials Twilio serveur et une clé Supabase serveur." });
  }
  if (value.SMS_ENABLED && (!value.TWILIO_ACCOUNT_SID || !value.TWILIO_API_KEY_SID || !value.TWILIO_API_KEY_SECRET || !value.TWILIO_AUTH_TOKEN || !value.SUPABASE_SECRET_KEY)) {
    ctx.addIssue({ code: "custom", path: ["SMS_ENABLED"], message: "Les SMS exigent les credentials Twilio et Supabase serveur." });
  }
  if (value.SMS_ENABLED) {
    const recipients = value.SMS_ALLOWED_RECIPIENTS.split(",").map((number) => number.trim()).filter(Boolean);
    if (!recipients.length || recipients.some((number) => !/^\+[1-9]\d{6,14}$/.test(number))) {
      ctx.addIssue({ code: "custom", path: ["SMS_ALLOWED_RECIPIENTS"], message: "Les SMS exigent une allowlist de destinataires E.164 autorisés." });
    }
  }
});

export type AppConfig = Omit<z.infer<typeof envSchema>, "API_PORT"> & { API_PORT: number; API_VERSION: string; allowedOrigins: Set<string> };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Configuration invalide : ${messages.join("; ")}`);
  }

  return {
    ...parsed.data,
    API_PORT: parsed.data.API_PORT ?? parsed.data.PORT ?? 4100,
    API_VERSION,
    allowedOrigins: new Set(parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)),
  };
}
