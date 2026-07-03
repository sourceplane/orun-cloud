import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const config = {
  title: 'Orun Cloud',
  tagline:
    'The managed control plane for platform delivery. Workspaces, remote state, live runs, and a service catalog — with identity, access control, billing, and webhooks built in.',
  url: 'https://docs.orun.dev',
  baseUrl: '/',
  favicon: 'img/favicon.svg',
  organizationName: 'sourceplane',
  projectName: 'orun-cloud',
  onBrokenLinks: 'throw',
  onDuplicateRoutes: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],
  themeConfig: {
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
    metadata: [
      { name: 'theme-color', content: '#f59e0b' },
      {
        name: 'description',
        content:
          'Orun Cloud documentation — workspaces, projects, environments, access control, audit, metering, billing, webhooks, the API, the TypeScript SDK, and the orun-cloud CLI.',
      },
    ],
    navbar: {
      title: 'orun cloud',
      items: [
        { to: '/', label: 'Docs', position: 'left' },
        { to: '/getting-started/quickstart', label: 'Quickstart', position: 'left' },
        { to: '/api/overview', label: 'API', position: 'left' },
        { to: '/developers/sdk', label: 'SDK', position: 'left' },
        { to: '/developers/cli', label: 'CLI', position: 'left' },
        { href: 'https://orun-docs.pages.dev', label: 'orun docs', position: 'right' },
        { href: 'https://app.orun.dev', label: 'Console', position: 'right' },
        {
          href: 'https://github.com/sourceplane/orun-cloud',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Get started',
          items: [
            { label: 'What is Orun Cloud?', to: '/getting-started/what-is-orun-cloud' },
            { label: 'Quickstart', to: '/getting-started/quickstart' },
            { label: 'The console', to: '/getting-started/console' },
            { label: 'Vocabulary', to: '/getting-started/vocabulary' },
          ],
        },
        {
          title: 'Platform',
          items: [
            { label: 'Authentication', to: '/platform/identity/authentication' },
            { label: 'Access control', to: '/platform/access-control/rbac' },
            { label: 'Projects & environments', to: '/platform/projects/projects-and-environments' },
            { label: 'Webhooks', to: '/platform/webhooks/overview' },
            { label: 'Billing', to: '/platform/billing/plans-and-entitlements' },
            { label: 'State plane', to: '/platform/state-plane/overview' },
          ],
        },
        {
          title: 'Develop',
          items: [
            { label: 'API reference', to: '/api/overview' },
            { label: 'Errors', to: '/api/errors' },
            { label: 'TypeScript SDK', to: '/developers/sdk' },
            { label: 'CLI', to: '/developers/cli' },
          ],
        },
        {
          title: 'Ecosystem',
          items: [
            { label: 'orun — the intent compiler', href: 'https://orun-docs.pages.dev' },
            { label: 'Run your own', to: '/self-hosting/deploy-your-own' },
            { label: 'Console', href: 'https://app.orun.dev' },
            { label: 'GitHub', href: 'https://github.com/sourceplane/orun-cloud' },
          ],
        },
      ],
      copyright: `▲ orun cloud · © ${new Date().getFullYear()} sourceplane contributors`,
    },
    prism: {
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  },
};

export default config;
