import type { SqlExecutor } from "../hyperdrive/executor.js";
import type {
  AcceptInvitationByIdInput,
  AcceptInvitationInput,
  BootstrapOrganizationInput,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateOrganizationMemberInput,
  CreateRoleAssignmentInput,
  CursorPosition,
  MembershipRepository,
  MembershipResult,
  Organization,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationWithRole,
  PagedResult,
  PendingInvitationForEmail,
  PageQueryParams,
  RoleAssignment,
  Team,
  TeamMember,
  CreateTeamInput,
  UpdateTeamInput,
  CreateTeamMemberInput,
  TeamOwnerHandle,
  UpsertTeamOwnerHandleInput,
} from "./types.js";

function mapOrganization(row: Record<string, unknown>): Organization {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    slugLower: row.slug_lower as string,
    publicRef: row.public_ref as string,
    status: row.status as string,
    parentOrgId: (row.parent_org_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapMember(row: Record<string, unknown>): OrganizationMember {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    subjectId: row.subject_id as string,
    subjectType: row.subject_type as string,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapInvitation(row: Record<string, unknown>): OrganizationInvitation {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    email: row.email as string,
    emailLower: row.email_lower as string,
    role: row.role as string,
    status: row.status as string,
    invitedBy: row.invited_by as string,
    expiresAt: new Date(row.expires_at as string),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at as string) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

function mapRoleAssignment(row: Record<string, unknown>): RoleAssignment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    subjectId: row.subject_id as string,
    subjectType: row.subject_type as string,
    role: row.role as string,
    scopeKind: row.scope_kind as string,
    scopeRef: (row.scope_ref as string) ?? null,
    createdAt: new Date(row.created_at as string),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
  };
}

function mapTeam(row: Record<string, unknown>): Team {
  return {
    id: row.id as string,
    accountOrgId: row.account_org_id as string,
    name: row.name as string,
    slugLower: row.slug_lower as string,
    handle: (row.handle as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    avatarRef: (row.avatar_ref as string | null) ?? null,
    status: row.status as string,
    ...(row.member_count != null ? { memberCount: Number(row.member_count) } : {}),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapTeamMember(row: Record<string, unknown>): TeamMember {
  return {
    teamId: row.team_id as string,
    subjectId: row.subject_id as string,
    subjectType: row.subject_type as string,
    teamRole: (row.team_role as string | null) ?? "team_member",
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
  };
}

function mapTeamOwnerHandle(row: Record<string, unknown>): TeamOwnerHandle {
  return {
    accountOrgId: row.account_org_id as string,
    ownerHandle: row.owner_handle as string,
    teamId: row.team_id as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function safeError(message: string, cause?: unknown): MembershipResult<never> {
  // Surface the underlying DB error so failures are diagnosable in `wrangler
  // tail` instead of silently collapsing into an opaque internal error. Only
  // the error's name/message/code are logged — never query parameters — so no
  // ids, tokens, or secret material leak into logs.
  if (cause !== undefined) {
    const e = cause as { name?: unknown; message?: unknown; code?: unknown };
    console.error(`[membership-repo] ${message}`, {
      name: typeof e?.name === "string" ? e.name : undefined,
      message: typeof e?.message === "string" ? e.message : undefined,
      code: typeof e?.code === "string" ? e.code : undefined,
    });
  }
  return { ok: false, error: { kind: "internal", message } };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

export function createMembershipRepository(executor: SqlExecutor): MembershipRepository {
  return {
    async createOrganization(input: CreateOrganizationInput): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.organizations (id, name, slug, slug_lower, public_ref, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $6, $5, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.name, input.slug, input.slugLower, input.createdAt.toISOString(), input.publicRef],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        return safeError("Failed to create organization", err);
      }
    },

    async getOrganizationById(id: string): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.organizations WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get organization", err);
      }
    },

    async getOrganizationsByIds(ids: string[]): Promise<MembershipResult<Array<{ id: string; publicRef: string }>>> {
      if (ids.length === 0) {
        return { ok: true, value: [] };
      }
      try {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, public_ref FROM membership.organizations WHERE id IN (${placeholders})`,
          ids,
        );
        return {
          ok: true,
          value: result.rows.map((row) => ({
            id: row.id as string,
            publicRef: row.public_ref as string,
          })),
        };
      } catch (err) {
        return safeError("Failed to get organizations by ids", err);
      }
    },

    async getOrganizationBySlug(slugLower: string): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.organizations WHERE slug_lower = $1`,
          [slugLower],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get organization by slug", err);
      }
    },

    async getOrganizationByPublicRef(publicRef: string): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.organizations WHERE public_ref = $1`,
          [publicRef],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get organization by public ref", err);
      }
    },

    async listChildOrganizations(parentOrgId: string): Promise<MembershipResult<Organization[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.organizations WHERE parent_org_id = $1 ORDER BY created_at ASC`,
          [parentOrgId],
        );
        return { ok: true, value: result.rows.map(mapOrganization) };
      } catch (err) {
        return safeError("Failed to list child organizations", err);
      }
    },

    async setOrganizationStatus(orgId: string, status: string, updatedAt: Date): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.organizations SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
          [orgId, status, updatedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to set organization status", err);
      }
    },

    async listOrganizationsForSubject(subjectId: string): Promise<MembershipResult<Organization[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT o.* FROM membership.organizations o
           INNER JOIN membership.organization_members m ON m.org_id = o.id
           WHERE m.subject_id = $1 AND m.status = 'active'`,
          [subjectId],
        );
        return { ok: true, value: result.rows.map(mapOrganization) };
      } catch (err) {
        return safeError("Failed to list organizations for subject", err);
      }
    },

    async listOrganizationsWithRoleForSubject(subjectId: string): Promise<MembershipResult<OrganizationWithRole[]>> {
      try {
        // LEFT JOIN the active org-scoped role assignment so a member without an
        // explicit role still appears (falls back to 'viewer'). The ROLE_RANK
        // ordering surfaces the strongest role first; DISTINCT ON keeps one row
        // per org (a subject can hold at most a few org-scoped roles).
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT ON (o.id) o.*, ra.role AS member_role
           FROM membership.organizations o
           INNER JOIN membership.organization_members m
             ON m.org_id = o.id AND m.subject_id = $1 AND m.status = 'active'
           LEFT JOIN membership.role_assignments ra
             ON ra.org_id = o.id AND ra.subject_id = $1
             AND ra.scope_kind = 'organization' AND ra.revoked_at IS NULL
           ORDER BY o.id,
             CASE ra.role
               WHEN 'owner' THEN 0
               WHEN 'admin' THEN 1
               WHEN 'builder' THEN 2
               WHEN 'billing_admin' THEN 3
               WHEN 'viewer' THEN 4
               ELSE 5
             END`,
          [subjectId],
        );
        const orgs = result.rows.map((row) => ({
          ...mapOrganization(row),
          role: (row.member_role as string) ?? "viewer",
        }));
        // Newest first, matching the console org listing convention.
        orgs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { ok: true, value: orgs };
      } catch (err) {
        return safeError("Failed to list organizations with role for subject", err);
      }
    },

    async listOrganizationsForSubjectPaged(subjectId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<Organization>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT o.* FROM membership.organizations o
           INNER JOIN membership.organization_members m ON m.org_id = o.id
           WHERE m.subject_id = $1 AND m.status = 'active'
             AND (o.created_at, o.id) < ($3, $4)
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT $2`;
          values = [subjectId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT o.* FROM membership.organizations o
           INNER JOIN membership.organization_members m ON m.org_id = o.id
           WHERE m.subject_id = $1 AND m.status = 'active'
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT $2`;
          values = [subjectId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapOrganization);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch (err) {
        return safeError("Failed to list organizations for subject", err);
      }
    },

    async bootstrapOrganization(input: BootstrapOrganizationInput): Promise<MembershipResult<{ org: Organization; member: OrganizationMember; roleAssignment: RoleAssignment }>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `WITH new_org AS (
            INSERT INTO membership.organizations (id, name, slug, slug_lower, public_ref, parent_org_id, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $20, $19, $5, $5)
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          ),
          new_member AS (
            INSERT INTO membership.organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
            SELECT $6, $7, $8, $9, $10, $10
            FROM new_org
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          ),
          new_role AS (
            INSERT INTO membership.role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
            SELECT $11, $12, $13, $14, $15, $16, $17, $18
            FROM new_member
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          )
          SELECT
            row_to_json(o.*) as org,
            row_to_json(m.*) as member,
            row_to_json(r.*) as role_assignment
          FROM new_org o
          CROSS JOIN new_member m
          CROSS JOIN new_role r`,
          [
            input.org.id, input.org.name, input.org.slug, input.org.slugLower, input.org.createdAt.toISOString(),
            input.member.id, input.member.orgId, input.member.subjectId, input.member.subjectType, input.member.createdAt.toISOString(),
            input.roleAssignment.id, input.roleAssignment.orgId, input.roleAssignment.subjectId, input.roleAssignment.subjectType, input.roleAssignment.role, input.roleAssignment.scopeKind, input.roleAssignment.scopeRef ?? null, input.roleAssignment.createdAt.toISOString(),
            input.org.parentOrgId ?? null,
            input.org.publicRef,
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            org: mapOrganization(parseJsonColumn(row.org)),
            member: mapMember(parseJsonColumn(row.member)),
            roleAssignment: mapRoleAssignment(parseJsonColumn(row.role_assignment)),
          },
        };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        return safeError("Failed to bootstrap organization", err);
      }
    },

    async createMember(input: CreateOrganizationMemberInput): Promise<MembershipResult<OrganizationMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.subjectId, input.subjectType, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return { ok: true, value: mapMember(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return safeError("Failed to create member", err);
      }
    },

    async getMemberById(orgId: string, memberId: string): Promise<MembershipResult<OrganizationMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.organization_members WHERE org_id = $1 AND id = $2`,
          [orgId, memberId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const member = mapMember(result.rows[0]!);
        if (member.status === "removed") {
          return { ok: false, error: { kind: "removed" } };
        }
        return { ok: true, value: member };
      } catch (err) {
        return safeError("Failed to get member", err);
      }
    },

    async listMembers(orgId: string): Promise<MembershipResult<OrganizationMember[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.organization_members WHERE org_id = $1 AND status = 'active'`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapMember) };
      } catch (err) {
        return safeError("Failed to list members", err);
      }
    },

    async listMembersPaged(orgId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationMember>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT * FROM membership.organization_members
           WHERE org_id = $1 AND status = 'active'
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT * FROM membership.organization_members
           WHERE org_id = $1 AND status = 'active'
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapMember);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch (err) {
        return safeError("Failed to list members", err);
      }
    },

    async removeMember(orgId: string, memberId: string, updatedAt: Date): Promise<MembershipResult<OrganizationMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.organization_members
           SET status = 'removed', updated_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING *`,
          [orgId, memberId, updatedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapMember(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to remove member", err);
      }
    },

    async createInvitation(input: CreateInvitationInput): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.organization_invitations (id, org_id, email, email_lower, role, token_hash, invited_by, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at`,
          [input.id, input.orgId, input.email, input.emailLower, input.role, input.tokenHash, input.invitedBy, input.expiresAt.toISOString(), input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "invitation" } };
        }
        return { ok: true, value: mapInvitation(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "invitation" } };
        }
        return safeError("Failed to create invitation", err);
      }
    },

    async getInvitationById(orgId: string, invitationId: string): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations WHERE org_id = $1 AND id = $2`,
          [orgId, invitationId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(result.rows[0]!);
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: inv };
      } catch (err) {
        return safeError("Failed to get invitation", err);
      }
    },

    async getInvitationByTokenHash(tokenHash: string): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations WHERE token_hash = $1`,
          [tokenHash],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(result.rows[0]!);
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: inv };
      } catch (err) {
        return safeError("Failed to get invitation by token", err);
      }
    },

    async listInvitations(orgId: string): Promise<MembershipResult<OrganizationInvitation[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations WHERE org_id = $1`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapInvitation) };
      } catch (err) {
        return safeError("Failed to list invitations", err);
      }
    },

    async listInvitationsPaged(orgId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationInvitation>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations
           WHERE org_id = $1
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations
           WHERE org_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapInvitation);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch (err) {
        return safeError("Failed to list invitations", err);
      }
    },

    async listPendingInvitationsByEmail(emailLower: string): Promise<MembershipResult<PendingInvitationForEmail[]>> {
      try {
        // Discovery for the signed-in recipient: every invitation addressed to
        // their normalized email that is still actionable (pending, not
        // revoked/accepted/expired), joined with the inviting org's display
        // fields so the UI can name each workspace. Index-backed by
        // org_invitations_email_lower_only_idx (migration 450). Newest first.
        const now = new Date();
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT i.id, i.org_id, i.email, i.email_lower, i.role, i.status, i.invited_by,
                  i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
                  o.name AS org_name, o.slug AS org_slug, o.public_ref AS org_public_ref, o.status AS org_status
           FROM membership.organization_invitations i
           JOIN membership.organizations o ON o.id = i.org_id
           WHERE i.email_lower = $1
             AND i.status = 'pending'
             AND i.accepted_at IS NULL
             AND i.revoked_at IS NULL
             AND i.expires_at > $2
           ORDER BY i.created_at DESC, i.id DESC`,
          [emailLower, now.toISOString()],
        );
        const items = result.rows.map((row) => ({
          invitation: mapInvitation(row),
          org: {
            id: row.org_id as string,
            name: row.org_name as string,
            slug: row.org_slug as string,
            publicRef: row.org_public_ref as string,
            status: row.org_status as string,
          },
        }));
        return { ok: true, value: items };
      } catch (err) {
        return safeError("Failed to list pending invitations by email", err);
      }
    },

    async revokeInvitation(orgId: string, invitationId: string, revokedAt: Date): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.organization_invitations
           SET status = 'revoked', revoked_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'pending' AND revoked_at IS NULL AND accepted_at IS NULL
           RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at`,
          [orgId, invitationId, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapInvitation(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to revoke invitation", err);
      }
    },

    async acceptInvitation(input: AcceptInvitationInput): Promise<MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>> {
      try {
        const checkResult = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations WHERE token_hash = $1`,
          [input.tokenHash],
        );
        if (checkResult.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(checkResult.rows[0]!);
        if (inv.orgId !== input.orgId) {
          return { ok: false, error: { kind: "not_found" } };
        }
        if (inv.emailLower !== input.emailLower) {
          return { ok: false, error: { kind: "not_found" } };
        }
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < input.acceptedAt) {
          return { ok: false, error: { kind: "expired" } };
        }

        const result = await executor.execute<Record<string, unknown>>(
          `WITH accepted_inv AS (
            UPDATE membership.organization_invitations
            SET status = 'accepted', accepted_at = $2
            WHERE token_hash = $1 AND org_id = $3 AND email_lower = $4 AND status = 'pending' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > $2
            RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
          ),
          new_member AS (
            INSERT INTO membership.organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
            SELECT $5, org_id, $6, $7, $8, $8
            FROM accepted_inv
            RETURNING *
          ),
          new_role AS (
            INSERT INTO membership.role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
            SELECT $9, org_id, $10, $11, role, 'organization', NULL, $12
            FROM accepted_inv
            RETURNING *
          )
          SELECT
            row_to_json(ai.*) as invitation,
            row_to_json(nm.*) as member,
            row_to_json(nr.*) as role_assignment
          FROM accepted_inv ai
          CROSS JOIN new_member nm
          CROSS JOIN new_role nr`,
          [
            input.tokenHash, input.acceptedAt.toISOString(),
            input.orgId, input.emailLower,
            input.memberId, input.subjectId, input.subjectType, input.acceptedAt.toISOString(),
            input.roleAssignmentId, input.subjectId, input.subjectType, input.acceptedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            invitation: mapInvitation(parseJsonColumn(row.invitation)),
            member: mapMember(parseJsonColumn(row.member)),
            roleAssignment: mapRoleAssignment(parseJsonColumn(row.role_assignment)),
          },
        };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return safeError("Failed to accept invitation", err);
      }
    },

    async acceptInvitationById(input: AcceptInvitationByIdInput): Promise<MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>> {
      try {
        // Token-less acceptance for the signed-in recipient (saas invitation
        // login flow). Keyed on the invitation id, gated on the actor's
        // verified email matching email_lower — equivalent proof of email
        // control to the token path. Same member + role writes as
        // `acceptInvitation`; org_id is taken from the invitation row.
        const checkResult = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership.organization_invitations WHERE id = $1`,
          [input.invitationId],
        );
        if (checkResult.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(checkResult.rows[0]!);
        if (inv.emailLower !== input.emailLower) {
          return { ok: false, error: { kind: "not_found" } };
        }
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < input.acceptedAt) {
          return { ok: false, error: { kind: "expired" } };
        }

        const result = await executor.execute<Record<string, unknown>>(
          `WITH accepted_inv AS (
            UPDATE membership.organization_invitations
            SET status = 'accepted', accepted_at = $2
            WHERE id = $1 AND email_lower = $3 AND status = 'pending' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > $2
            RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
          ),
          new_member AS (
            INSERT INTO membership.organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
            SELECT $4, org_id, $5, $6, $7, $7
            FROM accepted_inv
            RETURNING *
          ),
          new_role AS (
            INSERT INTO membership.role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
            SELECT $8, org_id, $9, $10, role, 'organization', NULL, $11
            FROM accepted_inv
            RETURNING *
          )
          SELECT
            row_to_json(ai.*) as invitation,
            row_to_json(nm.*) as member,
            row_to_json(nr.*) as role_assignment
          FROM accepted_inv ai
          CROSS JOIN new_member nm
          CROSS JOIN new_role nr`,
          [
            input.invitationId, input.acceptedAt.toISOString(),
            input.emailLower,
            input.memberId, input.subjectId, input.subjectType, input.acceptedAt.toISOString(),
            input.roleAssignmentId, input.subjectId, input.subjectType, input.acceptedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            invitation: mapInvitation(parseJsonColumn(row.invitation)),
            member: mapMember(parseJsonColumn(row.member)),
            roleAssignment: mapRoleAssignment(parseJsonColumn(row.role_assignment)),
          },
        };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return safeError("Failed to accept invitation", err);
      }
    },

    async createRoleAssignment(input: CreateRoleAssignmentInput): Promise<MembershipResult<RoleAssignment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.subjectId, input.subjectType, input.role, input.scopeKind, input.scopeRef ?? null, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "role_assignment" } };
        }
        return { ok: true, value: mapRoleAssignment(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "role_assignment" } };
        }
        return safeError("Failed to create role assignment", err);
      }
    },

    async listRoleAssignments(orgId: string, subjectId: string): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.role_assignments WHERE org_id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
          [orgId, subjectId],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to list role assignments", err);
      }
    },

    // ── Account roles (teams-hub TH1a) ──────────────────────────────
    async listAccountRoleAssignments(accountOrgId: string): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.role_assignments
           WHERE org_id = $1 AND scope_kind = 'account' AND revoked_at IS NULL
           ORDER BY created_at ASC, id ASC`,
          [accountOrgId],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to list account role assignments", err);
      }
    },

    async revokeAccountRole(
      accountOrgId: string,
      subjectId: string,
      role: string,
      revokedAt: Date,
    ): Promise<MembershipResult<RoleAssignment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.role_assignments
           SET revoked_at = $4
           WHERE org_id = $1
             AND subject_id = $2
             AND subject_type = 'user'
             AND role = $3
             AND scope_kind = 'account'
             AND revoked_at IS NULL
           RETURNING *`,
          [accountOrgId, subjectId, role, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRoleAssignment(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to revoke account role", err);
      }
    },

    async listRoleAssignmentsForSubjects(
      orgId: string,
      subjectIds: string[],
    ): Promise<MembershipResult<Map<string, RoleAssignment[]>>> {
      const map = new Map<string, RoleAssignment[]>();
      if (subjectIds.length === 0) return { ok: true, value: map };
      try {
        // PERF3 (task 0132): one batched query instead of N per-member queries.
        // NOTE: use a parameterized IN (...) list of scalar text params rather
        // than `= ANY($2)` with a JS array. The pg driver runs with
        // `fetch_types: false` (executor.ts), which leaves array parameters
        // without a resolvable element-type OID and makes `ANY($array)` throw
        // at bind time — that surfaced as a hard 500 on the members list. A
        // scalar IN list avoids array serialization entirely.
        const placeholders = subjectIds.map((_, i) => `$${i + 2}`).join(", ");
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.role_assignments
           WHERE org_id = $1 AND subject_id IN (${placeholders}) AND revoked_at IS NULL`,
          [orgId, ...subjectIds],
        );
        for (const id of subjectIds) map.set(id, []);
        for (const row of result.rows) {
          const ra = mapRoleAssignment(row);
          const bucket = map.get(ra.subjectId);
          if (bucket) bucket.push(ra);
          else map.set(ra.subjectId, [ra]);
        }
        return { ok: true, value: map };
      } catch (err) {
        return safeError("Failed to list role assignments for subjects", err);
      }
    },

    async revokeRoleAssignment(orgId: string, assignmentId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.role_assignments
           SET revoked_at = $3
           WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, assignmentId, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapRoleAssignment(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to revoke role assignment", err);
      }
    },

    async revokeAllRoleAssignments(orgId: string, subjectId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.role_assignments
           SET revoked_at = $3
           WHERE org_id = $1 AND subject_id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, subjectId, revokedAt.toISOString()],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to revoke all role assignments", err);
      }
    },

    // ── Teams (saas-teams TM1) ──────────────────────────────────────
    async createTeam(input: CreateTeamInput): Promise<MembershipResult<Team>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.teams (id, account_org_id, name, slug_lower, handle, description, avatar_ref, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           RETURNING *`,
          [
            input.id,
            input.accountOrgId,
            input.name,
            input.slugLower,
            input.handle ?? null,
            input.description ?? null,
            input.avatarRef ?? null,
            input.createdAt.toISOString(),
          ],
        );
        return { ok: true, value: mapTeam(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "team" } };
        }
        return safeError("Failed to create team", err);
      }
    },

    async getTeamById(id: string): Promise<MembershipResult<Team>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.teams WHERE id = $1 AND status <> 'deleted'`,
          [id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeam(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get team", err);
      }
    },

    async getTeamBySlug(accountOrgId: string, slugLower: string): Promise<MembershipResult<Team>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.teams
           WHERE account_org_id = $1 AND slug_lower = $2 AND status <> 'deleted'`,
          [accountOrgId, slugLower],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeam(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get team by slug", err);
      }
    },

    async listTeams(accountOrgId: string): Promise<MembershipResult<Team[]>> {
      try {
        // teams-platform — carry the active-member count so the Teams directory
        // renders it without an N+1 (one correlated subquery per row).
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT t.*,
                  (SELECT count(*)::int FROM membership.team_members tm
                    WHERE tm.team_id = t.id AND tm.status = 'active') AS member_count
             FROM membership.teams t
            WHERE t.account_org_id = $1 AND t.status <> 'deleted'
            ORDER BY t.created_at ASC, t.id ASC`,
          [accountOrgId],
        );
        return { ok: true, value: result.rows.map(mapTeam) };
      } catch (err) {
        return safeError("Failed to list teams", err);
      }
    },

    async updateTeam(id: string, input: UpdateTeamInput): Promise<MembershipResult<Team>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.teams
           SET name = COALESCE($2, name),
               slug_lower = COALESCE($3, slug_lower),
               handle = COALESCE($4, handle),
               description = COALESCE($5, description),
               avatar_ref = COALESCE($6, avatar_ref),
               updated_at = $7
           WHERE id = $1 AND status <> 'deleted'
           RETURNING *`,
          [
            id,
            input.name ?? null,
            input.slugLower ?? null,
            input.handle ?? null,
            input.description ?? null,
            input.avatarRef ?? null,
            input.updatedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeam(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "team" } };
        }
        return safeError("Failed to update team", err);
      }
    },

    async deleteTeam(id: string, updatedAt: Date): Promise<MembershipResult<Team>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.teams
           SET status = 'deleted', updated_at = $2
           WHERE id = $1 AND status <> 'deleted'
           RETURNING *`,
          [id, updatedAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeam(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to delete team", err);
      }
    },

    async addTeamMember(input: CreateTeamMemberInput): Promise<MembershipResult<TeamMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.team_members (team_id, subject_id, subject_type, team_role, status, created_at)
           VALUES ($1, $2, $3, $4, 'active', $5)
           ON CONFLICT (team_id, subject_id)
           DO UPDATE SET status = 'active', subject_type = EXCLUDED.subject_type, team_role = EXCLUDED.team_role
           RETURNING *`,
          [input.teamId, input.subjectId, input.subjectType, input.teamRole ?? "team_member", input.createdAt.toISOString()],
        );
        return { ok: true, value: mapTeamMember(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to add team member", err);
      }
    },

    async getTeamMember(teamId: string, subjectId: string): Promise<MembershipResult<TeamMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.team_members
           WHERE team_id = $1 AND subject_id = $2 AND status = 'active'`,
          [teamId, subjectId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeamMember(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get team member", err);
      }
    },

    async updateTeamMemberRole(teamId: string, subjectId: string, teamRole: string): Promise<MembershipResult<TeamMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.team_members
           SET team_role = $3
           WHERE team_id = $1 AND subject_id = $2 AND status = 'active'
           RETURNING *`,
          [teamId, subjectId, teamRole],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeamMember(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to update team member role", err);
      }
    },

    // ── Owner-handle map (teams-ownership TO1) ──────────────────────
    async upsertTeamOwnerHandle(input: UpsertTeamOwnerHandleInput): Promise<MembershipResult<TeamOwnerHandle>> {
      try {
        // One handle → at most one team per account (last-writer-wins on the
        // account-unique lower(owner_handle) index); the worker audits the change.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership.team_owner_handles (account_org_id, owner_handle, team_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (account_org_id, lower(owner_handle))
           DO UPDATE SET team_id = EXCLUDED.team_id, owner_handle = EXCLUDED.owner_handle, updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [input.accountOrgId, input.ownerHandle, input.teamId, input.createdAt.toISOString()],
        );
        return { ok: true, value: mapTeamOwnerHandle(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to upsert team owner handle", err);
      }
    },

    async listTeamOwnerHandles(accountOrgId: string): Promise<MembershipResult<TeamOwnerHandle[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.team_owner_handles
           WHERE account_org_id = $1
           ORDER BY lower(owner_handle) ASC`,
          [accountOrgId],
        );
        return { ok: true, value: result.rows.map(mapTeamOwnerHandle) };
      } catch (err) {
        return safeError("Failed to list team owner handles", err);
      }
    },

    async deleteTeamOwnerHandle(accountOrgId: string, ownerHandle: string): Promise<MembershipResult<TeamOwnerHandle>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM membership.team_owner_handles
           WHERE account_org_id = $1 AND lower(owner_handle) = lower($2)
           RETURNING *`,
          [accountOrgId, ownerHandle],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeamOwnerHandle(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to delete team owner handle", err);
      }
    },

    async resolveTeamOwnerHandles(accountOrgId: string, ownerHandlesLower: string[]): Promise<MembershipResult<TeamOwnerHandle[]>> {
      try {
        if (ownerHandlesLower.length === 0) return { ok: true, value: [] };
        // Parameterized IN-list (the pg driver runs fetch_types:false, so array
        // params fail at bind time — mirror listRoleAssignmentsForSubjects).
        const placeholders = ownerHandlesLower.map((_, i) => `$${i + 2}`).join(", ");
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.team_owner_handles
           WHERE account_org_id = $1 AND lower(owner_handle) IN (${placeholders})`,
          [accountOrgId, ...ownerHandlesLower],
        );
        return { ok: true, value: result.rows.map(mapTeamOwnerHandle) };
      } catch (err) {
        return safeError("Failed to resolve team owner handles", err);
      }
    },

    async removeTeamMember(teamId: string, subjectId: string): Promise<MembershipResult<TeamMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.team_members
           SET status = 'removed'
           WHERE team_id = $1 AND subject_id = $2 AND status = 'active'
           RETURNING *`,
          [teamId, subjectId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapTeamMember(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to remove team member", err);
      }
    },

    async listTeamMembers(teamId: string): Promise<MembershipResult<TeamMember[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.team_members
           WHERE team_id = $1 AND status = 'active'
           ORDER BY created_at ASC, subject_id ASC`,
          [teamId],
        );
        return { ok: true, value: result.rows.map(mapTeamMember) };
      } catch (err) {
        return safeError("Failed to list team members", err);
      }
    },

    async listTeamsForSubject(accountOrgId: string, subjectId: string): Promise<MembershipResult<Team[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT t.*
           FROM membership.teams t
           INNER JOIN membership.team_members tm
             ON tm.team_id = t.id
           WHERE t.account_org_id = $1
             AND tm.subject_id = $2
             AND tm.status = 'active'
             AND t.status <> 'deleted'
           ORDER BY t.created_at ASC, t.id ASC`,
          [accountOrgId, subjectId],
        );
        return { ok: true, value: result.rows.map(mapTeam) };
      } catch (err) {
        return safeError("Failed to list teams for subject", err);
      }
    },

    // ── Team grants (saas-teams TM2) ────────────────────────────────
    async revokeTeamGrant(
      orgId: string,
      teamPublicId: string,
      role: string,
      scopeKind: string,
      scopeRef: string | null,
      revokedAt: Date,
    ): Promise<MembershipResult<RoleAssignment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.role_assignments
           SET revoked_at = $6
           WHERE org_id = $1
             AND subject_id = $2
             AND subject_type = 'team'
             AND role = $3
             AND scope_kind = $4
             AND COALESCE(scope_ref, '') = COALESCE($5, '')
             AND revoked_at IS NULL
           RETURNING *`,
          [orgId, teamPublicId, role, scopeKind, scopeRef, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRoleAssignment(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to revoke team grant", err);
      }
    },

    async revokeAllTeamGrants(teamPublicId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership.role_assignments
           SET revoked_at = $2
           WHERE subject_id = $1
             AND subject_type = 'team'
             AND revoked_at IS NULL
           RETURNING *`,
          [teamPublicId, revokedAt.toISOString()],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to revoke all team grants", err);
      }
    },

    async listTeamGrants(teamPublicId: string): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership.role_assignments
           WHERE subject_id = $1
             AND subject_type = 'team'
             AND revoked_at IS NULL
           ORDER BY created_at ASC, id ASC`,
          [teamPublicId],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to list team grants", err);
      }
    },

    async countActiveOwners(orgId: string): Promise<MembershipResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS cnt
           FROM membership.role_assignments ra
           INNER JOIN membership.organization_members m
             ON m.org_id = ra.org_id AND m.subject_id = ra.subject_id
           WHERE ra.org_id = $1
             AND ra.role = 'owner'
             AND ra.scope_kind = 'organization'
             AND ra.revoked_at IS NULL
             AND m.status = 'active'`,
          [orgId],
        );
        const cnt = Number(result.rows[0]?.cnt ?? 0);
        return { ok: true, value: cnt };
      } catch (err) {
        return safeError("Failed to count active owners", err);
      }
    },

    async countBillableMembers(orgId: string, now: Date): Promise<MembershipResult<number>> {
      // A "billable" seat is anything that grows the active membership of an
      // organization. We count:
      //   1) active organization members; plus
      //   2) pending invitations (not accepted, not revoked, not expired).
      // The two populations are disjoint by construction: an invitation that
      // has been accepted is no longer 'pending' and instead surfaces as an
      // active organization_members row, which the first sub-count picks up.
      // Both sub-counts are evaluated in a single round-trip to keep this
      // helper cheap enough to call on the create-invitation hot path.
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT
             (SELECT COUNT(*) FROM membership.organization_members
                WHERE org_id = $1 AND status = 'active')
             +
             (SELECT COUNT(*) FROM membership.organization_invitations
                WHERE org_id = $1
                  AND status = 'pending'
                  AND revoked_at IS NULL
                  AND accepted_at IS NULL
                  AND expires_at > $2)
             AS cnt`,
          [orgId, now.toISOString()],
        );
        const cnt = Number(result.rows[0]?.cnt ?? 0);
        return { ok: true, value: cnt };
      } catch (err) {
        return safeError("Failed to count billable members", err);
      }
    },
  };
}
