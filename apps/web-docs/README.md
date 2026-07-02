# @saas/web-docs

The Orun Cloud documentation site — **docs.orun.dev**.

A Docusaurus 3 site in docs-only mode (`routeBasePath: '/'`), sharing the
orun design language: the CSS tokens in `src/css/custom.css` mirror orun's
`internal/cockpit/style.DefaultPalette`, the same way the orun docs site does.

## Local development

```bash
pnpm install
pnpm --filter @saas/web-docs dev     # live-reload dev server
pnpm --filter @saas/web-docs build   # production build → ./dist
pnpm --filter @saas/web-docs serve   # serve the production build
```

`onBrokenLinks` and `onBrokenMarkdownLinks` are set to `throw`, so a full
`build` is the link checker.

## Structure

- `docs/` — all content. The sidebar in `sidebars.js` is hand-curated and is
  the single source of truth for ordering; pages carry only `title` (and
  optionally `description`) frontmatter.
- `src/css/custom.css` — the entire design system, one file.
- `wrangler.jsonc` — static-assets Worker config. `dist/` is served as-is;
  the `prod` env claims the `docs.orun.dev` custom domain.

## Deployment

This component deploys through Orun like everything else in the repo — no
bespoke CI. `component.yaml` declares the `cloudflare-worker-turbo` type;
pull requests build and dry-run the Worker, merges to `main` deploy and
smoke-test `https://docs.orun.dev/`.
