import twilio from "twilio";
import { ivrConfigSchema } from "@onoff/contracts";

/** Return menu TwiML only when the database asks us to collect a choice. */
export function renderIvr(routing: { ivr?: unknown; attempt?: number; hangup?: boolean; language?: string }, callbackBase: string): string | null {
  const voice = new twilio.twiml.VoiceResponse();
  if (routing.hangup) {
    voice.say({ language: routing.language === "fr-FR" ? "fr-FR" : "en-GB" }, routing.language === "fr-FR" ? "Nous n’avons pas reçu de choix valide. Au revoir." : "We did not receive a valid selection. Goodbye.");
    voice.hangup();
    return voice.toString();
  }
  if (!routing.ivr) return null;
  const config = ivrConfigSchema.parse(routing.ivr);
  const attempt = routing.attempt ?? 0;
  const french = config.language === "fr-FR";
  const gather = voice.gather({ input: ["dtmf"], numDigits: 1, timeout: config.timeout, actionOnEmptyResult: true, method: "POST", action: `${callbackBase}/webhooks/twilio/voice/ivr?attempt=${attempt + 1}` });
  if (attempt > 0) gather.say({ language: config.language }, french ? "Choix non reconnu. Veuillez réessayer." : "Invalid selection. Please try again.");
  gather.say({ language: config.language }, config.greeting);
  for (const option of config.options) gather.say({ language: config.language }, french ? `Pour ${option.label}, tapez ${option.digit}.` : `For ${option.label}, press ${option.digit}.`);
  return voice.toString();
}
