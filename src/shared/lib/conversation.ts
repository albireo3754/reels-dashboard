export interface ConversationMessage {
  id: string;
  sender: string;
  senderLabel: string;
  avatar: string;
  at: string;
  body: string;
  title?: string;
  status?: string;
  tone?: "neutral" | "success" | "warning" | "error";
  evidence?: string[];
}

/** Group only adjacent messages; never reorder a persisted execution history. */
export function conversationRows(messages: readonly ConversationMessage[]) {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const currentDate = new Date(message.at);
    const previousDate = previous && new Date(previous.at);
    const valid = Number.isFinite(currentDate.getTime());
    const sameDay =
      valid &&
      previousDate &&
      Number.isFinite(previousDate.getTime()) &&
      currentDate.toDateString() === previousDate.toDateString();
    const gap = previousDate
      ? currentDate.getTime() - previousDate.getTime()
      : NaN;
    return {
      message,
      showDay: valid && !sameDay,
      grouped: Boolean(
        sameDay &&
          previous?.sender === message.sender &&
          gap >= 0 &&
          gap < 5 * 60 * 1000,
      ),
    };
  });
}

export function conversationDay(at: string, now = new Date()): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "날짜 미확인";
  if (date.toDateString() === now.toDateString()) return "오늘";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "어제";
  return new Intl.DateTimeFormat("ko-KR", {
    ...(date.getFullYear() !== now.getFullYear()
      ? { year: "numeric" as const }
      : {}),
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

export function conversationTime(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : "시간 미확인";
}

/** Markdown in local job reports cannot navigate to files or executable URLs. */
export function safeMarkdownUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
