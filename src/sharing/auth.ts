import { betterAuth } from 'better-auth';
import type { NoteRoom } from './note-room';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  WEB?: Fetcher;
  /** Shared notes: one Durable Object per note (ADR-034); without it the notes routes answer 503. */
  NOTES?: DurableObjectNamespace<NoteRoom>;
  EMAIL?: SendEmail;
  AUTH_MODE?: string;
  UPLOADS_ENABLED?: string;
  AUTH_ORIGIN: string;
  AUTH_SECRET: string;
  EMAIL_FROM: string;
  /** Owner-chosen code required to create an ID account; sign-up is closed without it. */
  SIGNUP_CODE?: string;
  /** Oldest PC program version the site still opens (PCs below it must update first). */
  MIN_APP_VERSION?: string;
  /** Saved views of linked files for when the work PC is off (PLAN-20); 'false' stops uploads. */
  SNAPSHOTS_ENABLED?: string;
  /** Snapshot bytes one account may keep (MB, default 500). */
  SNAPSHOT_QUOTA_MB?: string;
  /** Snapshot bytes the whole site may keep (MB, default 0 = off until R2 charges are accepted). */
  SNAPSHOT_TOTAL_MB?: string;
  /** Site admins (comma-separated account IDs or e-mails): the reports page (ADR-036). */
  ADMIN_USERS?: string;
  /** Secret for developers' tools reading reports (tools/diagnostics/reports.mjs), 32+ characters. */
  TELEMETRY_ADMIN_TOKEN?: string;
  /** 'false' stops taking reports (default on: small rows in D1). */
  TELEMETRY_REPORTS_ENABLED?: string;
  /** 'true' takes diagnostic bundles into R2 (default off until R2 is available). */
  TELEMETRY_BUNDLES_ENABLED?: string;
  /** Limits: reports (bundles) per install and per address a day, sizes, days kept. */
  TELEMETRY_INSTALL_DAILY?: string;
  TELEMETRY_IP_DAILY?: string;
  TELEMETRY_BUNDLE_MAX_MB?: string;
  TELEMETRY_BUNDLE_DUMP_MAX_MB?: string;
  TELEMETRY_KEEP_DAYS?: string;
}

export const manualApproval = (env: Env) => env.AUTH_MODE === 'manual-approval';

export function createAuth(env: Env, ctx: ExecutionContext) {
  const send = (to: string, subject: string, url: string) => {
    ctx.waitUntil(env.EMAIL!.send({ from: env.EMAIL_FROM, to, subject, text: url }));
  };
  return betterAuth({
    database: env.DB,
    secret: env.AUTH_SECRET,
    baseURL: env.AUTH_ORIGIN,
    trustedOrigins: [env.AUTH_ORIGIN],
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: !manualApproval(env),
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: manualApproval(env)
        ? undefined
        : async ({ user, url }) => send(user.email, 'VIDE password reset', url),
    },
    emailVerification: {
      sendOnSignUp: !manualApproval(env),
      autoSignInAfterVerification: false,
      sendVerificationEmail: manualApproval(env)
        ? undefined
        : async ({ user, url }) => send(user.email, 'VIDE email verification', url),
    },
    rateLimit: { enabled: true, storage: 'database', max: 100, window: 60 },
  });
}
