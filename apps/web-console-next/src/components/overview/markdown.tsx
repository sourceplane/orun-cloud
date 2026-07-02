"use client";

/**
 * Sanitized markdown renderer for repo-authored content (saas-workspace-overview
 * WO5). The overview doc is untrusted-ish — anyone who can PR the repo can edit
 * it — so the pipeline (design.md §2):
 *  - disallows raw embedded HTML (rehype-sanitize with the default GitHub-ish
 *    schema; no `dangerouslySetInnerHTML`),
 *  - forces `rel="noopener nofollow ugc"` + `target="_blank"` on links,
 *  - does not auto-load remote images (they render as a plain link to the src),
 *  - renders inside a width-constrained prose container with the console type
 *    scale (no author-controlled fonts/colours).
 */

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "@/lib/cn";

const PROSE =
  "max-w-none text-sm leading-relaxed text-foreground/90 " +
  "[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight " +
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold " +
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 " +
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] " +
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3 " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground " +
  "[&_table]:my-3 [&_table]:w-full [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 " +
  "[&_hr]:my-5 [&_hr]:border-border [&_img]:hidden";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener nofollow ugc">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
