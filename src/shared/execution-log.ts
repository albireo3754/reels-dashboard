export type ExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted";
export interface ExecutionLog {
  id: string;
  source: string;
  label: string;
  projectId?: string;
  jobId?: string;
  executable: string;
  pid?: number;
  status: ExecutionStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  progress?: number;
  exitCode?: number;
  signal?: string;
  persistenceError?: string;
  output: string;
  events: { at: string; message: string }[];
}
export type ExecutionStart = Pick<
  ExecutionLog,
  "source" | "label" | "executable" | "projectId" | "jobId"
>;
export interface ExecutionLogBridge {
  list(): Promise<ExecutionLog[]>;
}
export const executionStatusLabels: Record<ExecutionStatus, string> = {
  running: "실행 중",
  completed: "프로세스 완료",
  failed: "실패",
  interrupted: "관측 중단",
};
