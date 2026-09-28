import { manualApproval, type Env } from './auth';
import { requestJoin, joinRoute } from './joins';
import { HttpError, body, digest, json, role, text } from './http';
import { hostView, online, openLinks, type HostRow } from './hosts';
import { loginEmail } from './accounts';

export interface Actor {
  id: string;
  email: string;
}
type MemberRole = 'owner' | 'viewer' | 'commenter';
export async function membership(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<MemberRole> {
  const row = await db
    .prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?')
    .bind(projectId, userId)
    .first<{ role: MemberRole }>();
  if (!row) throw new HttpError(404, 'PROJECT_NOT_FOUND');
  return row.role;
}
const ownerSql =
  "EXISTS(SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role='owner')";

export async function projectRoute(
  request: Request,
  env: Env,
  actor: Actor,
  path: string[],
): Promise<Response> {
  const db = env.DB;
  if (path.length === 0) {
    if (request.method === 'GET') {
      // Recent work first, like a file browser; the thumbnail itself is fetched separately.
      const rows = await db
        .prepare(
          `SELECT p.id,p.name,p.created_at,COALESCE(p.updated_at,p.created_at) AS updated_at,p.host_id,
            p.thumbnail IS NOT NULL AS has_thumbnail,m.role
          FROM projects p JOIN project_members m ON m.project_id=p.id
          WHERE m.user_id=? AND p.deleted_at IS NULL
          ORDER BY COALESCE(p.updated_at,p.created_at) DESC,p.id LIMIT 200`,
        )
        .bind(actor.id)
        .all();
      return json({ projects: rows.results });
    }
    if (request.method === 'POST') {
      const input = await body(request),
        name = text(input.name),
        id = crypto.randomUUID(),
        now = Date.now();
      // A new project belongs to the chosen work PC (or the account's only PC).
      let hostId: string | null = null;
      if (typeof input.hostId === 'string') {
        const host = await db
          .prepare('SELECT id FROM remote_hosts WHERE id=? AND user_id=?')
          .bind(input.hostId, actor.id)
          .first<{ id: string }>();
        if (!host) throw new HttpError(404, 'HOST_NOT_FOUND');
        hostId = host.id;
      } else {
        const hosts = await db
          .prepare('SELECT id FROM remote_hosts WHERE user_id=? LIMIT 2')
          .bind(actor.id)
          .all<{ id: string }>();
        if (hosts.results.length === 1) hostId = hosts.results[0].id;
      }
      await db.batch([
        db
          .prepare(
            'INSERT INTO projects(id,name,created_by,created_at,updated_at,host_id) VALUES(?,?,?,?,?,?)',
          )
          .bind(id, name, actor.id, now, now, hostId),
        db
          .prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'owner')")
          .bind(id, actor.id),
      ]);
      return json({ id, name, role: 'owner', host_id: hostId }, 201);
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  }
  const projectId = path[0],
    current = await membership(db, projectId, actor.id);
  if (path.length === 1 && request.method === 'GET')
    return json(
      await db
        .prepare('SELECT id,name,created_at FROM projects WHERE id=?')
        .bind(projectId)
        .first(),
    );
  if (path.length === 2 && path[1] === 'thumbnail' && request.method === 'GET') {
    const row = await db
      .prepare('SELECT thumbnail FROM projects WHERE id=?')
      .bind(projectId)
      .first<{ thumbnail: string | null }>();
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(row?.thumbnail ?? '');
    if (!match) throw new HttpError(404, 'THUMBNAIL_NOT_FOUND');
    return new Response(
      Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0)),
      {
        headers: { 'Content-Type': match[1], 'Cache-Control': 'private, max-age=60' },
      },
    );
  }
  if (current !== 'owner') throw new HttpError(403, 'OWNER_REQUIRED');
  if (path.length === 1 && request.method === 'PATCH') {
    const name = text((await body(request)).name);
    await db
      .prepare('UPDATE projects SET name=? WHERE id=? AND deleted_at IS NULL')
      .bind(name, projectId)
      .run();
    return json({ id: projectId, name });
  }
  if (path.length === 1 && request.method === 'DELETE') {
    // Kept for shared reviews and the PC's own copy; it only leaves the account's list.
    await db
      .prepare('UPDATE projects SET deleted_at=? WHERE id=?')
      .bind(Date.now(), projectId)
      .run();
    return json({ deleted: true });
  }
  if (path.length === 2 && path[1] === 'open' && request.method === 'POST') {
    // The work PC holding the project; one that has none is claimed by the chosen online PC.
    const input = await body(request);
    const project = await db
      .prepare('SELECT host_id FROM projects WHERE id=? AND deleted_at IS NULL')
      .bind(projectId)
      .first<{ host_id: string | null }>();
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    const hosts = (
      await db
        .prepare('SELECT * FROM remote_hosts WHERE user_id=? ORDER BY created_at LIMIT 20')
        .bind(actor.id)
        .all<HostRow>()
    ).results;
    const wanted = project.host_id ?? (typeof input.hostId === 'string' ? input.hostId : null);
    const host = wanted
      ? hosts.find((row) => row.id === wanted)
      : hosts.filter((row) => online(row)).length === 1
        ? hosts.find((row) => online(row))
        : undefined;
    if (!host)
      throw new HttpError(
        project.host_id ? 404 : 409,
        project.host_id ? 'HOST_NOT_FOUND' : 'HOST_CHOICE_REQUIRED',
      );
    if (!online(host)) throw new HttpError(409, 'HOST_OFFLINE');
    await db
      .prepare('UPDATE projects SET host_id=COALESCE(host_id,?),updated_at=? WHERE id=?')
      .bind(host.id, Date.now(), projectId)
      .run();
    return json({ ...(await openLinks(host, projectId)), host: hostView(host) });
  }
  if (path[1] === 'join-requests') return joinRoute(request, env, actor, projectId, path.slice(2));
  if (path[1] === 'members') {
    if (path.length === 2 && request.method === 'GET')
      return json({
        members: (
          await db
            .prepare(
              'SELECT m.user_id,m.role,u.name,u.email FROM project_members m JOIN user u ON u.id=m.user_id WHERE project_id=? ORDER BY m.user_id',
            )
            .bind(projectId)
            .all()
        ).results,
      });
    if (path.length === 3 && ['PATCH', 'DELETE'].includes(request.method)) {
      const target = path[2];
      if (target === actor.id) throw new HttpError(409, 'OWNER_CANNOT_BE_REMOVED');
      const result =
        request.method === 'DELETE'
          ? await db
              .prepare(
                `DELETE FROM project_members WHERE project_id=? AND user_id=? AND role!='owner' AND ${ownerSql}`,
              )
              .bind(projectId, target, projectId, actor.id)
              .run()
          : await db
              .prepare(
                `UPDATE project_members SET role=? WHERE project_id=? AND user_id=? AND role!='owner' AND ${ownerSql}`,
              )
              .bind(role((await body(request)).role), projectId, target, projectId, actor.id)
              .run();
      if (!result.meta.changes) throw new HttpError(404, 'MEMBER_NOT_FOUND');
      return json({ changed: true });
    }
  }
  if (path[1] === 'invitations') {
    if (path.length === 2 && request.method === 'GET')
      return json({
        invitations: (
          await db
            .prepare(
              'SELECT id,email,role,expires_at,revoked_at,accepted_at FROM invitations WHERE project_id=? ORDER BY created_at DESC LIMIT 200',
            )
            .bind(projectId)
            .all()
        ).results,
      });
    if (path.length === 2 && request.method === 'POST') {
      const input = await body(request),
        // An ID (without "@") invites that ID account.
        email = loginEmail(text(input.email, 254)),
        selectedRole = role(input.role);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'INVALID_EMAIL');
      const now = Date.now(),
        id = crypto.randomUUID(),
        token = crypto.randomUUID() + crypto.randomUUID(),
        expiresAt = now + 7 * 86400000;
      const result = await db
        .prepare(
          `INSERT INTO invitations(id,project_id,email,role,token_hash,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE ${ownerSql}`,
        )
        .bind(
          id,
          projectId,
          email,
          selectedRole,
          await digest(token),
          expiresAt,
          now,
          projectId,
          actor.id,
        )
        .run();
      if (!result.meta.changes) throw new HttpError(403, 'OWNER_REQUIRED');
      // Fragment keeps the raw invitation token out of server access logs/referrers.
      const link = env.AUTH_ORIGIN + '/invite#' + token;
      let delivered = false;
      try {
        if (!manualApproval(env))
          await env.EMAIL!.send({
            from: env.EMAIL_FROM,
            to: email,
            subject: 'VIDE project invitation',
            text: link,
          });
        delivered = !manualApproval(env);
      } catch {
        /* Response explicitly reports emailDelivery=failed; invitation remains usable. */
      }
      return json(
        {
          id,
          expiresAt,
          link,
          emailDelivery: manualApproval(env) ? 'disabled' : delivered ? 'submitted' : 'failed',
        },
        201,
      );
    }
    if (path.length === 3 && request.method === 'DELETE') {
      const result = await db
        .prepare(`UPDATE invitations SET revoked_at=? WHERE project_id=? AND id=? AND ${ownerSql}`)
        .bind(Date.now(), projectId, path[2], projectId, actor.id)
        .run();
      if (!result.meta.changes) throw new HttpError(404, 'INVITATION_NOT_FOUND');
      return json({ revoked: true });
    }
  }
  throw new HttpError(404, 'NOT_FOUND');
}

export async function acceptInvitation(
  request: Request,
  env: Env,
  actor: Actor,
): Promise<Response> {
  if (manualApproval(env)) return requestJoin(request, env, actor);
  const token = text((await body(request)).token, 200),
    hash = await digest(token),
    now = Date.now(),
    db = env.DB;
  // Both statements are one D1 transaction. A replay never recreates a removed membership.
  await db.batch([
    db
      .prepare(
        `INSERT INTO project_members(project_id,user_id,role)
      SELECT project_id,?,role FROM invitations WHERE token_hash=? AND email=? AND revoked_at IS NULL AND expires_at>? AND accepted_by IS NULL
      ON CONFLICT(project_id,user_id) DO NOTHING`,
      )
      .bind(actor.id, hash, actor.email.toLowerCase(), now),
    db
      .prepare(
        `UPDATE invitations SET accepted_by=?,accepted_at=? WHERE token_hash=? AND email=? AND revoked_at IS NULL AND expires_at>? AND accepted_by IS NULL
      AND EXISTS(SELECT 1 FROM project_members WHERE project_id=invitations.project_id AND user_id=?)`,
      )
      .bind(actor.id, now, hash, actor.email.toLowerCase(), now, actor.id),
  ]);
  const row = await db
    .prepare(
      `SELECT i.project_id,m.role FROM invitations i JOIN project_members m ON m.project_id=i.project_id AND m.user_id=i.accepted_by
    WHERE i.token_hash=? AND i.email=? AND i.accepted_by=? AND i.revoked_at IS NULL`,
    )
    .bind(hash, actor.email.toLowerCase(), actor.id)
    .first();
  if (!row) throw new HttpError(409, 'INVITATION_UNAVAILABLE');
  return json(row);
}
