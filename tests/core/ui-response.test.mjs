import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../../src/ui/gateway.ts';
import {workspaceRequestSchema} from '../../src/contracts/workspace-result.ts';

test('UI transport classifies missing or malformed error payloads without losing the request failure',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>({ok:false,json:async()=>null}));
 await assert.rejects(api('/test'),{code:'REQUEST_FAILED'});
 fetch.mock.mockImplementation(async()=>({ok:false,json:async()=>{throw Error('invalid JSON');}}));
 await assert.rejects(api('/test'),{code:'INVALID_RESPONSE'});
 fetch.mock.mockImplementation(async()=>{throw Error('network');});
 await assert.rejects(api('/test'),{code:'NETWORK_UNAVAILABLE'});
});

test('workspace response validation preserves host metadata required by the viewport and rejects wrong display shapes',()=>{
 const request={id:'test',state:'succeeded',input:{body:'test',privateContext:'retained'},result:{hostExecuted:true,filename:'local-file.3dm',objects:[{id:'one',name:'One',kind:'native',nativeId:'host-id'}],scene:[{id:'one',vertices:[0,0,0],boundsSize:[1,2,3],attributes64:[['a','b']]}]}};
 assert.deepEqual(workspaceRequestSchema.parse(request),request);
 assert.equal(workspaceRequestSchema.safeParse({...request,result:{...request.result,scene:[{id:'one',vertices:'not coordinates'}]}}).success,false);
});
