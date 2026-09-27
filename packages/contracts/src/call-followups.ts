import { z } from "zod";

export const callFollowupInputSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["ticket", "deal"]),
  title: z.string().trim().min(1, "Saisissez un titre.").max(160),
  description: z.string().trim().max(5000).default(""),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  amount: z.number().min(0).max(999999999).multipleOf(0.01).nullable().default(null),
  contactId: z.string().uuid().nullable().default(null),
  callId: z.string().uuid().optional(),
  providerCallSid: z.string().regex(/^CA[0-9a-fA-F]{32}$/).optional(),
  intentId: z.string().uuid().optional(),
}).strict().refine(value => Boolean(value.callId || value.providerCallSid || value.intentId), { message: "L’appel n’est pas encore disponible. Réessayez dans un instant." })
  .refine(value => value.kind === "deal" || value.amount === null, { message: "Le montant est réservé aux deals." });

export type CallFollowupInput = z.infer<typeof callFollowupInputSchema>;
export type CallFollowup = {
  id: string; kind: "ticket" | "deal"; title: string; description: string;
  priority: "normal" | "high" | "urgent"; amount: number | null;
  status: "open" | "closed" | "won" | "lost";
  call_id: string; contact_id: string | null; remote_number: string;
  created_at: string;
};
export type CallFollowupPage = { items: CallFollowup[]; nextCursor: string | null };
