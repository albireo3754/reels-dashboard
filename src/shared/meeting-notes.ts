export type MeetingProvider = "openai" | "claude";
export type MeetingCredit = {
  provider: MeetingProvider;
  status: "unknown" | "snapshot" | "estimated";
  enabled: boolean;
  totalUsd?: number;
  remainingUsd?: number;
  observedAt?: string;
};
export type MeetingResult = {
  provider: MeetingProvider | "codex-session";
  text: string;
};
export interface MeetingNotesBridge {
  credits(): Promise<MeetingCredit[]>;
  transcribe(context: string): Promise<MeetingResult | null>;
  summarize(input: { context: string; transcript: string; allowCodexSession: boolean }): Promise<MeetingResult>;
}
