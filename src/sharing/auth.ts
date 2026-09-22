import {betterAuth} from 'better-auth';

export interface Env {
  DB:D1Database;
  ASSETS:R2Bucket;
  EMAIL:SendEmail;
  AUTH_ORIGIN:string;
  AUTH_SECRET:string;
  EMAIL_FROM:string;
}

export function createAuth(env:Env,ctx:ExecutionContext){
  const send=(to:string,subject:string,url:string)=>{
    ctx.waitUntil(env.EMAIL.send({from:env.EMAIL_FROM,to,subject,text:url}));
  };
  return betterAuth({
    database:env.DB,secret:env.AUTH_SECRET,baseURL:env.AUTH_ORIGIN,
    trustedOrigins:[env.AUTH_ORIGIN],
    advanced:{ipAddress:{ipAddressHeaders:['cf-connecting-ip']}},
    emailAndPassword:{enabled:true,requireEmailVerification:true,revokeSessionsOnPasswordReset:true,
      sendResetPassword:async({user,url})=>send(user.email,'VIDE password reset',url)},
    emailVerification:{sendOnSignUp:true,autoSignInAfterVerification:false,
      sendVerificationEmail:async({user,url})=>send(user.email,'VIDE email verification',url)},
    rateLimit:{enabled:true,storage:'database',max:100,window:60},
  });
}
