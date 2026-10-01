import type { PoolClient } from 'pg';
import { newWrappedKey, keyContext } from './encryption.js';
import { SyncPool } from './pool.js';
import { identifier } from './validation.js';
import { SyncError, type ProvisionDocument } from './types.js';
import type { SyncServiceOptions } from './service.js';
const teacherRoles = ['teacher', 'school_admin', 'district_admin', 'owner', 'system_admin'];
/** Trusted control-plane API. Never expose these methods directly as browser document routes. */
export class PostgresSyncProvisioner {
  private readonly pool: SyncPool;
  constructor(private readonly options: SyncServiceOptions) {
    this.pool = new SyncPool(options.database, 'provisioner');
  }
  close() {
    return this.pool.close();
  }
  private async member(
    client: PoolClient,
    organizationId: string,
    userId: string,
    audience: 'members' | 'teachers',
  ) {
    const row = (
      await client.query<{ role: string }>(
        'SELECT m.role FROM margin_identity.memberships m JOIN margin_identity.users u ON u.id=m.user_id JOIN margin_identity.organizations o ON o.id=m.organization_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND o.disabled_at IS NULL',
        [organizationId, userId],
      )
    ).rows[0];
    if (!row || (audience === 'teachers' && !teacherRoles.includes(row.role)))
      throw new SyncError(
        400,
        'invalid_grantee',
        'The grantee must be an active member allowed in this document audience.',
      );
  }
  async createDocument(value: ProvisionDocument): Promise<void> {
    const organizationId = identifier(value.organizationId),
      documentId = identifier(value.documentId),
      versionId = identifier(value.versionId),
      ownerId = identifier(value.ownerId);
    if (value.audience !== 'members' && value.audience !== 'teachers')
      throw new SyncError(400, 'invalid_audience', 'Choose a supported document audience.');
    if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 2000)
      throw new SyncError(400, 'invalid_pages', 'Provision between one and 2,000 pages.');
    const pages = value.pages.map((page, index) => {
      if (
        page.index !== index ||
        !Number.isFinite(page.width) ||
        page.width <= 0 ||
        page.width > 100000 ||
        !Number.isFinite(page.height) ||
        page.height <= 0 ||
        page.height > 100000
      )
        throw new SyncError(
          400,
          'invalid_pages',
          'Page indices and dimensions must come from validated server document metadata.',
        );
      return { ...page, id: identifier(page.id) };
    });
    if (new Set(pages.map((p) => p.id)).size !== pages.length)
      throw new SyncError(400, 'invalid_pages', 'Page identifiers must be unique.');
    if (value.grants && (!Array.isArray(value.grants) || value.grants.length > 1000))
      throw new SyncError(
        400,
        'invalid_grants',
        'Provision at most 1,000 explicit document grants.',
      );
    const grants = (value.grants ?? []).map((grant) => {
      if (grant.permission !== 'editor' && grant.permission !== 'viewer')
        throw new SyncError(400, 'invalid_grants', 'Additional grants must be editor or viewer.');
      return { userId: identifier(grant.userId), permission: grant.permission };
    });
    if (new Set([ownerId, ...grants.map((g) => g.userId)]).size !== grants.length + 1)
      throw new SyncError(400, 'invalid_grants', 'Each document member needs one explicit grant.');
    const wrapped = await newWrappedKey(
      this.options.keyManagementProvider,
      keyContext(organizationId, documentId),
    );
    await this.pool.transaction(undefined, async (client) => {
      for (const userId of [ownerId, ...grants.map((g) => g.userId)])
        await this.member(client, organizationId, userId, value.audience);
      await client.query(
        'INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience) VALUES($1,$2,$3,$4,$5)',
        [organizationId, documentId, ownerId, versionId, value.audience],
      );
      await client.query(
        'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
        [organizationId, documentId, versionId],
      );
      await client.query(
        'INSERT INTO margin_sync.pages(organization_id,document_id,version_id,id,page_index,width,height) SELECT $1,$2,$3,p.id,p.index,p.width,p.height FROM jsonb_to_recordset($4::jsonb) AS p(id uuid,index integer,width double precision,height double precision)',
        [organizationId, documentId, versionId, JSON.stringify(pages)],
      );
      await client.query(
        'INSERT INTO margin_sync.document_keys(organization_id,document_id,wrapped_key) VALUES($1,$2,$3)',
        [organizationId, documentId, wrapped],
      );
      await client.query(
        'INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) SELECT $1,$2,g."userId",g.permission FROM jsonb_to_recordset($3::jsonb) AS g("userId" uuid,permission text)',
        [
          organizationId,
          documentId,
          JSON.stringify([{ userId: ownerId, permission: 'owner' }, ...grants]),
        ],
      );
    });
  }
  async setGrant(
    organizationId: string,
    documentId: string,
    userId: string,
    permission: 'editor' | 'viewer' | null,
  ): Promise<void> {
    organizationId = identifier(organizationId);
    documentId = identifier(documentId);
    userId = identifier(userId);
    if (permission !== null && permission !== 'editor' && permission !== 'viewer')
      throw new SyncError(400, 'invalid_grant', 'Choose an editor/viewer grant or revoke it.');
    await this.pool.transaction(undefined, async (client) => {
      const d = (
        await client.query<{ owner_id: string; audience: 'members' | 'teachers' }>(
          'SELECT owner_id,audience FROM margin_sync.documents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
          [organizationId, documentId],
        )
      ).rows[0];
      if (!d) throw new SyncError(404, 'document_unavailable', 'Document does not exist.');
      if (d.owner_id === userId)
        throw new SyncError(
          400,
          'owner_immutable',
          'Owner transfer requires a separate audited workflow.',
        );
      if (permission === null)
        await client.query(
          'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND document_id=$2 AND user_id=$3',
          [organizationId, documentId, userId],
        );
      else {
        await this.member(client, organizationId, userId, d.audience);
        await client.query(
          'INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,document_id,user_id) DO UPDATE SET permission=EXCLUDED.permission,revoked_at=NULL',
          [organizationId, documentId, userId, permission],
        );
      }
    });
  }
}
