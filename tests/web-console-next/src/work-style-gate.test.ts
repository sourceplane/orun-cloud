// The WV-5 style gate (orun-work-v5 WV6, CI-enforced): Work components
// compose Northwind primitives and tokens ONLY — no raw hex colors and no
// ad-hoc dark: color forks in src/components/work/. One design language;
// if a color is worth having, it is worth naming in globals.css.

import * as fs from "node:fs";
import * as path from "node:path";

// jest runs with cwd = tests/web-console-next (rootDir)
const WORK_DIR = path.resolve(process.cwd(), "../../apps/web-console-next/src/components/work");

function workFiles(): string[] {
  const entries: string[] = fs.readdirSync(WORK_DIR);
  return entries
    .filter((f: string) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f: string) => path.join(WORK_DIR, f));
}

describe("WV-5 — one design language, grep-gated", () => {
  it("finds the Work component directory", () => {
    expect(workFiles().length).toBeGreaterThan(5);
  });

  it("no raw hex colors in src/components/work/", () => {
    const offenders: string[] = [];
    for (const file of workFiles()) {
      const text: string = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line: string, i: number) => {
        if (/#[0-9A-Fa-f]{6}\b/.test(line)) {
          offenders.push(`${path.basename(file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no per-surface dark-mode color forks (tokens theme both modes)", () => {
    const offenders: string[] = [];
    for (const file of workFiles()) {
      const text: string = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line: string, i: number) => {
        if (/dark:(bg|text|border)-\[/.test(line)) {
          offenders.push(`${path.basename(file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
