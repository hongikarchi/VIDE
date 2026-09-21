import { createConnection } from 'node:net';

interface TransportOptions {port?:number;timeoutMs?:number;beforeSend?:()=>unknown|Promise<unknown>}

/** Installed Rhino MCP framing. Never retry writes after an ambiguous disconnect. */
export function rhinoCommand(type:string,params:Record<string,unknown>={}, {port=1999,timeoutMs=30000,beforeSend}:TransportOptions={}):Promise<unknown> {
  return new Promise<unknown>((resolve,reject)=>{
    const socket=createConnection({host:'127.0.0.1',port});
    let buffer=Buffer.alloc(0),finished=false,sent=false;
    const finish=(error:unknown,value?:unknown)=>{if(finished)return;finished=true;socket.destroy();error?reject(error):resolve(value);};
    const fail=(code:string)=>finish(Object.assign(new Error(code),{code}));
    socket.setTimeout(timeoutMs,()=>fail(sent?'HOST_RESULT_UNKNOWN':'HOST_UNAVAILABLE'));
    socket.on('error',()=>fail(sent?'HOST_RESULT_UNKNOWN':'HOST_UNAVAILABLE'));
    socket.on('end',()=>{if(!finished)fail('HOST_RESULT_UNKNOWN');});
    socket.on('connect',async()=>{
      // New execution paths verify ownership on this connection before sending any bytes.
      try { await beforeSend?.(); } catch(error) { finish(error); return; }
      if(finished)return;
      const data=Buffer.from(JSON.stringify({type,params})),header=Buffer.alloc(4);header.writeUInt32BE(data.length);
      sent=true;socket.write(Buffer.concat([header,data]));
    });
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length<4)return;
      const length=buffer.readUInt32BE();
      if(length>16*1024*1024)return fail('HOST_INVALID_RESPONSE');
      if(buffer.length<length+4)return;
      try{
        const response=JSON.parse(buffer.subarray(4,length+4).toString('utf8'));
        if(response.status==='error')return fail('HOST_REJECTED');
        finish(null,response.result??response);
      }catch{fail('HOST_INVALID_RESPONSE');}
    });
  });
}
