import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db/migration';
interface Env {DB:D1Database;EMAIL:SendEmail;AUTH_SECRET:string;AUTH_ORIGIN:string;SPIKE_LOCAL:string}
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const url=new URL(request.url);
  // Deliberately a local-only compatibility experiment, not a deployable auth service.
  if(env.SPIKE_LOCAL!=='1'||url.origin!==env.AUTH_ORIGIN||!['localhost','127.0.0.1'].includes(url.hostname)||!env.AUTH_SECRET||env.AUTH_SECRET.length<32)return new Response('Local experiment only',{status:503});
  const send=(kind:string,to:string,link:string)=>ctx.waitUntil((async()=>{
   await env.DB.prepare('INSERT INTO spike_mail(kind,recipient,link) VALUES(?,?,?)').bind(kind,to,link).run();
   await env.EMAIL.send({from:'VIDE test <noreply@example.com>',to,subject:'VIDE synthetic '+kind,text:link});
  })());
  const auth=betterAuth({
   database:env.DB,secret:env.AUTH_SECRET,baseURL:env.AUTH_ORIGIN,trustedOrigins:[env.AUTH_ORIGIN],
   advanced:{ipAddress:{ipAddressHeaders:['cf-connecting-ip']}},
   emailAndPassword:{enabled:true,requireEmailVerification:true,revokeSessionsOnPasswordReset:true,sendResetPassword:async({user,url})=>send('reset',user.email,url)},
   emailVerification:{sendOnSignUp:true,autoSignInAfterVerification:false,sendVerificationEmail:async({user,url})=>send('verify',user.email,url)},
   rateLimit:{enabled:true,storage:'database',max:100,window:60},
  });
  if(url.pathname.startsWith('/__test/')){
   if(request.headers.get('X-Spike-Key')!==env.AUTH_SECRET)return new Response('Forbidden',{status:403});
   if(url.pathname==='/__test/migrate'&&request.method==='POST'){
    const migration=await getMigrations(auth.options),schema=await migration.compileMigrations();await migration.runMigrations();
    await env.DB.exec('CREATE TABLE IF NOT EXISTS spike_mail(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,recipient TEXT NOT NULL,link TEXT NOT NULL)');return Response.json({migrated:true,schema});
   }
   if(url.pathname==='/__test/mail'&&request.method==='GET'){
    const rows=await env.DB.prepare('SELECT kind,recipient,link FROM spike_mail WHERE recipient=? ORDER BY id DESC').bind(url.searchParams.get('email')).all();return Response.json(rows.results);
   }
   return new Response('Not found',{status:404});
  }
  if(url.pathname==='/health')return Response.json({local:true});
  return auth.handler(request);
 }
} satisfies ExportedHandler<Env>;
