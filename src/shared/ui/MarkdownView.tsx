import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { safeMarkdownUrl } from "../lib/conversation";
import "./markdown.css";

/** Reports are Markdown, never trusted HTML; remote images are not fetched. */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="report-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => (
            <span className="report-image-label">
              [이미지: {alt || "설명 없음"}]
            </span>
          ),
          table: ({ children }) => (
            <div className="report-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
