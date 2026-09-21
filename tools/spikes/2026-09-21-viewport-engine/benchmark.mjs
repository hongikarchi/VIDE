const params=new URLSearchParams(location.search),name=params.get('engine')||'three';
const canvas=document.querySelector('canvas'),out=document.querySelector('#result');
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))];
const tick=()=>new Promise(r=>requestAnimationFrame(r));
const round=n=>Math.round(n*1000)/1000;
const box={positions:[-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1],indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5]};
function boxes(n){return Array.from({length:n},(_,i)=>({id:`box-${i}`,positions:box.positions.map((v,j)=>v+(j%3===0?(i%100)*3:j%3===2?Math.floor(i/100)*3:0)),indices:box.indices}));}
function bounds(data){const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(const o of data)for(let i=0;i<o.positions.length;i++){lo[i%3]=Math.min(lo[i%3],o.positions[i]);hi[i%3]=Math.max(hi[i%3],o.positions[i]);}return {center:lo.map((v,i)=>(v+hi[i])/2),radius:Math.max(1,Math.hypot(...hi.map((v,i)=>v-lo[i]))/2)};}
async function adapter(){
 if(name==='three'){
  const T=await import('./node_modules/three/build/three.module.js');
  const renderer=new T.WebGLRenderer({canvas,antialias:true});renderer.setSize(1000,650,false);renderer.setPixelRatio(1);
  const scene=new T.Scene();scene.background=new T.Color('#edf0ec');
  const camera=new T.PerspectiveCamera(45,1000/650,.01,1e6),material=new T.MeshBasicMaterial({color:0x809480,side:T.DoubleSide});let meshes=[];
  return {version:T.REVISION,gl:renderer.getContext(),
   load(data){for(const o of data){const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(o.positions,3));g.setIndex(o.indices);g.computeBoundingSphere();const m=new T.Mesh(g,material);m.name=o.id;scene.add(m);meshes.push(m);}},
   camera(c,r,a){camera.position.set(c[0]+r*2*Math.sin(a),c[1]+r*1.7,c[2]+r*2*Math.cos(a));camera.lookAt(...c);camera.updateMatrixWorld();},
   ready(){return renderer.compileAsync(scene,camera);},render(){renderer.render(scene,camera);},
   pick(x,y,z){const ray=new T.Raycaster(new T.Vector3(x,y,z),new T.Vector3(0,-1,0));return ray.intersectObjects(meshes,false)[0]?.object.name??null;},
   update(){for(let i=0;i<Math.min(10,meshes.length);i++)meshes[i].position.y+=.01;},
   clear(){for(const m of meshes){scene.remove(m);m.geometry.dispose();}meshes=[];},
   count(){return renderer.info.memory.geometries;},
   dispose(){material.dispose();renderer.dispose();}
  };
 }
 const B=await import('./node_modules/@babylonjs/core/index.js');
 const engine=new B.Engine(canvas,true,{preserveDrawingBuffer:false,stencil:true});engine.setSize(1000,650);
 const scene=new B.Scene(engine);scene.useRightHandedSystem=true;scene.clearColor=new B.Color4(.929,.941,.925,1);
 const camera=new B.FreeCamera('camera',new B.Vector3(),scene);camera.minZ=.01;camera.maxZ=1e6;camera.fov=Math.PI/4;
 const material=new B.StandardMaterial('material',scene);material.disableLighting=true;material.emissiveColor=new B.Color3(.502,.58,.502);material.backFaceCulling=false;let meshes=[];
 return {version:B.Engine.Version,gl:engine._gl,
  load(data){for(const o of data){const m=new B.Mesh(o.id,scene),v=new B.VertexData();v.positions=o.positions;v.indices=o.indices;v.applyToMesh(m);m.material=material;meshes.push(m);}},
  camera(c,r,a){camera.position.set(c[0]+r*2*Math.sin(a),c[1]+r*1.7,c[2]+r*2*Math.cos(a));camera.setTarget(new B.Vector3(...c));},
  async ready(){if(meshes.length)await material.forceCompilationAsync(meshes[0]);},render(){scene.render();},
  pick(x,y,z){return scene.pickWithRay(new B.Ray(new B.Vector3(x,y,z),new B.Vector3(0,-1,0)),undefined,false)?.pickedMesh?.name??null;},
  update(){for(let i=0;i<Math.min(10,meshes.length);i++)meshes[i].position.y+=.01;},
  clear(){for(const m of meshes)m.dispose();meshes=[];},count(){return scene.geometries.length;},
  dispose(){scene.dispose();engine.dispose();}
 };
}
try{
 const imported=performance.now(),a=await adapter(),importMs=performance.now()-imported;
 const gl=a.gl,debug=gl.getExtension('WEBGL_debug_renderer_info');
 const reference=await (await fetch('/reference.json')).json();
 const report={engine:name,version:a.version,userAgent:navigator.userAgent,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),viewport:[1000,650],dpr:1,importMs:round(importMs),sourceSha256:reference.sourceSha256,scope:reference.scope,runs:[]};
 for(const [label,data] of [['reference-ground',reference.objects],['boxes-1000',boxes(1000)],['boxes-10000',boxes(10000)]]){
  const b=bounds(data);
  for(let repeat=0;repeat<3;repeat++){
   const start=performance.now();a.load(data);a.camera(b.center,b.radius,.5);await a.ready();a.render();gl.finish();const initialMs=performance.now()-start;
   for(let i=0;i<10;i++){await tick();a.render();}
   const frames=[],submissions=[];let last=performance.now();
   for(let i=0;i<60;i++){await tick();const now=performance.now();frames.push(now-last);last=now;const t=performance.now();a.camera(b.center,b.radius,.5+i*.003);a.render();gl.finish();submissions.push(performance.now()-t);}
   const picks=[];for(let i=0;i<30;i++){const t=performance.now();a.pick(b.center[0],b.center[1]+b.radius*3,b.center[2]);picks.push(performance.now()-t);}
   const t=performance.now();a.update();a.render();gl.finish();const updateMs=performance.now()-t;
   const loaded=a.count();a.clear();a.render();gl.finish();
   report.runs.push({dataset:label,repeat,objects:data.length,triangles:data.reduce((n,o)=>n+o.indices.length/3,0),initialMs:round(initialMs),frameP50Ms:round(percentile(frames,.5)),frameP95Ms:round(percentile(frames,.95)),renderFinishP50Ms:round(percentile(submissions,.5)),pickP95Ms:round(percentile(picks,.95)),update10Ms:round(updateMs),geometriesLoaded:loaded,geometriesAfterClear:a.count()});
   out.textContent=JSON.stringify(report,null,2);
  }
 }
 a.load([{...box,id:'target'}]);a.camera([0,0,0],3,.5);a.render();report.pickExpected=a.pick(0,10,0)==='target';a.clear();a.render();report.emptyPick=a.pick(0,10,0)===null;
 window.__result=report;out.textContent=JSON.stringify(report,null,2);document.title='DONE '+name;
 // Keep a reference preview for visual verification after timing/cleanup measurements.
 const previewBounds=bounds(reference.objects);a.load(reference.objects);a.camera(previewBounds.center,previewBounds.radius,.5);await a.ready();
 let previewFrame;function preview(){a.render();previewFrame=requestAnimationFrame(preview);}preview();
 window.addEventListener('pagehide',()=>{cancelAnimationFrame(previewFrame);a.clear();a.dispose();},{once:true});
}catch(error){window.__result={error:error.stack};out.textContent=error.stack;document.title='FAILED '+name;}
