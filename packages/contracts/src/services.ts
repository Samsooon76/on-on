import { z } from "zod";

// Configuration readiness, not a claim that the provider is reachable.
export const serviceStatusSchema = z.object({
  voiceEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  administrationEnabled: z.boolean(),
  numberPurchaseEnabled: z.boolean(),
  operationsPaused: z.boolean(),
  pauseMessage: z.string().nullable(),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
