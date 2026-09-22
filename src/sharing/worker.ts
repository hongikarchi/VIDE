import {createAuth,type Env} from './auth';
import {HttpError,json} from './http';
import {acceptInvitation,projectRoute} from './projects';
import {publicationRoute} from './publications';
import {commentRoute} from './comments';

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    try{
      const url=new URL(request.url);
      if(!env.AUTH_SECRET||env.AUTH_SECRET.length<32||!env.AUTH_ORIGIN||url.origin!==env.AUTH_ORIGIN)throw new HttpError(503,'SHARING_NOT_CONFIGURED');
      const auth=createAuth(env,ctx);
      if(url.pathname.startsWith('/api/auth/'))return auth.handler(request);
      if(!url.pathname.startsWith('/api/'))throw new HttpError(404,'NOT_FOUND');
      if(!['GET','HEAD'].includes(request.method)&&request.headers.get('Origin')!==env.AUTH_ORIGIN)throw new HttpError(403,'ORIGIN_REJECTED');
      const session=await auth.api.getSession({headers:request.headers});
      if(!session?.user.emailVerified)throw new HttpError(401,'LOGIN_REQUIRED');
      const actor={id:session.user.id,email:session.user.email};
      if(url.pathname==='/api/invitations/accept'&&request.method==='POST')return await acceptInvitation(request,env,actor);
      const path=url.pathname.split('/').filter(Boolean);
      if(path[1]==='projects'&&path[2]&&path[3]==='publications'&&path[4]&&path[5]==='comments'&&path.length===6)return await commentRoute(request,env,actor,path[2],path[4]);
      if(path[1]==='projects'&&path[2]&&path[3]==='publications')return await publicationRoute(request,env,actor,path[2],path.slice(4));
      if(path[1]==='projects')return await projectRoute(request,env,actor,path.slice(2));
      throw new HttpError(404,'NOT_FOUND');
    }catch(error){
      if(error instanceof HttpError)return json({error:error.code},error.status);
      // No request bodies, tokens or provider exception details in public responses.
      console.error('Sharing request failed',error instanceof Error?error.name:'UnknownError');
      return json({error:'INTERNAL_ERROR'},500);
    }
  }
} satisfies ExportedHandler<Env>;
