import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {rhinoCommand} from '../../hosts/rhino/transport.ts';

test('Rhino frames handle split UTF-8 and never retry an uncertain write',async()=>{
  let connections=0;
  const server=createServer(socket=>{connections++;socket.once('data',data=>{
    const request=JSON.parse(data.subarray(4).toString());
    if(request.type==='write'){socket.end();return;}
    const payload=Buffer.from(JSON.stringify({status:'success',result:{name:'한국어'}})),header=Buffer.alloc(4);header.writeUInt32BE(payload.length);
    socket.write(header.subarray(0,2));setTimeout(()=>{socket.write(Buffer.concat([header.subarray(2),payload.subarray(0,15)]));socket.end(payload.subarray(15));},5);
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const options={port:server.address().port};assert.deepEqual(await rhinoCommand('read',{},options),{name:'한국어'});
    await assert.rejects(rhinoCommand('write',{},options),{code:'HOST_RESULT_UNKNOWN'});assert.equal(connections,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
