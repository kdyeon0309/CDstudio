import * as THREE from "three";
import { lidAngle } from "./jewel-mesh";
export type ArtworkRole = "front" | "frontInner" | "back" | "backInner" | "spineLeft" | "spineRight" | "label";
export type JewelTrayStyle = "clear" | "black";
export interface JewelModel {
    root: THREE.Group;
    lid: THREE.Group;
    tray: THREE.Group;
    disc: THREE.Group;
    artworkMaterials: Record<ArtworkRole, THREE.MeshBasicMaterial>;
    setLidOpen(open: boolean): void;
    setInspection(inside: boolean, discVisible: boolean, trayStyle: JewelTrayStyle): void;
    dispose(): void;
}
export function applyArtworkTexture(material: THREE.MeshBasicMaterial, texture: THREE.Texture) {
    material.map = texture;
    material.color.set(0xffffff);
    material.needsUpdate = true;
}
// Geometry helpers intentionally have no DOM dependency so the same assembly is
// used by the browser renderer, numeric tests, and the offline QA renderer.
function box(name: string, w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.name = name; mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; return mesh; }
function art(role: ArtworkRole, color: number) { const material = new THREE.MeshBasicMaterial({ color, side: THREE.FrontSide }); material.name = `artwork-${role}`; material.userData.artworkRole = role; material.userData.artworkPart = role; return material; }
function plane(name: string, w: number, h: number, material: THREE.Material, x: number, y: number, z: number, rx: number, ry = 0) { const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material); mesh.name = name; mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, 0); return mesh; }
function setSpineUv(mesh: THREE.Mesh<THREE.PlaneGeometry>, right: boolean) {
    const uv = mesh.geometry.attributes.uv;
    const values = right ? [[1, 1], [1, 0], [0, 1], [0, 0]] : [[1, 1], [1, 0], [0, 1], [0, 0]];
    values.forEach(([u, v], index) => uv.setXY(index, u, v));
    uv.needsUpdate = true;
}
function rotateUv180(mesh: THREE.Mesh<THREE.PlaneGeometry>) { const uv = mesh.geometry.attributes.uv; for (let i = 0; i < uv.count; i++)
    uv.setXY(i, 1 - uv.getX(i), 1 - uv.getY(i)); uv.needsUpdate = true; }
function annulus(outer: number, inner: number, thickness: number) { const shape = new THREE.Shape(); shape.absarc(0, 0, outer, 0, Math.PI * 2); const hole = new THREE.Path(); hole.absarc(0, 0, inner, 0, Math.PI * 2, true); shape.holes.push(hole); const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 96 }); geometry.rotateX(Math.PI / 2); geometry.translate(0, thickness / 2, 0); return geometry; }
function trayDeckGeometry() {
    const width = 136, height = 121, radius = 60.15, centerX = 5;
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, -height / 2);
    shape.lineTo(width / 2, -height / 2);
    shape.lineTo(width / 2, height / 2);
    shape.lineTo(-width / 2, height / 2);
    shape.closePath();
    const well = new THREE.Path();
    well.absarc(centerX, 0, radius, 0, Math.PI * 2, true);
    shape.holes.push(well);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false, curveSegments: 128 });
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 1.8, 0);
    return geometry;
}
export function createJewelModel(): JewelModel {
    const root = new THREE.Group();
    root.name = "jewel-case";
    const plastic = new THREE.MeshPhysicalMaterial({ color: 0xddebf2, roughness: .18, clearcoat: .9, ior: 1.49, transparent: true, opacity: .2, depthWrite: false });
    const edge = plastic.clone();
    edge.color.set(0xa9bdc8);
    edge.opacity = .3;
    const trayClear = new THREE.MeshPhysicalMaterial({ color: 0xc8d9df, roughness: .24, clearcoat: .75, transparent: true, opacity: .24, depthWrite: false });
    const trayBlack = new THREE.MeshStandardMaterial({ color: 0x11151b, roughness: .52 }), discMaterial = new THREE.MeshPhysicalMaterial({ color: 0xcbd6dc, metalness: .72, roughness: .24, iridescence: 1, clearcoat: .65 }), paperEdge = new THREE.MeshStandardMaterial({ color: 0xe4e0d7, roughness: .82 });
    const artworkMaterials = { front: art("front", 0xddd8cc), frontInner: art("frontInner", 0xc9c4ba), back: art("back", 0x555b63), backInner: art("backInner", 0x666c72), spineLeft: art("spineLeft", 0x4b535b), spineRight: art("spineRight", 0x4b535b), label: art("label", 0x818a91) };
    // Rear shell and stationary hinge strip.
    const base = new THREE.Group();
    base.name = "rear-shell";
    root.add(base);
    base.add(box("rear-bottom", 142, 1.2, 125, plastic, 0, .6, 0), box("rear-wall-left", 1.4, 4.9, 125, edge, -70.3, 3.65, 0), box("rear-wall-right", 1.4, 4.9, 125, edge, 70.3, 3.65, 0), box("rear-wall-front", 139.2, 4.9, 1.4, edge, 0, 3.65, 61.8), box("rear-wall-back", 139.2, 4.9, 1.4, edge, 0, 3.65, -61.8), box("fixed-hinge-strip", 11, 1.2, 122.2, plastic, -65.5, 9.8, 0), box("fixed-strip-left-connector", 1.4, 3.1, 125, edge, -70.3, 7.65, 0), box("fixed-strip-front-connector", 9.6, 3.1, 1.4, edge, -65.5, 7.65, 61.8), box("fixed-strip-back-connector", 9.6, 3.1, 1.4, edge, -65.5, 7.65, -61.8));
    // The tray card is one thin sheet with independent printable faces and folds.
    const backPaper = new THREE.Group();
    backPaper.name = "back-paper";
    base.add(backPaper);
    const backOuter = plane("artwork-back", 137, 118, artworkMaterials.back, 0, 1.305, 0, Math.PI / 2);
    rotateUv180(backOuter);
    backPaper.add(box("back-paper-edge", 137, .22, 118, paperEdge, 0, 1.42, 0), backOuter);
    const inner = plane("artwork-back-inner", 137, 118, artworkMaterials.backInner, 0, 1.535, 0, -Math.PI / 2);
    const uv = inner.geometry.attributes.uv;
    uv.setX(0, 6.5 / 150);
    uv.setX(1, 143.5 / 150);
    uv.setX(2, 6.5 / 150);
    uv.setX(3, 143.5 / 150);
    const spineLeft = plane("artwork-spine-left", 118, 6.5, artworkMaterials.spineLeft, -68.61, 4.67, 0, 0, -Math.PI / 2), spineRight = plane("artwork-spine-right", 118, 6.5, artworkMaterials.spineRight, 68.61, 4.67, 0, 0, Math.PI / 2);
    setSpineUv(spineLeft, false);
    setSpineUv(spineRight, true);
    backPaper.add(inner, spineLeft, spineRight);
    // Molded tray: the CD rests on the thin floor inside a true raised-deck hole.
    const tray = new THREE.Group();
    tray.name = "tray";
    base.add(tray);
    tray.add(box("tray-support", 136, .55, 121, trayClear, 0, 1.925, 0));
    const deck = new THREE.Mesh(trayDeckGeometry(), trayClear);
    deck.name = "tray-raised-deck";
    deck.position.y = 2.2;
    deck.castShadow = true;
    deck.receiveShadow = true;
    tray.add(deck);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 7.2, 2.3, 48), trayClear);
    hub.name = "tray-hub-stem";
    hub.position.set(5, 3.35, 0);
    hub.castShadow = true;
    hub.receiveShadow = true;
    tray.add(hub);
    const hubLip = new THREE.Mesh(new THREE.CylinderGeometry(7.8, 7.8, .25, 48), trayClear);
    hubLip.name = "tray-hub-capture-lip";
    hubLip.position.set(5, 3.55, 0);
    hubLip.castShadow = true;
    tray.add(hubLip);
    [[-58, 48], [58, 48], [-58, -48], [58, -48]].forEach(([x, z], i) => tray.add(box(`tray-rib-${i}`, 16, .7, 1.2, trayClear, x, 2.55, z)));
    const disc = new THREE.Group();
    disc.name = "disc";
    disc.position.set(5, 2.8, 0);
    base.add(disc);
    const substrate = new THREE.Mesh(annulus(60, 7.5, 1.2), discMaterial);
    substrate.name = "disc-substrate";
    substrate.castShadow = true;
    substrate.receiveShadow = true;
    disc.add(substrate);
    const label = new THREE.Mesh(new THREE.RingGeometry(11.5, 58, 96), artworkMaterials.label);
    label.name = "artwork-label";
    label.rotation.x = -Math.PI / 2;
    label.position.y = .605;
    label.receiveShadow = true;
    disc.add(label);
    // Moving lid: local origin is the real hinge axis; the left strip remains fixed.
    const lid = new THREE.Group();
    lid.name = "lid-pivot";
    lid.position.set(-60.5, 6.9, 0);
    root.add(lid);
    lid.add(box("lid-top", 131, 1.2, 125, plastic, 65.5, 2.9, 0), box("lid-wall-right", 1.4, 4.3, 125, edge, 130.3, 1.35, 0), box("lid-wall-front", 128.6, 4.3, 1.4, edge, 65.7, 1.35, 61.8), box("lid-wall-back", 128.6, 4.3, 1.4, edge, 65.7, 1.35, -61.8));
    [-51, 51].forEach((z, i) => { const k = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 20, 24), edge); k.name = `lid-hinge-knuckle-${i}`; k.rotation.x = Math.PI / 2; k.position.set(0, 0, z); lid.add(k); const mate = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 18, 20), edge); mate.name = `rear-hinge-pin-${i}`; mate.rotation.x = Math.PI / 2; mate.position.set(-60.5, 6.9, z); base.add(mate); });
    const frontOuter = plane("artwork-front", 120, 120, artworkMaterials.front, 65.5, 2.205, 0, -Math.PI / 2), frontInner = plane("artwork-front-inner", 120, 120, artworkMaterials.frontInner, 65.5, 1.915, 0, Math.PI / 2);
    rotateUv180(frontInner);
    lid.add(box("booklet-paper", 120, .28, 120, paperEdge, 65.5, 2.06, 0), frontOuter, frontInner);
    [[5.5, 0, 1.1, 8], [125.5, 0, 1.1, 8], [65.5, 57.8, 8, 1.1], [65.5, -57.8, 8, 1.1]].forEach(([x, z, w, d], i) => lid.add(box(`booklet-retention-tab-${i}`, w, .45, d, edge, x, 1.88, z)));
    function setLidOpen(open: boolean) { lid.rotation.z = lidAngle(open ? "open" : "closed"); }
    function setInspection(inside: boolean, discVisible: boolean, trayStyle: JewelTrayStyle) { tray.visible = !inside; disc.visible = !inside && discVisible; tray.traverse(o => { if (o instanceof THREE.Mesh)
        o.material = trayStyle === "black" ? trayBlack : trayClear; }); }
    function dispose() { root.traverse(o => { if (o instanceof THREE.Mesh)
        o.geometry.dispose(); }); new Set<THREE.Material>([plastic, edge, trayClear, trayBlack, discMaterial, paperEdge, ...Object.values(artworkMaterials)]).forEach(m => m.dispose()); }
    setInspection(false, true, "clear");
    return { root, lid, tray, disc, artworkMaterials, setLidOpen, setInspection, dispose };
}
