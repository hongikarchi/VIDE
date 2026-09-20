import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quantities,quantitiesCsv} from '../../src/core/quantities.mjs';
const request={id:'candidate-a',createdAt:'2026-09-20',result:{hostExecuted:true,host:'rhino',objects:[{id:'a',name:'=SUM(1,2)',kind:'polyline'},{id:'b',name:'Unknown',kind:'native'}],scene:[{id:'a',line:[0,0,0,3,4,0],area:12,volume:null},{id:'b',area:null,volume:null}]}};
test('quantities keep unknown measurements separate and calculate native line length',()=>{
 const table=quantities(request);assert.equal(table.rows[0].length,5);assert.deepEqual(table.totals.area,{value:12,known:1,unknown:1});assert.equal(table.totals.volume.known,0);assert.equal(table.scope,'candidate');
 assert.throws(()=>quantities({result:{hostExecuted:false}}),{code:'NOT_FOUND'});
});
test('CSV protects formulas and includes units and immutable candidate basis',()=>{
 const csv=quantitiesCsv(quantities(request));assert.ok(csv.includes('"\'=SUM(1,2)"'));assert.ok(csv.includes('candidate-a'));assert.ok(csv.includes('기하 면적 (m²)'));assert.ok(csv.includes('미상'));assert.ok(csv.startsWith('\ufeff'));
});
