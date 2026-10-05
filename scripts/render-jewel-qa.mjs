// Offline geometry/UV proof using the same Three model as the app. This is not a GPU/PBR screenshot.
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const THREE = require("three");
const ts = require("typescript");
Module._extensions[".ts"] = function(module, filename) {
  const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  module._compile(result.outputText, filename);
};
const { createJewelModel } = require(path.join(root, "lib/jewel-model.ts"));
const out = path.resolve(process.argv[2] ?? "/private/tmp/cdstudio-jewel-geometry-qa");
fs.mkdirSync(out, { recursive: true });
const W = 680, H = 560;
const roles = { front: ["FRONT", "#264a71"], frontInner: ["FRONT INSIDE", "#5c3270"], back: ["BACK", "#296152"], backInner: ["BACK INSIDE", "#953a38"], spineLeft: ["LEFT SPINE", "#c57026"], spineRight: ["RIGHT SPINE", "#bf7e26"], label: ["CD LABEL", "#b2a24a"] };
const textures = {};
for (const [role, [title, color]] of Object.entries(roles)) {
  const spine = role.startsWith("spine");
  const [w,h] = spine ? [65,1180] : role === "back" ? [548,472] : role === "backInner" ? [600,472] : [512,512];
  const markers = [[.12,.12,"#ff5555"],[.88,.12,"#65ed89"],[.12,.88,"#669bff"],[.88,.88,"#ffd866"]].map(([x,y,c])=>`<circle cx="${x*w}" cy="${y*h}" r="${spine?6:20}" fill="${c}"/>`).join("");
  const text = spine
    ? `<g transform="translate(${w/2},${h/2}) rotate(90)"><text text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="white">${title} → ABC 123</text></g>`
    : `<text x="${w/2}" y="${h*.46}" text-anchor="middle" font-family="sans-serif" font-size="36" font-weight="700" fill="white">${title}</text><text x="${w/2}" y="${h*.57}" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">TOP ↑</text><text x="${w/2}" y="${h*.67}" text-anchor="middle" font-family="sans-serif" font-size="18" fill="white">01 FIRST TRACK · 02 SECOND TRACK</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${color}"/><path d="M0 ${h/2}H${w}M${w/2} 0V${h}" stroke="#fff" stroke-opacity=".28" stroke-width="2"/>${markers}${text}</svg>`;
  textures[role] = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function visible(object) { for(let p=object;p;p=p.parent) if(!p.visible) return false; return true; }
function triangles(model, camera) {
  const opaque=[], clear=[];
  model.root.updateMatrixWorld(true); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const light = new THREE.Vector3(-.5, 1, .8).normalize();
  model.root.traverse(mesh => {
    if(!(mesh instanceof THREE.Mesh) || !visible(mesh)) return;
    const geometry=mesh.geometry, position=geometry.attributes.position, uv=geometry.attributes.uv;
    if(!position) return;
    const index=geometry.index, count=index?.count??position.count;
    const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    for(let i=0;i<count;i+=3) {
      const group=geometry.groups.find(g=>i>=g.start&&i<g.start+g.count), material=materials.length===1?materials[0]:materials[group?.materialIndex??0];
      if(!material?.visible) continue;
      const ids=[0,1,2].map(n=>index?index.getX(i+n):i+n);
      const world=ids.map(id=>new THREE.Vector3().fromBufferAttribute(position,id).applyMatrix4(mesh.matrixWorld));
      const normal=new THREE.Vector3().subVectors(world[1],world[0]).cross(new THREE.Vector3().subVectors(world[2],world[0])).normalize();
      if(normal.lengthSq()===0) continue;
      const center=world[0].clone().add(world[1]).add(world[2]).multiplyScalar(1/3);
      if(material.side===THREE.FrontSide && normal.dot(cameraPosition.clone().sub(center))<=0) continue;
      if(material.side===THREE.BackSide && normal.dot(cameraPosition.clone().sub(center))>=0) continue;
      const projected=world.map(v=>v.clone().project(camera));
      if(projected.some(v=>v.z < -1 || v.z > 1)) continue;
      const points=projected.map(v=>[(v.x*.5+.5)*W,(.5-v.y*.5)*H,v.z]);
      const role=material.userData.artworkRole??material.userData.artworkPart;
      const color=new THREE.Color(material.color??0xcccccc).convertLinearToSRGB();
      const shade=role?1:.5+.5*Math.max(0,normal.dot(light));
      const alpha=material.transparent?Math.min(.55,material.opacity):1;
      const triangle={points, uv:ids.map(id=>uv?[uv.getX(id),uv.getY(id)]:[0,0]), role,color:[color.r*255*shade,color.g*255*shade,color.b*255*shade],alpha,depth:points.reduce((s,p)=>s+p[2],0)/3};
      (alpha<1?clear:opaque).push(triangle);
    }
  });
  clear.sort((a,b)=>b.depth-a.depth);
  return [...opaque,...clear];
}

function raster(model, camera) {
  const pixels=Buffer.alloc(W*H*4), depths=new Float32Array(W*H).fill(Infinity);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const p=(y*W+x)*4,t=y/H;pixels[p]=24-6*t;pixels[p+1]=29-7*t;pixels[p+2]=36-8*t;pixels[p+3]=255;}
  for(const triangle of triangles(model,camera)) {
    const [a,b,c]=triangle.points, area=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
    if(Math.abs(area)<.001)continue;
    const minX=Math.max(0,Math.floor(Math.min(a[0],b[0],c[0]))),maxX=Math.min(W-1,Math.ceil(Math.max(a[0],b[0],c[0])));
    const minY=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1]))),maxY=Math.min(H-1,Math.ceil(Math.max(a[1],b[1],c[1])));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++) {
      const px=x+.5,py=y+.5;
      const wa=((b[1]-c[1])*(px-c[0])+(c[0]-b[0])*(py-c[1]))/area;
      const wb=((c[1]-a[1])*(px-c[0])+(a[0]-c[0])*(py-c[1]))/area,wc=1-wa-wb;
      if(wa<-.0001||wb<-.0001||wc<-.0001)continue;
      const depth=wa*a[2]+wb*b[2]+wc*c[2],offset=y*W+x;
      if(depth>depths[offset]+.00001)continue;
      let color=triangle.color;
      const fixture=textures[triangle.role];
      if(fixture){const u=wa*triangle.uv[0][0]+wb*triangle.uv[1][0]+wc*triangle.uv[2][0],v=wa*triangle.uv[0][1]+wb*triangle.uv[1][1]+wc*triangle.uv[2][1];const {width,height}=fixture.info;const tx=Math.max(0,Math.min(width-1,Math.round(u*(width-1)))),ty=Math.max(0,Math.min(height-1,Math.round((1-v)*(height-1)))),p=(ty*width+tx)*4;color=[fixture.data[p],fixture.data[p+1],fixture.data[p+2]];}
      const p=offset*4,alpha=triangle.alpha;
      for(let n=0;n<3;n++)pixels[p+n]=Math.round(color[n]*alpha+pixels[p+n]*(1-alpha));
      if(alpha===1)depths[offset]=depth;
    }
  }
  return pixels;
}

const views=[
  {name:"front",position:[0,1.35,1.7],open:false,inside:false,disc:true,tray:"clear"},
  {name:"open-clear",position:[1.25,1.05,1.35],open:true,inside:false,disc:true,tray:"clear"},
  {name:"back",position:[0,-1.2,-1.7],open:false,inside:false,disc:true,tray:"clear"},
  {name:"inside",position:[.15,1.65,.35],open:true,inside:true,disc:false,tray:"clear"},
  {name:"open-no-disc",position:[1.25,1.05,1.35],open:true,inside:false,disc:false,tray:"clear"},
  {name:"open-black",position:[1.25,1.05,1.35],open:true,inside:false,disc:true,tray:"black"},
  {name:"spine-left",position:[-500,0,0],open:false,inside:false,disc:true,tray:"clear"},
  {name:"spine-right",position:[500,0,0],open:false,inside:false,disc:true,tray:"clear"},
];
const images=[];
for(const view of views){
  const model=createJewelModel();model.setLidOpen(view.open);model.setInspection(view.inside,view.disc,view.tray);model.root.updateMatrixWorld(true);
  const bounds=new THREE.Box3();model.root.traverse(o=>{if(o instanceof THREE.Mesh&&visible(o))bounds.expandByObject(o);});
  const center=bounds.getCenter(new THREE.Vector3()),camera=new THREE.OrthographicCamera(-170,170,140,-140,1,1600);camera.position.copy(center).add(new THREE.Vector3(...view.position).normalize().multiplyScalar(500));camera.lookAt(center);camera.updateMatrixWorld(true);
  const extent=new THREE.Box3();for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])extent.expandByPoint(new THREE.Vector3(x,y,z).applyMatrix4(camera.matrixWorldInverse));
  const half=Math.max((extent.max.x-extent.min.x)/2*1.14,(extent.max.y-extent.min.y)/2*W/H*1.14);camera.left=-half;camera.right=half;camera.top=half*H/W;camera.bottom=-half*H/W;camera.updateProjectionMatrix();
  const png=await sharp(raster(model,camera),{raw:{width:W,height:H,channels:4}}).png().toBuffer();
  const title=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="680" height="48"><text x="22" y="31" font-family="sans-serif" font-size="20" fill="#edf2f7">${view.name} — same geometry / UV proof</text></svg>`);
  const labeled=await sharp(png).composite([{input:title,top:0,left:0}]).png().toBuffer();
  await fs.promises.writeFile(path.join(out,`${view.name}.png`),labeled);images.push(labeled);model.dispose();
}
await sharp({create:{width:W*3,height:H*Math.ceil(images.length/3),channels:4,background:"#161c24"}}).composite(images.map((input,i)=>({input,left:(i%3)*W,top:Math.floor(i/3)*H}))).png().toFile(path.join(out,"contact-sheet.png"));
console.log(`Geometry/UV proof: ${out}/contact-sheet.png (not a GPU/PBR screenshot)`);
