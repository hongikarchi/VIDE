import {z} from 'zod';
import {sendHostCommand} from '../common/transport.ts';
import type {HostTransportOptions} from '../common/transport.ts';
type TransportOptions=Partial<HostTransportOptions>;

/** Legacy RhinoMCP default is confined to this compatibility adapter. */
export function rhinoCommand(type:string,params:Record<string,unknown>={},options:TransportOptions={}){
 return sendHostCommand(type,params,{...options,port:options.port??1999});
}

export async function legacyRhinoCommand(type:'execute_rhinocommon_csharp_code',params:{code:string},options:TransportOptions={}){
 const value=await rhinoCommand(type,params,options);
 const parsed=z.object({success:z.boolean(),output:z.string().optional(),message:z.string().optional()}).safeParse(value);
 if(!parsed.success||(parsed.data.success&&parsed.data.output===undefined))throw Object.assign(Error('HOST_RESULT_UNKNOWN'),{code:'HOST_RESULT_UNKNOWN'});
 return {...parsed.data,output:parsed.data.output??''};
}
