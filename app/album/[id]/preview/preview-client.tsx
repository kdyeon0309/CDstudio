"use client";

import Link from "next/link";
import Image from "next/image";
import dynamic from "next/dynamic";
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent } from "react";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlbumProject } from "@/lib/types";
import { canRenderJewelWebgl, deriveJewelArtwork, type PreviewArtworkSource } from "@/lib/jewel-preview";
import styles from "./preview.module.css";
import type { WebglJewelHandle } from "./webgl-jewel";

const WebglJewel = dynamic(() => import("./webgl-jewel"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-fg-muted" role="status">정밀 미리보기를 준비하는 중…</div>,
});

class WebglErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: number;
  onError: (reason?: string) => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError("3D 구성 요소를 불러오지 못했습니다."); }
  componentDidUpdate(previous: Readonly<{ resetKey: number }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() { return this.state.failed ? null : this.props.children; }
}

const INITIAL_VIEW = { x: -12, panX: 0, panY: 4, zoom: 1 };
const INITIAL_YAW = -24;
const ZOOM_MIN = 0.62;
const ZOOM_MAX = 1.7;

export type PreviewPreset = "front" | "open" | "back" | "inside";
export type TrayStyle = "clear" | "black";
export type WebglFallbackState = { kind: "automatic"; reason: string } | { kind: "manual" } | null;

export function resolvePreviewPreset(preset: PreviewPreset) {
  return {
    lidOpen: preset === "open" || preset === "inside",
    inspectInside: preset === "inside",
    yaw: preset === "back" ? 156 : preset === "open" || preset === "inside" ? -18 : -24,
    pitch: preset === "open" || preset === "inside" ? -18 : -12,
  } as const;
}

export function resolveManualLidPreset(preset: PreviewPreset, lidOpen: boolean): PreviewPreset {
  if (preset === "inside") return lidOpen ? "front" : "open";
  return lidOpen ? "front" : "open";
}

export function resolveAssemblyVisibility(preset: PreviewPreset, trayStyle: TrayStyle, discVisible: boolean) {
  const inspecting = preset === "inside";
  return {
    showTray: !inspecting,
    showDisc: !inspecting && discVisible,
    innerExposed: inspecting || (trayStyle === "clear" && !discVisible),
  } as const;
}

export function remainingForegroundTime(remainingMs: number, startedAtMs: number, nowMs: number) {
  return Math.max(0, remainingMs - Math.max(0, nowMs - startedAtMs));
}

export function resolveFallbackVisible(usesWebgl: boolean, webglReady: boolean) {
  return !(usesWebgl && webglReady);
}

export function resolveFallbackMessage(fallback: WebglFallbackState) {
  if (fallback?.kind === "automatic") return `${fallback.reason} 간단 미리보기로 전환했습니다.`;
  if (fallback?.kind === "manual") return "사용자가 간단 미리보기로 전환했습니다. 정밀 미리보기는 ‘다시 불러오기’로 다시 시도할 수 있습니다.";
  return "";
}

export function resolveWebglMode(webglAvailable: boolean, webglRequested: boolean, fallback: WebglFallbackState, webglReady: boolean) {
  const usesWebgl = webglAvailable && webglRequested && fallback === null;
  return {
    usesWebgl,
    webglInteractive: usesWebgl && webglReady,
    fallbackVisible: resolveFallbackVisible(usesWebgl, webglReady),
    canRequestWebgl: webglAvailable && !webglRequested && fallback === null,
    canRetryWebgl: webglAvailable && fallback !== null,
  } as const;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function Artwork({ source, project, className = "" }: {
  source: PreviewArtworkSource;
  project: AlbumProject;
  className?: string;
}) {
  if (source.kind === "placeholder") {
    return <div className={`${styles.placeholder} ${className}`}><span>아트워크 없음</span></div>;
  }
  const t = source.transform;
  const transform = `translate(${(t.offsetXMm / source.widthMm) * 100}%, ${(t.offsetYMm / source.heightMm) * 100}%) scale(${t.scale})`;
  return (
    <div className={`${styles.artwork} ${className}`}>
      {source.kind === "image" ? (
        <>
          {source.fit === "contain" && <Image className={styles.blurFill} src={source.url} alt="" aria-hidden="true" fill sizes="430px" quality={68} />}
          <div className={styles.artTransform} style={{ transform }}>
            <Image className={source.fit === "contain" ? styles.contain : styles.cover} src={source.url} alt="" fill sizes="430px" quality={76} draggable={false} />
          </div>
          {source.overlay.enabled && (
            <div className={`${styles.overlay} ${source.overlay.position === "top" ? styles.overlayTop : styles.overlayBottom}`} style={{ color: source.overlay.color, fontSize: source.part === "back-spine" ? `calc(var(--mm) * ${source.overlay.fontSizeMm})` : `${clamp(source.overlay.fontSizeMm * 0.14, 0.55, 1.2)}rem` }}>
              {source.part === "back-spine" ? (
                <strong className={styles.spineTitle}>{project.artist} · {project.title}</strong>
              ) : (
                <><strong>{project.title}</strong><span>{project.artist}</span>
                  {source.part === "back" && <ol className={styles.trackList}>{project.tracks.map((track) => <li key={track.id}><span>{String(track.order).padStart(2, "0")}</span><span>{track.title}</span></li>)}</ol>}
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div
          className={styles.legacyCanvas}
          data-part={source.part}
          style={{ width: `${source.widthMm}mm`, height: `${source.heightMm}mm` }}
        >
          <iframe className={styles.legacyFrame} style={{ transform: `translate(${t.offsetXMm}mm, ${t.offsetYMm}mm) scale(${t.scale})` }} src={source.url} title={`${source.part} 레거시 아트워크`} sandbox="" tabIndex={-1} />
        </div>
      )}
    </div>
  );
}

export default function PreviewClient({ projectId }: { projectId: string }) {
  return <PreviewContent key={projectId} projectId={projectId} />;
}

function PreviewContent({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState(INITIAL_VIEW);
  const [lidOpen, setLidOpen] = useState(false);
  const [viewPreset, setViewPreset] = useState<PreviewPreset>("front");
  const [viewRevision, setViewRevision] = useState(0);
  const [trayStyle, setTrayStyle] = useState<TrayStyle>("clear");
  const [discVisible, setDiscVisible] = useState(true);
  const [autoRotate, setAutoRotate] = useState(true);
  const [panMode, setPanMode] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [webglRequested, setWebglRequested] = useState(false);
  const [webglFallback, setWebglFallback] = useState<WebglFallbackState>(null);
  const [webglResetKey, setWebglResetKey] = useState(0);
  const [webglReady, setWebglReady] = useState(false);
  const webgl = useRef<WebglJewelHandle>(null);
  const drag = useRef<{ id: number; x: number; y: number; pan: boolean } | null>(null);
  const active = useRef(false);
  const pausedUntil = useRef(0);
  const yaw = useRef(INITIAL_YAW);
  const scene = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  const artwork = useMemo(() => project ? deriveJewelArtwork(project) : null, [project]);
  const webglAvailable = Boolean(artwork && canRenderJewelWebgl(artwork));
  const { usesWebgl, webglInteractive, fallbackVisible, canRequestWebgl, canRetryWebgl } = resolveWebglMode(webglAvailable, webglRequested, webglFallback, webglReady);
  const fallbackMessage = resolveFallbackMessage(webglFallback);

  const applyTransform = useCallback(() => {
    const current = viewRef.current;
    if (scene.current) scene.current.style.transform = `translate3d(${current.panX}px, ${current.panY}px, 0) scale(${current.zoom}) rotateX(${current.x}deg) rotateY(${yaw.current}deg)`;
  }, []);
  const noteInput = useCallback(() => {
    pausedUntil.current = performance.now() + 2500;
  }, []);
  const handleWebglFailure = useCallback((reason = "3D 미리보기를 준비하지 못했습니다.") => {
    setWebglRequested(false);
    setWebglFallback({ kind: "automatic", reason });
    setWebglReady(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "앨범을 찾을 수 없습니다." : "앨범을 불러오지 못했습니다.");
        return response.json() as Promise<AlbumProject>;
      })
      .then((nextProject) => { if (!controller.signal.aborted) setProject(nextProject); })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "앨범을 불러오지 못했습니다.");
      });
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (webglInteractive || !autoRotate || reduceMotion) return;
    let frame: number | null = null;
    let previous = performance.now();
    const tick = (now: number) => {
      frame = null;
      if (!active.current && now >= pausedUntil.current) {
        yaw.current += (now - previous) * 0.004;
        applyTransform();
      }
      previous = now;
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    const pause = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const resume = () => {
      if (document.hidden || frame !== null) return;
      previous = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const onVisibilityChange = () => { if (document.hidden) pause(); else resume(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    resume();
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applyTransform, autoRotate, reduceMotion, webglInteractive]);

  useEffect(() => {
    if (!usesWebgl || webglReady) return;
    let remainingMs = 4500;
    let startedAtMs: number | null = null;
    let timeout: number | null = null;
    const pause = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
      if (startedAtMs !== null) remainingMs = remainingForegroundTime(remainingMs, startedAtMs, performance.now());
      startedAtMs = null;
    };
    const resume = () => {
      if (document.hidden || timeout !== null) return;
      if (remainingMs <= 0) { handleWebglFailure("3D 첫 화면 준비가 너무 오래 걸렸습니다."); return; }
      startedAtMs = performance.now();
      timeout = window.setTimeout(() => handleWebglFailure("3D 첫 화면 준비가 너무 오래 걸렸습니다."), remainingMs);
    };
    const onVisibilityChange = () => { if (document.hidden) pause(); else resume(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    resume();
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [handleWebglFailure, usesWebgl, webglReady]);

  useEffect(() => {
    viewRef.current = view;
    applyTransform();
  }, [applyTransform, view]);

  const reset = useCallback(() => {
    setViewPreset("front");
    setViewRevision((revision) => revision + 1);
    setLidOpen(false);
    yaw.current = INITIAL_YAW;
    viewRef.current = INITIAL_VIEW;
    noteInput();
    setView({ ...INITIAL_VIEW });
    applyTransform();
  }, [applyTransform, noteInput]);
  const showSimplePreview = useCallback(() => {
    setWebglRequested(false);
    setWebglReady(false);
    setWebglFallback({ kind: "manual" });
    drag.current = null;
    active.current = false;
    setPanMode(false);
    setViewPreset("front");
    setViewRevision((revision) => revision + 1);
    setLidOpen(false);
    setAutoRotate(false);
    yaw.current = INITIAL_YAW;
    viewRef.current = { ...INITIAL_VIEW };
    setView({ ...INITIAL_VIEW });
    applyTransform();
  }, [applyTransform]);
  const requestWebgl = useCallback(() => {
    setWebglReady(false);
    setWebglFallback(null);
    setWebglResetKey((key) => key + 1);
    setWebglRequested(true);
  }, []);
  const retryWebgl = useCallback(() => {
    drag.current = null;
    active.current = false;
    setWebglReady(false);
    setWebglResetKey((key) => key + 1);
    setWebglFallback(null);
    setWebglRequested(true);
  }, []);
  const selectPreset = useCallback((preset: PreviewPreset) => {
    const next = resolvePreviewPreset(preset);
    noteInput();
    setViewPreset(preset);
    setViewRevision((revision) => revision + 1);
    setLidOpen(next.lidOpen);
    setAutoRotate(false);
    yaw.current = next.yaw;
    viewRef.current = { ...INITIAL_VIEW, x: next.pitch };
    setView({ ...INITIAL_VIEW, x: next.pitch });
    applyTransform();
  }, [applyTransform, noteInput]);
  const toggleLid = useCallback(() => {
    selectPreset(resolveManualLidPreset(viewPreset, lidOpen));
  }, [lidOpen, selectPreset, viewPreset]);
  const zoom = useCallback((delta: number) => { noteInput(); if (webglInteractive) { webgl.current?.zoom(delta); return; } setView((current) => ({ ...current, zoom: clamp(current.zoom + delta, ZOOM_MIN, ZOOM_MAX) })); }, [noteInput, webglInteractive]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: panMode || event.shiftKey || event.button === 2 };
    active.current = true;
    noteInput();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    state.x = event.clientX;
    state.y = event.clientY;
    noteInput();
    if (state.pan) setView((current) => ({ ...current, panX: current.panX + dx, panY: current.panY + dy }));
    else {
      yaw.current += dx * 0.35;
      setView((current) => ({ ...current, x: clamp(current.x - dy * 0.28, -65, 35) }));
    }
  };
  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
    active.current = false;
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    active.current = true;
    noteInput();
    zoom(event.deltaY < 0 ? 0.08 : -0.08);
    window.setTimeout(() => { if (!drag.current) active.current = false; }, 180);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "+", "=", "-", "o", "r"].includes(key)) event.preventDefault();
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "+", "=", "-", "o", "r"].includes(key)) noteInput();
    if (event.shiftKey && key.startsWith("arrow")) {
      const dx = key === "arrowleft" ? -20 : key === "arrowright" ? 20 : 0;
      const dy = key === "arrowup" ? -20 : key === "arrowdown" ? 20 : 0;
      if (webglInteractive) webgl.current?.pan(dx, dy);
      else setView((current) => ({ ...current, panX: current.panX + dx, panY: current.panY + dy }));
      return;
    }
    if (key === "arrowleft") { if (webglInteractive) webgl.current?.orbit(.1, 0); else { yaw.current -= 6; applyTransform(); } }
    if (key === "arrowright") { if (webglInteractive) webgl.current?.orbit(-.1, 0); else { yaw.current += 6; applyTransform(); } }
    if (key === "arrowup") { if (webglInteractive) webgl.current?.orbit(0, -.08); else setView((v) => ({ ...v, x: clamp(v.x + 5, -65, 35) })); }
    if (key === "arrowdown") { if (webglInteractive) webgl.current?.orbit(0, .08); else setView((v) => ({ ...v, x: clamp(v.x - 5, -65, 35) })); }
    if (key === "+" || key === "=") zoom(0.1);
    if (key === "-") zoom(-0.1);
    if (key === "o") toggleLid();
    if (key === "r") reset();
  };

  const assembly = resolveAssemblyVisibility(viewPreset, trayStyle, discVisible);
  if (error) return <div className="rounded-xl border border-rose/40 bg-rose/10 p-5 text-sm text-rose">{error}</div>;
  if (!project || !artwork) return <div className="py-20 text-center text-sm text-fg-muted" role="status">완성 CD를 조립하는 중…</div>;

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="font-mono text-[11px] uppercase tracking-[0.18em] text-teal">Finished CD</p><h2 className="mt-1 text-2xl font-semibold">완성 CD 3D 미리보기</h2><p className="mt-2 max-w-2xl text-sm text-fg-muted">선택한 인쇄 소스로 조립한 개념 모형입니다. 실제 인쇄 색상·재단·케이스 반사는 다를 수 있습니다.</p></div>
        <Link href={`/album/${encodeURIComponent(projectId)}/print`} className="rounded-lg border border-amber/50 px-4 py-2 text-sm text-amber-bright transition hover:bg-amber/10">인쇄 화면으로 →</Link>
      </div>

      <div className={styles.presetBar} aria-label="미리보기 시점">
        {([ ["front", "앞면"], ["open", "열린 모습"], ["back", "뒷면"], ["inside", "속지 확인"] ] as const).map(([preset, label]) => (
          <button key={preset} type="button" aria-pressed={viewPreset === preset} onClick={() => selectPreset(preset)}>{label}</button>
        ))}
      </div>
      <div className={styles.controls} aria-label="3D 미리보기 조작">
        <button type="button" aria-pressed={lidOpen} onClick={toggleLid}>{lidOpen ? "뚜껑 닫기" : "뚜껑 열기"} <kbd>O</kbd></button>
        <button type="button" aria-pressed={trayStyle === "clear"} onClick={() => setTrayStyle((value) => value === "clear" ? "black" : "clear")}>{trayStyle === "clear" ? "투명 트레이" : "검은 트레이"}</button>
        <button type="button" aria-pressed={viewPreset === "inside" ? false : discVisible} disabled={viewPreset === "inside"} onClick={() => setDiscVisible((visible) => !visible)}>{viewPreset === "inside" ? "속지 검사 중" : discVisible ? "CD 꽂힘" : "CD 제외"}</button>
        <button type="button" onClick={() => zoom(-0.1)} aria-label="축소">−</button>
        <span className={styles.zoomReadout}>{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => zoom(0.1)} aria-label="확대">+</button>
        {!webglInteractive && <button type="button" aria-pressed={panMode} onClick={() => { noteInput(); setPanMode((enabled) => !enabled); }}>이동 모드 {panMode ? "켜짐" : "꺼짐"}</button>}
        <button type="button" onClick={reset}>시점 초기화 <kbd>R</kbd></button>
        <button type="button" aria-pressed={autoRotate && !reduceMotion} disabled={reduceMotion} onClick={() => { noteInput(); setAutoRotate((value) => !value); }}>자동 회전 {reduceMotion ? "꺼짐" : autoRotate ? "켜짐" : "꺼짐"}</button>
        {canRequestWebgl && <button type="button" onClick={requestWebgl}>정밀 미리보기 시도</button>}
        {usesWebgl && <button type="button" onClick={showSimplePreview}>화면이 안 보이면 간단 미리보기로 전환</button>}
        {canRetryWebgl && <button type="button" onClick={retryWebgl}>다시 불러오기</button>}
      </div>

      <div className={styles.viewport} tabIndex={0} role="application" aria-label={`완성 CD 3D 모형. 화살표 키로 회전, Shift와 화살표 키로 이동, 더하기와 빼기로 확대 축소, O로 뚜껑 열기, R로 초기화합니다.${webglInteractive ? " 터치에서는 두 손가락으로 이동합니다." : panMode ? " 이동 모드가 켜져 한 손가락 드래그로 이동합니다." : " 한 손가락 드래그로 회전합니다."}`} onPointerDown={webglInteractive ? undefined : onPointerDown} onPointerMove={webglInteractive ? undefined : onPointerMove} onPointerUp={webglInteractive ? undefined : endPointer} onPointerCancel={webglInteractive ? undefined : endPointer} onWheel={webglInteractive ? undefined : onWheel} onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
        <div className={`${styles.floor} ${!fallbackVisible ? styles.fallbackHidden : ""}`} aria-hidden="true" />
        <div ref={scene} aria-hidden={!fallbackVisible} className={`${styles.scene} ${!fallbackVisible ? styles.fallbackHidden : ""} ${styles[`preset_${viewPreset}`]} ${trayStyle === "clear" ? styles.trayClear : styles.trayBlack} ${!assembly.showTray ? styles.trayRemoved : ""} ${!assembly.showDisc ? styles.discHidden : ""} ${assembly.innerExposed ? styles.innerExposed : ""}`}>
          <div className={styles.caseBase}>
            <div className={styles.backInsert}>
              <Artwork source={artwork.back} project={project} className={styles.backCenter} />
            </div>
            <Artwork source={artwork.backSpine} project={project} className={`${styles.spinePanel} ${styles.spineLeft}`} />
            <Artwork source={artwork.backSpine} project={project} className={`${styles.spinePanel} ${styles.spineRight}`} />
            <Artwork source={artwork.backInner} project={project} className={styles.backInner} />
            <div className={styles.tray}>
              <span className={styles.trayWell} aria-hidden="true" />
              <div className={styles.discAssembly}>
                <Artwork source={artwork.label} project={project} className={styles.disc} />
                <span className={styles.discGrooves} aria-hidden="true" />
                <span className={styles.discHole} aria-hidden="true" />
              </div>
              <span className={styles.hub} aria-hidden="true"><span /></span>
            </div>
            <span className={styles.baseLip} aria-hidden="true" />
            <span className={styles.hingeBar} aria-hidden="true" />
          </div>
          <div className={`${styles.lid} ${lidOpen ? styles.lidOpen : ""}`}>
            <Artwork source={artwork.frontInner} project={project} className={styles.frontInner} />
            <div className={styles.lidPlastic} aria-hidden="true" />
            <Artwork source={artwork.front} project={project} className={styles.frontInsert} />
            <span className={styles.lidEdge} aria-hidden="true" />
            <span className={styles.lidHinge} aria-hidden="true" />
          </div>
        </div>
        {usesWebgl && <div className={`${styles.webglLayer} ${webglReady ? styles.webglLayerReady : ""}`}>
          <WebglErrorBoundary resetKey={webglResetKey} onError={handleWebglFailure}>
            <WebglJewel key={webglResetKey} ref={webgl} project={project} artwork={artwork} lidOpen={lidOpen} autoRotate={autoRotate} reduceMotion={reduceMotion} viewPreset={viewPreset} viewRevision={viewRevision} trayStyle={trayStyle} discVisible={discVisible && viewPreset !== "inside"} onInitializing={() => setWebglReady(false)} onFailure={handleWebglFailure} onReady={() => setWebglReady(true)} onZoom={(percent) => setView((current) => current.zoom === percent / 100 ? current : { ...current, zoom: percent / 100 })} />
          </WebglErrorBoundary>
        </div>}
      </div>
      <p className={styles.help}>{webglInteractive ? "한 손가락 드래그: 회전 · 두 손가락 드래그/Shift+화살표: 이동" : `${panMode ? "이동 모드: 한 손가락 드래그로 이동" : "회전 모드: 한 손가락 드래그로 회전"} · Shift/오른쪽 드래그: 이동`} · 휠/+/−: 확대 · O: 뚜껑 · R: 시점 초기화</p>
      <p className={styles.motionNote}>표준 1CD 케이스 142 × 125 × 10.4mm · ‘속지 확인’은 CD와 트레이를 잠시 걷어 내부 인쇄면을 보여줍니다.</p>
      {trayStyle === "black" && viewPreset !== "inside" && <p className={styles.motionNote}>검은 트레이에서는 실제 조립 상태처럼 뒤쪽 속지가 가려집니다.</p>}
      {fallbackMessage && <p className={styles.motionNote} role="status">{fallbackMessage}</p>}
      {reduceMotion && <p className={styles.motionNote}>기기의 동작 줄이기 설정에 따라 자동 회전과 뚜껑 전환 애니메이션을 줄였습니다.</p>}
    </section>
  );
}
