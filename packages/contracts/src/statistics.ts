/** Historical analytics. Missing measurements stay null, never become zero. */
export type StatisticsCall = {
  id: string;
  lineId: string;
  remoteNumber: string;
  createdAt: string;
  direction: "inbound" | "outbound";
  status: string;
  resultCode: string | null;
  connected: boolean;
  ended: boolean;
  durationSeconds: number | null;
  userIds: string[];
  routing: "direct" | "ivr" | "center";
  transfers: number;
  voicemailCount: number;
  voicemailSeconds: number;
};

export type StatisticsSnapshot = {
  fetchedAt: string;
  from: string;
  to: string;
  calls: StatisticsCall[];
  users: { id: string; name: string }[];
  lines: { id: string; number: string }[];
  /** Current queue membership, not historical team or queue attribution. */
  teams: { id: string; name: string; userIds: string[] }[];
};
