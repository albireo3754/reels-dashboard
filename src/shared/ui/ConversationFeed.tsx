import { Fragment } from "react";
import {
  conversationDay,
  conversationRows,
  conversationTime,
  type ConversationMessage,
} from "../lib/conversation";
import { MarkdownView } from "./MarkdownView";
import "./conversation.css";

export function ConversationFeed({
  messages,
  label,
}: {
  messages: ConversationMessage[];
  label: string;
}) {
  return (
    <ol className="conversation-feed" aria-label={label}>
      {conversationRows(messages).map(({ message, showDay, grouped }) => (
        <Fragment key={message.id}>
          {showDay && (
            <li className="conversation-day">
              <span>{conversationDay(message.at)}</span>
            </li>
          )}
          <li
            className="conversation-row"
            data-grouped={grouped}
            data-state={message.tone ?? "neutral"}
          >
            <div className="conversation-gutter" aria-hidden="true">
              {grouped ? (
                <span className="conversation-hover-time">
                  {conversationTime(message.at)}
                </span>
              ) : (
                <span className="conversation-avatar">{message.avatar}</span>
              )}
            </div>
            <div className="conversation-body">
              {!grouped && (
                <header>
                  <strong>{message.senderLabel}</strong>
                  <time dateTime={message.at}>
                    {conversationTime(message.at)}
                  </time>
                </header>
              )}
              {grouped && (
                <span className="conversation-sr-only">
                  {message.senderLabel} · {conversationTime(message.at)}
                </span>
              )}
              {message.title && (
                <div className="conversation-title">{message.title}</div>
              )}
              <MarkdownView>{message.body}</MarkdownView>
              {message.status && (
                <div className="conversation-status">{message.status}</div>
              )}
              {!!message.evidence?.length && (
                <ul
                  className="conversation-evidence"
                  aria-label="결과 근거 파일"
                >
                  {message.evidence.map((file) => (
                    <li key={file}>
                      <code>{file}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
