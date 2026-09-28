import { betterAuth } from 'better-auth';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  WEB?: Fetcher;
  EMAIL?: SendEmail;
  AUTH_MODE?: string;
  UPLOADS_ENABLED?: string;
  AUTH_ORIGIN: string;
  AUTH_SECRET: string;
  EMAIL_FROM: string;
  /** Owner-chosen code required to create an ID account; sign-up is closed without it. */
  SIGNUP_CODE?: string;
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
