"use client";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { AlbumProject } from "@/lib/types";
import type { PreviewArtworkSet, PreviewArtworkSource } from "@/lib/jewel-preview";
import { applyArtworkTexture, createJewelModel, type JewelModel, type JewelTrayStyle } from "@/lib/jewel-model";
import { cameraDistanceLimits, lidAngle, projectedFitDistance, trackOverlayLayout } from "@/lib/jewel-mesh";
import { createDistinctPercentReporter, hasHealthyFrame, hasRenderableFrame, refitAlongCurrentView, settleControls } from "@/lib/jewel-controls";
import styles from "./webgl-jewel.module.css";
export interface WebglJewelHandle {
    zoom(delta: number): void;
    orbit(azimuth: number, polar: number): void;
    pan(dx: number, dy: number): void;
    reset(): void;
}
type ViewPreset = "front" | "open" | "back" | "inside";
interface Props {
    project: AlbumProject;
    artwork: PreviewArtworkSet;
    lidOpen: boolean;
    autoRotate: boolean;
    reduceMotion: boolean;
    viewPreset?: ViewPreset;
    viewRevision?: number;
    trayStyle?: JewelTrayStyle;
    discVisible?: boolean;
    onInitializing?(): void;
    onFailure(reason?: string): void;
    onReady?(): void;
    onZoom?(percent: number): void;
}
async function makeTexture(source: PreviewArtworkSource, project: AlbumProject, signal: AbortSignal) {
    const max = source.part === "back" ? 1536 : 1024, canvas = document.createElement("canvas"), aspect = source.widthMm / source.heightMm;
    canvas.width = aspect >= 1 ? max : Math.round(max * aspect);
    canvas.height = aspect >= 1 ? Math.round(max / aspect) : max;
    const ctx = canvas.getContext("2d");
    if (!ctx)
        throw new Error("Canvas 2D unavailable");
    ctx.fillStyle = "#20252c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (source.kind === "image") {
        const image = new Image();
        image.decoding = "async";
        image.src = source.url;
        await image.decode();
        if (signal.aborted)
            throw new DOMException("Aborted", "AbortError");
        if (source.fit === "contain") {
            const s = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight), w = image.naturalWidth * s * 1.08, h = image.naturalHeight * s * 1.08;
            ctx.save();
            ctx.globalAlpha = .46;
            ctx.filter = `blur(${Math.max(12, canvas.width * .025)}px)`;
            ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            ctx.restore();
        }
        const fit = source.fit === "cover" ? Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) : Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight), scale = fit * source.transform.scale, w = image.naturalWidth * scale, h = image.naturalHeight * scale;
        ctx.drawImage(image, (canvas.width - w) / 2 + source.transform.offsetXMm / source.widthMm * canvas.width, (canvas.height - h) / 2 + source.transform.offsetYMm / source.heightMm * canvas.height, w, h);
        if (source.overlay.enabled) {
            const px = Math.max(12, source.overlay.fontSizeMm / source.heightMm * canvas.height);
            ctx.fillStyle = source.overlay.color;
            ctx.textAlign = "center";
            ctx.font = `700 ${px}px system-ui, sans-serif`;
            if (source.part === "back-spine") {
                ctx.save();
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.rotate(Math.PI / 2);
                ctx.fillText(`${project.artist} · ${project.title}`, 0, px * .35, canvas.height * .86);
                ctx.restore();
            }
            else {
                const isBack = source.part === "back", layout = trackOverlayLayout(canvas.height, px, project.tracks.length, source.overlay.position), y = isBack ? layout.y : source.overlay.position === "top" ? canvas.height * .07 + px : canvas.height * .9 - px;
                ctx.fillText(project.title, canvas.width / 2, y);
                ctx.font = `500 ${px * .66}px system-ui`;
                ctx.fillText(project.artist, canvas.width / 2, y + px * .9);
                if (isBack) {
                    ctx.textAlign = "left";
                    ctx.font = `500 ${layout.trackPx}px ui-monospace`;
                    project.tracks.forEach((track, index) => { const col = Math.floor(index / layout.rows), row = index % layout.rows, cw = canvas.width * .78 / layout.columns; ctx.fillText(`${String(track.order).padStart(2, "0")}  ${track.title}`, canvas.width * .11 + col * cw, y + layout.titleHeight + row * layout.trackPx * 1.32, cw * .92); });
                }
            }
        }
    }
    else {
        ctx.fillStyle = "#87919d";
        ctx.textAlign = "center";
        ctx.font = "600 32px system-ui";
        ctx.fillText("아트워크 없음", canvas.width / 2, canvas.height / 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
}
export default forwardRef<WebglJewelHandle, Props>(function WebglJewel({ project, artwork, lidOpen, autoRotate, reduceMotion, viewPreset = "front", viewRevision = 0, trayStyle = "clear", discVisible = true, onInitializing, onFailure, onReady, onZoom }, ref) {
    const host = useRef<HTMLDivElement>(null), cameraRef = useRef<THREE.PerspectiveCamera | null>(null), controlsRef = useRef<OrbitControls | null>(null), modelRef = useRef<JewelModel | null>(null), wakeRef = useRef<(() => void) | null>(null), fitRef = useRef(220), zoomRef = useRef(1), presetRef = useRef<((preset: ViewPreset) => void) | null>(null);
    const [status, setStatus] = useState("3D 케이스를 조립하는 중…");
    const stateRef = useRef({ lidOpen, autoRotate, reduceMotion, viewPreset, viewRevision, trayStyle, discVisible });
    stateRef.current = { lidOpen, autoRotate, reduceMotion, viewPreset, viewRevision, trayStyle, discVisible };
    const callbacks = useRef({ onInitializing, onFailure, onReady, onZoom });
    callbacks.current = { onInitializing, onFailure, onReady, onZoom };
    useLayoutEffect(() => { callbacks.current.onInitializing?.(); }, [artwork, project]);
    useImperativeHandle(ref, () => ({
        zoom(delta) { const c = cameraRef.current, o = controlsRef.current; if (!c || !o) return; zoomRef.current = THREE.MathUtils.clamp(zoomRef.current * (delta > 0 ? 1.12 : .88), .62, 1.7); const d = c.position.clone().sub(o.target).normalize(); c.position.copy(o.target).addScaledVector(d, fitRef.current / zoomRef.current); o.update(); wakeRef.current?.(); },
        orbit(a, p) { controlsRef.current?.rotateLeft(a); controlsRef.current?.rotateUp(p); wakeRef.current?.(); },
        pan(x, y) { controlsRef.current?.pan(x, y); wakeRef.current?.(); },
        reset() { zoomRef.current = 1; presetRef.current?.(stateRef.current.viewPreset); },
    }), []);
    useEffect(() => { modelRef.current?.setInspection(viewPreset === "inside", discVisible, trayStyle); wakeRef.current?.(); }, [trayStyle, discVisible, viewPreset]);
    useEffect(() => {
        zoomRef.current = 1;
        presetRef.current?.(viewPreset);
        wakeRef.current?.();
    }, [viewPreset, viewRevision]);
    useEffect(() => { wakeRef.current?.(); }, [lidOpen, reduceMotion]);
    useEffect(() => { wakeRef.current?.(); }, [autoRotate]);
    useEffect(() => {
        const mount = host.current;
        if (!mount)
            return;
        const abort = new AbortController();
        let renderer: THREE.WebGLRenderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
        }
        catch {
            setStatus("이 환경에서는 3D 미리보기를 사용할 수 없습니다.");
            callbacks.current.onFailure("3D 렌더러를 시작할 수 없습니다.");
            return;
        }
        let shaderFailed = false;
        let reportShaderFailure = () => {};
        renderer.debug.onShaderError = () => { shaderFailed = true; reportShaderFailure(); };
        try {
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.shadowMap.enabled = true;
            renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
            renderer.domElement.className = styles.canvas;
            renderer.domElement.setAttribute("aria-hidden", "true");
            mount.appendChild(renderer.domElement);
        }
        catch {
            renderer.debug.onShaderError = null;
            renderer.dispose();
            renderer.domElement.remove();
            callbacks.current.onFailure("3D 화면을 페이지에 연결하지 못했습니다.");
            return;
        }
        let scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: OrbitControls;
        try {
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(34, 1, 1, 1800);
            cameraRef.current = camera;
            controls = new OrbitControls(camera, renderer.domElement);
            controlsRef.current = controls;
            controls.enableDamping = true;
            controls.dampingFactor = .07;
        }
        catch {
            renderer.debug.onShaderError = null;
            renderer.dispose();
            renderer.domElement.remove();
            cameraRef.current = null;
            controlsRef.current = null;
            callbacks.current.onFailure("3D 카메라 조작을 준비하지 못했습니다.");
            return;
        }
        let env: THREE.WebGLRenderTarget | undefined, pmrem: THREE.PMREMGenerator | undefined, room: RoomEnvironment | undefined;
        try {
            pmrem = new THREE.PMREMGenerator(renderer);
            room = new RoomEnvironment();
            env = pmrem.fromScene(room);
            if (shaderFailed)
                throw new Error("WebGL shader compilation failed");
            scene.environment = env.texture;
            room.dispose();
            pmrem.dispose();
        }
        catch {
            room?.dispose();
            pmrem?.dispose();
            env?.dispose();
            controls.dispose();
            renderer.debug.onShaderError = null;
            renderer.dispose();
            renderer.domElement.remove();
            cameraRef.current = null;
            controlsRef.current = null;
            callbacks.current.onFailure("3D 조명 환경을 준비하지 못했습니다.");
            return;
        }
        const activeEnv = env;
        let model: JewelModel | undefined;
        let floor: THREE.Mesh | undefined;
        let key: THREE.DirectionalLight | undefined;
        try {
            scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x15181e, 1.35));
            key = new THREE.DirectionalLight(0xffffff, 2.3);
            key.position.set(-90, 180, 100);
            key.castShadow = true;
            key.shadow.mapSize.set(1024, 1024);
            key.shadow.camera.left = -190;
            key.shadow.camera.right = 190;
            key.shadow.camera.top = 190;
            key.shadow.camera.bottom = -190;
            scene.add(key);
            model = createJewelModel();
            modelRef.current = model;
            model.setInspection(stateRef.current.viewPreset === "inside", stateRef.current.discVisible, stateRef.current.trayStyle);
            model.setLidOpen(stateRef.current.lidOpen || stateRef.current.viewPreset === "open" || stateRef.current.viewPreset === "inside");
            scene.add(model.root);
            floor = new THREE.Mesh(new THREE.CircleGeometry(280, 64), new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: .78 }));
            floor.rotation.x = -Math.PI / 2;
            floor.position.y = -2;
            floor.receiveShadow = true;
            scene.add(floor);
        }
        catch {
            model?.dispose();
            key?.dispose();
            activeEnv.dispose();
            controls.dispose();
            renderer.debug.onShaderError = null;
            renderer.dispose();
            renderer.domElement.remove();
            cameraRef.current = null;
            controlsRef.current = null;
            setStatus("3D 케이스 모델을 조립하지 못했습니다.");
            callbacks.current.onFailure("3D 케이스 모델을 조립하지 못했습니다.");
            return;
        }
        const activeModel = model;
        let modelRendered = false;
        activeModel.root.traverse((object) => {
            if (!(object instanceof THREE.Mesh))
                return;
            object.onAfterRender = (_renderer, _scene, renderCamera, _geometry, material) => {
                if (renderCamera === camera && material.transparent === false)
                    modelRendered = true;
            };
        });
        const textures: THREE.Texture[] = [];
        const jobs: [
            [
                PreviewArtworkSource,
                keyof JewelModel["artworkMaterials"]
            ],
            ...Array<[
                PreviewArtworkSource,
                keyof JewelModel["artworkMaterials"]
            ]>
        ] = [[artwork.front, "front"], [artwork.frontInner, "frontInner"], [artwork.back, "back"], [artwork.backInner, "backInner"], [artwork.backSpine, "spineLeft"], [artwork.backSpine, "spineRight"], [artwork.label, "label"]];
        Promise.allSettled(jobs.map(async ([source, role]) => { const t = await makeTexture(source, project, abort.signal); if (abort.signal.aborted) { t.dispose(); throw new DOMException("Aborted", "AbortError"); } textures.push(t); applyArtworkTexture(model!.artworkMaterials[role], t); })).then(r => { if (!abort.signal.aborted) {
            setStatus(r.some(x => x.status === "rejected") ? "일부 아트워크는 기본 재질로 표시합니다." : "");
            wakeRef.current?.();
        } });
        let viewportReady = false, firstFrame = false, failed = false, running = false, raf = 0, last = performance.now();
        let suppressControlFeedback = false;
        const emitZoom = createDistinctPercentReporter(percent => callbacks.current.onZoom?.(percent));
        const reportZoom = () => emitZoom(zoomRef.current);
        const bounds = new THREE.Box3(), center = new THREE.Vector3();
        const updateTransitionBounds = (preset: ViewPreset) => {
            const targetOpen = stateRef.current.lidOpen || preset === "open" || preset === "inside";
            const targetAngle = lidAngle(targetOpen ? "open" : "closed");
            const previousAngle = model.lid.rotation.z;
            model.lid.rotation.z = targetAngle;
            model.root.updateMatrixWorld(true);
            bounds.setFromObject(model.root);
            if (!stateRef.current.reduceMotion) {
                model.lid.rotation.z = previousAngle;
                model.root.updateMatrixWorld(true);
                bounds.union(new THREE.Box3().setFromObject(model.root));
            }
            return bounds;
        };
        const boundPoints = (origin: THREE.Vector3) => {
            const points: THREE.Vector3[] = [];
            for (const x of [bounds.min.x, bounds.max.x])
                for (const y of [bounds.min.y, bounds.max.y])
                    for (const z of [bounds.min.z, bounds.max.z])
                        points.push(new THREE.Vector3(x - origin.x, y - origin.y, z - origin.z));
            return points;
        };
        const applyPreset = (preset: ViewPreset) => {
            const requestedZoom = zoomRef.current;
            updateTransitionBounds(preset);
            floor.visible = preset !== "back";
            bounds.getCenter(center);
            const directionByPreset: { [K in ViewPreset]: THREE.Vector3 } = {
                front: new THREE.Vector3(0, 1.35, 1.7),
                open: new THREE.Vector3(1.25, 1.05, 1.35),
                back: new THREE.Vector3(0, -1.2, -1.7),
                inside: new THREE.Vector3(.15, 1.65, .35),
            };
            const direction = directionByPreset[preset].normalize();
            fitRef.current = projectedFitDistance(boundPoints(center), direction, camera.aspect, camera.fov);
            const limits = cameraDistanceLimits(fitRef.current);
            controls.minDistance = limits.min;
            controls.maxDistance = limits.max;
            suppressControlFeedback = true;
            try {
                settleControls(controls, () => {
                    controls.target.copy(center);
                    camera.position.copy(center).add(direction.multiplyScalar(fitRef.current / requestedZoom));
                    camera.up.set(0, 1, 0);
                    camera.lookAt(center);
                });
            }
            finally {
                zoomRef.current = requestedZoom;
                suppressControlFeedback = false;
            }
            reportZoom();
        };
        presetRef.current = applyPreset;
        let hasInitialFraming = false;
        const resize = () => {
            const { width, height } = mount.getBoundingClientRect();
            if (!width || !height) { viewportReady = false; return; }
            viewportReady = true;
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            if (!hasInitialFraming) {
                applyPreset(stateRef.current.viewPreset);
                hasInitialFraming = true;
            }
            else {
                updateTransitionBounds(stateRef.current.viewPreset);
                const direction = camera.position.clone().sub(controls.target).normalize();
                fitRef.current = projectedFitDistance(boundPoints(controls.target), direction, camera.aspect, camera.fov);
                const limits = cameraDistanceLimits(fitRef.current);
                controls.minDistance = limits.min;
                controls.maxDistance = limits.max;
                refitAlongCurrentView(camera, controls.target, fitRef.current / zoomRef.current);
            }
            wakeRef.current?.();
        };
        let observer: ResizeObserver | undefined;
        try {
            observer = new ResizeObserver(resize);
            observer.observe(mount);
            resize();
        }
        catch {
            observer?.disconnect();
            abort.abort();
            textures.forEach(texture => texture.dispose());
            model.dispose();
            key.dispose();
            floor.geometry.dispose();
            (floor.material as THREE.Material).dispose();
            activeEnv.dispose();
            controls.dispose();
            renderer.debug.onShaderError = null;
            renderer.dispose();
            cameraRef.current = null;
            controlsRef.current = null;
            modelRef.current = null;
            wakeRef.current = null;
            presetRef.current = null;
            callbacks.current.onFailure("3D 표시 영역의 크기를 읽지 못했습니다.");
            return;
        }
        const start = () => { if (running || document.hidden)
            return; try {
            running = true;
            last = performance.now();
            raf = requestAnimationFrame(render);
        }
        catch {
            running = false;
            fail("3D 화면 갱신을 시작하지 못했습니다.");
        } }, stop = () => { running = false; cancelAnimationFrame(raf); };
        wakeRef.current = start;
        const sync = () => { if (suppressControlFeedback) return; start(); const distance = camera.position.distanceTo(controls.target); zoomRef.current = THREE.MathUtils.clamp(fitRef.current / distance, .62, 1.7); reportZoom(); };
        controls.addEventListener("change", sync);
        let watchdog = 0, watchdogRemaining = 4500, watchdogStarted = 0;
        const pauseWatchdog = () => { if (!watchdog)
            return; window.clearTimeout(watchdog); watchdog = 0; watchdogRemaining = Math.max(0, watchdogRemaining - (performance.now() - watchdogStarted)); };
        const armWatchdog = () => { if (watchdog || firstFrame || failed || document.hidden)
            return; watchdogStarted = performance.now(); watchdog = window.setTimeout(() => { watchdog = 0; if (!firstFrame)
            fail(viewportReady ? "3D 첫 화면 준비가 너무 오래 걸렸습니다." : "3D 표시 영역의 크기가 잡히지 않았습니다."); }, watchdogRemaining); };
        function fail(message: string) { if (failed || abort.signal.aborted)
            return; failed = true; pauseWatchdog(); stop(); setStatus(message); callbacks.current.onFailure(message); }
        reportShaderFailure = () => fail("3D 화면 재질을 그리지 못했습니다.");
        function render(now: number) { if (!running || failed)
            return; running = false; if (!viewportReady)
            return; const s = stateRef.current, open = s.lidOpen || s.viewPreset === "open" || s.viewPreset === "inside"; const target = open ? 114 * Math.PI / 180 : 0, delta = Math.abs(activeModel.lid.rotation.z - target); activeModel.lid.rotation.z = s.reduceMotion ? target : THREE.MathUtils.lerp(activeModel.lid.rotation.z, target, .1); controls.autoRotate = s.autoRotate && !s.reduceMotion; controls.autoRotateSpeed = .55; let moving = false; try {
            moving = controls.update((now - last) / 1000);
            last = now;
            if (renderer.getContext().isContextLost() || shaderFailed)
                throw new Error();
            modelRendered = false;
            renderer.render(scene, camera);
            const frameIsValid = firstFrame ? hasHealthyFrame(renderer, shaderFailed) : hasRenderableFrame(renderer, shaderFailed, modelRendered);
            if (!frameIsValid)
                throw new Error();
            if (!firstFrame) {
                firstFrame = true;
                pauseWatchdog();
                callbacks.current.onReady?.();
            }
        }
        catch {
            fail("3D 첫 화면을 그리지 못했습니다.");
            return;
        } if (controls.autoRotate || moving || delta > .001)
            start(); }
        const lost = (e: Event) => { e.preventDefault(); fail("3D 연결이 끊겼습니다."); }, visibility = () => { if (document.hidden) { pauseWatchdog(); stop(); }
        else { armWatchdog(); start(); } };
        renderer.domElement.addEventListener("webglcontextlost", lost);
        document.addEventListener("visibilitychange", visibility);
        armWatchdog();
        start();
        return () => { abort.abort(); pauseWatchdog(); stop(); observer?.disconnect(); renderer.domElement.removeEventListener("webglcontextlost", lost); document.removeEventListener("visibilitychange", visibility); controls.removeEventListener("change", sync); controls.dispose(); textures.forEach(t => t.dispose()); model.dispose(); key.dispose(); floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); activeEnv.dispose(); renderer.debug.onShaderError = null; renderer.dispose(); renderer.domElement.remove(); cameraRef.current = null; controlsRef.current = null; modelRef.current = null; wakeRef.current = null; presetRef.current = null; };
    }, [artwork, project]);
    return <div ref={host} className={styles.stage}>{status && <div className={styles.status} role="status">{status}</div>}</div>;
});
