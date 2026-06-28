/**
 * Catalog-portal markdown renderer (saas-catalog-portal CP5).
 *
 * Renders the typed block/span tree from `lib/catalog-portal/markdown` with the
 * exact type ramp, spacing and code/quote treatment of the design's README
 * pane. Presentational and pure — it never parses or fetches; it walks the
 * already-parsed `MdBlock[]` so the Overview and Docs panes share one renderer.
 */

import * as React from "react";
import type { MdBlock, MdSpan } from "@/lib/catalog-portal/markdown";

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((sp, i) => {
        switch (sp.kind) {
          case "bold":
            return (
              <strong key={i} className="font-semibold text-[#e4e4e7]">
                {sp.text}
              </strong>
            );
          case "em":
            return (
              <em key={i} className="text-[#a1a1aa]">
                {sp.text}
              </em>
            );
          case "code":
            return (
              <code
                key={i}
                className="rounded border border-[#232327] bg-[#161619] px-[5px] py-px font-mono text-[11.5px] text-[#fcd34d]"
              >
                {sp.text}
              </code>
            );
          case "link":
            return (
              <span key={i} className="text-[#f59e0b]">
                {sp.text}
              </span>
            );
          default:
            return <React.Fragment key={i}>{sp.text}</React.Fragment>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "heading":
      if (block.level === 1) {
        return <div className="text-[20px] font-semibold tracking-[-0.01em] text-[#fafafa]">{block.text}</div>;
      }
      if (block.level === 2) {
        return (
          <div className="mt-3.5 border-b border-b-[#18181b] pb-[7px] text-[14px] font-semibold text-[#e4e4e7]">
            {block.text}
          </div>
        );
      }
      return <div className="mt-2 text-[12.5px] font-semibold text-[#d4d4d8]">{block.text}</div>;
    case "para":
      return (
        <p className="m-0 text-[13px] leading-[1.7] text-[#a1a1aa]">
          <Spans spans={block.spans} />
        </p>
      );
    case "bullet":
      return (
        <div className="flex gap-2.5">
          <span className="min-w-[14px] font-mono text-[12px] leading-[1.7] text-[#52525b]">{block.marker}</span>
          <p className="m-0 text-[13px] leading-[1.7] text-[#a1a1aa]">
            <Spans spans={block.spans} />
          </p>
        </div>
      );
    case "code":
      return (
        <pre className="my-[3px] overflow-x-auto whitespace-pre rounded-[9px] border border-[#1c1c20] bg-[#08080a] px-[15px] py-[13px] font-mono text-[12px] leading-[1.65] text-[#d4d4d8]">
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <div className="border-l-2 border-l-[#f59e0b] py-[3px] pl-3.5">
          <p className="m-0 text-[12.5px] italic leading-[1.65] text-[#a1a1aa]">
            <Spans spans={block.spans} />
          </p>
        </div>
      );
    default:
      return null;
  }
}

/** Render a parsed markdown document with the design's README styling. */
export function MarkdownView({ blocks }: { blocks: MdBlock[] }) {
  return (
    <div className="flex flex-col gap-[9px]">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
