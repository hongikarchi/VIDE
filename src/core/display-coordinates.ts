/** Keep GPU float32 positions local; retain the world origin in the object transform. */
export function displayCoordinates(positions:readonly number[]){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<positions.length;i++){const axis=i%3;min[axis]=Math.min(min[axis],positions[i]);max[axis]=Math.max(max[axis],positions[i]);}
 const origin=min.map((value,axis)=>value+(max[axis]-value)/2) as [number,number,number],local=new Float32Array(positions.length);
 for(let i=0;i<positions.length;i++)local[i]=positions[i]-origin[i%3];
 return {origin,local};
}
