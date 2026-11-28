export type NotesRecordingStatus = "waiting" | "connected" | "pending" | "denied" | "error";

export interface CallShortsSnapshot {
  notes: NotesRecordingStatus;
  inbox: string;
  inboxCount: number | null;
  recent: { name: string; status: string }[];
}

export interface CallShortsPipelineBridge {
  status(): Promise<CallShortsSnapshot>;
}

export const callNotesPrefix = "Call with ";
export interface CallNoteRecording {
  id: string;
  createdAt: string;
  available: boolean;
}
export interface CallNotesTranscription {
  name: string;
  textPath: string;
  subtitlePath: string;
}
export interface RecentCallNotesBridge {
  preview(prefix: string): Promise<CallNoteRecording[]>;
  transcribe(input: { prefix: string; ids: string[] }): Promise<CallNotesTranscription[]>;
  reveal(): Promise<void>;
}

export type CallShortsBridge = CallShortsPipelineBridge & (RecentCallNotesBridge | { preview?: never });
