// Small correctness probes, separate from performance samples and product integration.
export async function check(engineName){
 const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;document.body.append(canvas);
 let result;
 if(engineName==='three'){
  const T=await import('./node_modules/three/build/three.module.js');
  const renderer=new T.WebGLRenderer({canvas,antialias:false});renderer.setSize(256,256,false);renderer.localClippingEnabled=true;
  const scene=new T.Scene();scene.background=new T.Color(0x000000);
  const camera=new T.OrthographicCamera(-2,2,2,-2,.01,100);camera.position.set(0,0,5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const material=new T.MeshBasicMaterial({color:0xffffff,side:T.DoubleSide}),mesh=new T.Mesh(new T.BoxGeometry(2,2,2),material);mesh.userData.id='stable-id';scene.add(mesh);
  const ray=new T.Raycaster();ray.setFromCamera(new T.Vector2(0,0),camera);renderer.render(scene,camera);
  const picked=ray.intersectObject(mesh)[0];
  const planeHit=ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,0,1),0),new T.Vector3());
  const count=()=>{renderer.render(scene,camera);const gl=renderer.getContext(),pixels=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let lit=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>128)lit++;return lit;};
  const full=count();material.clippingPlanes=[new T.Plane(new T.Vector3(1,0,0),0)];const clipped=count();material.clippingPlanes=[];
  const line=new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-1,0,1.1),new T.Vector3(1,0,1.1)]),new T.LineBasicMaterial({color:0xff0000}));scene.add(line);renderer.render(scene,camera);ray.params.Line.threshold=.02;
  const lineHit=ray.intersectObject(line).length>0;
  // World/document doubles are rebased before float32 upload; probe millimeter separation.
  const origin=1e6,documentX=origin+.001,local=new Float32Array([documentX-origin])[0];
  mesh.position.x=.2;renderer.render(scene,camera);ray.setFromCamera(new T.Vector2(.1,0),camera);
  result={orthographicObjectId:picked?.object.userData.id==='stable-id',planePoint:planeHit?.length()<1e-9,linePick:lineHit,clipPixels:{full,clipped},halfClip:clipped>full*.45&&clipped<full*.55,updatedId:ray.intersectObject(mesh)[0]?.object.userData.id==='stable-id',rebasedMillimeterError:Math.abs(origin+local-documentX)};
  mesh.geometry.dispose();material.dispose();line.geometry.dispose();line.material.dispose();renderer.dispose();
 }else{
  const B=await import('./node_modules/@babylonjs/core/index.js');
  const engine=new B.Engine(canvas,false,{preserveDrawingBuffer:true});engine.setSize(256,256);
  const scene=new B.Scene(engine);scene.useRightHandedSystem=true;scene.clearColor=new B.Color4(0,0,0,1);
  const camera=new B.FreeCamera('camera',new B.Vector3(0,0,5),scene);camera.setTarget(B.Vector3.Zero());camera.mode=B.Camera.ORTHOGRAPHIC_CAMERA;camera.orthoLeft=-2;camera.orthoRight=2;camera.orthoTop=2;camera.orthoBottom=-2;camera.minZ=.01;camera.maxZ=100;
  const material=new B.StandardMaterial('white',scene);material.disableLighting=true;material.emissiveColor=B.Color3.White();material.backFaceCulling=false;
  const mesh=B.MeshBuilder.CreateBox('stable-id',{size:2},scene);mesh.material=material;scene.render();
  const picked=scene.pick(128,128),ray=scene.createPickingRay(128,128,B.Matrix.Identity(),camera);
  const distance=ray.intersectsPlane(new B.Plane(0,0,1,0)),planeHit=distance==null?null:ray.origin.add(ray.direction.scale(distance));
  const count=()=>{scene.render();const gl=engine._gl,pixels=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let lit=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>128)lit++;return lit;};
  await material.forceCompilationAsync(mesh);const full=count();scene.clipPlane=new B.Plane(1,0,0,0);await material.forceCompilationAsync(mesh,{clipPlane:true});const clipped=count();scene.clipPlane=null;
  const line=B.MeshBuilder.CreateLines('sketch',{points:[new B.Vector3(-1,0,1.1),new B.Vector3(1,0,1.1)]},scene);line.isPickable=true;line.intersectionThreshold=.02;scene.render();
  const lineHit=scene.pickWithRay(ray,m=>m===line)?.hit===true;
  const origin=1e6,documentX=origin+.001,local=new Float32Array([documentX-origin])[0];mesh.position.x=.2;scene.render();
  result={orthographicObjectId:picked?.pickedMesh?.name==='stable-id',planePoint:planeHit?.length()<1e-9,linePick:lineHit,clipPixels:{full,clipped},halfClip:clipped>full*.45&&clipped<full*.55,updatedId:scene.pick(140.8,128,m=>m===mesh)?.pickedMesh?.name==='stable-id',rebasedMillimeterError:Math.abs(origin+local-documentX)};
  scene.dispose();engine.dispose();
 }
 canvas.remove();return result;
}
