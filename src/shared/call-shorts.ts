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
export interface CallShortsBridge {
  preview(prefix: string): Promise<CallNoteRecording[]>;
  transcribe(input: { prefix: string; ids: string[] }): Promise<CallNotesTranscription[]>;
  reveal(): Promise<void>;
}
