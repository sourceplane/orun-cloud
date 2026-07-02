/**
 * Orun Cloud docs — information architecture.
 *
 * The sidebar is the reader's journey, ordered the way a mature product
 * documents itself: get started fast, learn the platform product by
 * product, then drop into the API/SDK/CLI reference, the security model,
 * and finally how to run the whole platform yourself.
 */
const sidebars = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      collapsed: false,
      items: [
        'getting-started/what-is-orun-cloud',
        'getting-started/quickstart',
        'getting-started/console',
        'getting-started/vocabulary',
      ],
    },
    {
      type: 'category',
      label: 'Platform',
      collapsed: false,
      items: [
        {
          type: 'category',
          label: 'Identity & authentication',
          items: [
            'platform/identity/authentication',
            'platform/identity/api-keys',
            'platform/identity/cli-and-ci-auth',
          ],
        },
        {
          type: 'category',
          label: 'Workspaces & membership',
          items: [
            'platform/workspaces/organizations',
            'platform/workspaces/members-and-invitations',
            'platform/workspaces/teams',
          ],
        },
        'platform/access-control/rbac',
        'platform/projects/projects-and-environments',
        {
          type: 'category',
          label: 'Configuration',
          items: [
            'platform/configuration/settings-and-feature-flags',
            'platform/configuration/secrets',
          ],
        },
        'platform/audit/audit-log',
        'platform/metering/usage-and-quotas',
        {
          type: 'category',
          label: 'Billing',
          items: [
            'platform/billing/plans-and-entitlements',
            'platform/billing/checkout-and-portal',
          ],
        },
        {
          type: 'category',
          label: 'Webhooks',
          items: [
            'platform/webhooks/overview',
            'platform/webhooks/verifying-deliveries',
            'platform/webhooks/retries-and-replay',
          ],
        },
        'platform/notifications/email',
        'platform/integrations/github',
        'platform/state-plane/overview',
      ],
    },
    {
      type: 'category',
      label: 'API',
      items: [
        'api/overview',
        'api/authentication',
        'api/errors',
        'api/pagination',
        'api/idempotency',
        'api/rate-limits',
        {
          type: 'category',
          label: 'Resources',
          items: [
            'api/resources/organizations',
            'api/resources/members-and-invitations',
            'api/resources/teams',
            'api/resources/api-keys',
            'api/resources/projects-and-environments',
            'api/resources/config',
            'api/resources/audit',
            'api/resources/usage',
            'api/resources/billing',
            'api/resources/webhooks',
            'api/resources/notifications',
            'api/resources/integrations',
            'api/resources/state',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Developers',
      items: ['developers/sdk', 'developers/cli'],
    },
    'security/security-model',
    {
      type: 'category',
      label: 'Run your own',
      items: [
        'self-hosting/architecture',
        'self-hosting/deploy-your-own',
        'self-hosting/operations',
      ],
    },
  ],
};

export default sidebars;
