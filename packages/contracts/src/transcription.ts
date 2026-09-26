import { z } from "zod";

export const transcriptSegmentSchema = z.object({
  id: z.string(),
  speaker: z.enum(["local", "remote"]),
  text: z.string(),
  offsetMs: z.number().nonnegative(),
});
export const callTranscriptSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["starting", "live", "stopping", "completed", "error"]),
  startedAt: z.string(),
  updatedAt: z.string(),
  segments: z.array(transcriptSegmentSchema),
  partials: z.object({ local: transcriptSegmentSchema.nullable(), remote: transcriptSegmentSchema.nullable() }),
  error: z.string().nullable(),
});
export const transcriptionResponseSchema = z.object({
  available: z.boolean(),
  callId: z.string().uuid(),
  callActive: z.boolean(),
  transcript: callTranscriptSchema.nullable(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type CallTranscript = z.infer<typeof callTranscriptSchema>;
export type TranscriptionResponse = z.infer<typeof transcriptionResponseSchema>;
