export interface SettledControls {
  enableDamping: boolean;
  autoRotate: boolean;
  reset(): void;
  update(deltaTime?: number): boolean;
  saveState(): void;
}

/** Flushes public OrbitControls deltas before establishing a new saved pose. */
export function settleControls(controls: SettledControls, place: () => void) {
  const damping = controls.enableDamping;
  const autoRotate = controls.autoRotate;
  controls.enableDamping = false;
  controls.autoRotate = false;
  try {
    controls.update();
    controls.reset();
    controls.update();
    place();
    controls.update();
    controls.saveState();
  }
  finally {
    controls.enableDamping = damping;
    controls.autoRotate = autoRotate;
  }
}

export function refitAlongCurrentView(camera: { position: THREE.Vector3 }, target: THREE.Vector3, distance: number) {
  const direction = camera.position.clone().sub(target).normalize();
  camera.position.copy(target).addScaledVector(direction, distance);
  return direction;
}

export interface RenderReadinessProbe {
  info: { render: { calls: number } };
  getContext(): { NO_ERROR: number; getError(): number };
}

export function hasHealthyFrame(renderer: RenderReadinessProbe, shaderFailed: boolean) {
  const context = renderer.getContext();
  return !shaderFailed && context.getError() === context.NO_ERROR;
}

export function hasRenderableFrame(renderer: RenderReadinessProbe, shaderFailed: boolean, modelRendered: boolean) {
  return modelRendered && renderer.info.render.calls > 0 && hasHealthyFrame(renderer, shaderFailed);
}

export function createDistinctPercentReporter(report: (percent: number) => void) {
  let lastPercent: number | null = null;
  return (zoom: number) => {
    const percent = Math.round(zoom * 100);
    if (percent === lastPercent) return false;
    lastPercent = percent;
    report(percent);
    return true;
  };
}
import * as THREE from "three";
