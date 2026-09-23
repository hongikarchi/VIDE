import type { Env } from './auth';
import type { Actor } from './projects';
import { HttpError, body, digest, json, text } from './http';

export async function requestJoin(request: Request, env: Env, actor: Actor) {
  const hash = await digest(text((await body(request)).token, 200)),
    now = Date.now();
  // Email is only an address supplied by the applicant; it never grants membership.
  const invitation = await env.DB.prepare(
    'SELECT id FROM invitations WHERE token_hash=? AND email=? AND revoked_at IS NULL AND expires_at>? AND accepted_by IS NULL',
  )
    .bind(hash, actor.email.toLowerCase(), now)
    .first<{ id: string }>();
  if (!invitation) throw new HttpError(409, 'INVITATION_UNAVAILABLE');
  await env.DB.prepare(
    `INSERT INTO join_requests(id,invitation_id,user_id,created_at) SELECT ?,id,?,? FROM invitations WHERE id=? AND revoked_at IS NULL AND expires_at>? AND accepted_by IS NULL ON CONFLICT(invitation_id,user_id) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), actor.id, now, invitation.id, now)
    .run();
  const row = await env.DB.prepare(
    'SELECT id,status FROM join_requests WHERE invitation_id=? AND user_id=?',
  )
    .bind(invitation.id, actor.id)
    .first<{ id: string; status: string }>();
  if (!row || row.status !== 'pending') throw new HttpError(409, 'INVITATION_UNAVAILABLE');
  return json({ requestId: row.id, status: 'pending' }, 202);
}

export async function joinRoute(
  request: Request,
  env: Env,
  actor: Actor,
  projectId: string,
  path: string[],
) {
  const db = env.DB;
  if (!path.length && request.method === 'GET')
    return json({
      requests: (
        await db
          .prepare(
            `SELECT j.id,j.status,j.created_at,u.id AS user_id,u.name,u.email,u.emailVerified,i.role,i.expires_at,i.revoked_at FROM join_requests j JOIN invitations i ON i.id=j.invitation_id JOIN user u ON u.id=j.user_id WHERE i.project_id=? AND j.status='pending' ORDER BY j.created_at LIMIT 200`,
          )
          .bind(projectId)
          .all()
      ).results,
    });
  if (path.length !== 1 || request.method !== 'POST') throw new HttpError(404, 'NOT_FOUND');
  const decision = (await body(request)).decision;
  if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'INVALID_DECISION');
  const now = Date.now();
  const valid = `j.id=? AND j.status='pending' AND i.project_id=? AND i.revoked_at IS NULL AND i.expires_at>? AND i.accepted_by IS NULL AND EXISTS(SELECT 1 FROM project_members WHERE project_id=i.project_id AND user_id=? AND role='owner')`;
  if (decision === 'reject') {
    const r = await db
      .prepare(
        `UPDATE join_requests SET status='rejected',decided_at=?,decided_by=? WHERE id IN (SELECT j.id FROM join_requests j JOIN invitations i ON i.id=j.invitation_id WHERE ${valid})`,
      )
      .bind(now, actor.id, path[0], projectId, now, actor.id)
      .run();
    if (!r.meta.changes) throw new HttpError(409, 'JOIN_REQUEST_UNAVAILABLE');
    return json({ status: 'rejected' });
  }
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO project_members(project_id,user_id,role) SELECT i.project_id,j.user_id,i.role FROM join_requests j JOIN invitations i ON i.id=j.invitation_id WHERE ${valid} ON CONFLICT(project_id,user_id) DO NOTHING`,
      )
      .bind(path[0], projectId, now, actor.id),
    db
      .prepare(
        `UPDATE invitations SET accepted_by=(SELECT user_id FROM join_requests WHERE id=?),accepted_at=? WHERE id IN (SELECT i.id FROM join_requests j JOIN invitations i ON i.id=j.invitation_id WHERE ${valid}) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=invitations.project_id AND user_id=(SELECT user_id FROM join_requests WHERE id=?))`,
      )
      .bind(path[0], now, path[0], projectId, now, actor.id, path[0]),
    db
      .prepare(
        `UPDATE join_requests SET status='approved',decided_at=?,decided_by=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM invitations i WHERE i.id=join_requests.invitation_id AND i.project_id=? AND i.accepted_by=join_requests.user_id AND i.accepted_at=? AND i.revoked_at IS NULL AND EXISTS(SELECT 1 FROM project_members WHERE project_id=i.project_id AND user_id=? AND role='owner'))`,
      )
      .bind(now, actor.id, path[0], projectId, now, actor.id),
  ]);
  if (!results[2].meta.changes) throw new HttpError(409, 'JOIN_REQUEST_UNAVAILABLE');
  return json({ status: 'approved' });
}
