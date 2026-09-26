import type { ServiceStatus } from "@onoff/contracts";
import type { AppConfig } from "./config.js";

export function serviceStatus(config: AppConfig): ServiceStatus {
  const provider = Boolean(config.SUPABASE_SECRET_KEY && config.TWILIO_ACCOUNT_SID && config.TWILIO_API_KEY_SID && config.TWILIO_API_KEY_SECRET && config.TWILIO_AUTH_TOKEN);
  const voiceEnabled = Boolean(config.VOICE_ENABLED && provider && config.TWILIO_TWIML_APP_SID);
  return {
    voiceEnabled,
    smsEnabled: Boolean(config.SMS_ENABLED && provider),
    administrationEnabled: Boolean(config.SUPABASE_SECRET_KEY),
    numberPurchaseEnabled: voiceEnabled && config.API_PUBLIC_URL.startsWith("https://") && !config.OPERATIONS_PAUSED,
    operationsPaused: Boolean(config.OPERATIONS_PAUSED),
    pauseMessage: config.OPERATIONS_PAUSED ? config.OPERATIONS_PAUSE_MESSAGE : null,
  };
}
