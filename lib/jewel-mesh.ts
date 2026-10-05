/** Physical dimensions in millimetres. One Three.js unit is one millimetre. */
export const JEWEL_MESH = {
    case: { width: 142, height: 125, depth: 10.4, floorThickness: 1.2, wallThickness: 1.4 },
    hinge: { pivotX: -60.5, pivotY: 6.9, fixedStripWidth: 11, openDegrees: 114 },
    disc: { centerX: 5, outerRadius: 60, innerRadius: 7.5, thickness: 1.2 },
    label: { outerRadius: 58, innerRadius: 11.5 },
    booklet: { width: 120, height: 120, thickness: 0.28 },
    backCard: { centerWidth: 137, totalWidth: 150, height: 118, foldWidth: 6.5, thickness: 0.22 },
    tray: { width: 136, height: 121, supportY: 2.2, deckTopY: 4, wellRadius: 60.15, thickness: 0.55 },
    layers: { discCenterY: 2.8, labelY: 3.405, bookletOuterY: 9.105, bookletInnerY: 8.815, backOuterY: 1.305, backInnerY: 1.535 },
} as const;
export type JewelPose = "closed" | "open";
export function lidAngle(pose: JewelPose) { return pose === "open" ? JEWEL_MESH.hinge.openDegrees * Math.PI / 180 : 0; }
export function cameraDistanceLimits(fitDistance: number, zoomMin = .62, zoomMax = 1.7) { return { min: Math.max(45, fitDistance / zoomMax * .9), max: Math.max(480, fitDistance / zoomMin * 1.05) }; }
export interface CameraFitPoint {
    x: number;
    y: number;
    z: number;
}
export function projectedFitDistance(points: CameraFitPoint[], direction: CameraFitPoint, aspect: number, verticalFovDegrees = 34, margin = 1.16) {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1, d = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
    const upSeed = Math.abs(d.y) > .98 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const rx = upSeed.y * d.z - upSeed.z * d.y, ry = upSeed.z * d.x - upSeed.x * d.z, rz = upSeed.x * d.y - upSeed.y * d.x, rLength = Math.hypot(rx, ry, rz) || 1, right = { x: rx / rLength, y: ry / rLength, z: rz / rLength };
    const up = { x: d.y * right.z - d.z * right.y, y: d.z * right.x - d.x * right.z, z: d.x * right.y - d.y * right.x };
    const vfov = verticalFovDegrees * Math.PI / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(.1, aspect));
    let distance = 0;
    for (const point of points) {
        const toward = point.x * d.x + point.y * d.y + point.z * d.z, horizontal = Math.abs(point.x * right.x + point.y * right.y + point.z * right.z), vertical = Math.abs(point.x * up.x + point.y * up.y + point.z * up.z);
        distance = Math.max(distance, toward + margin * horizontal / Math.tan(hfov / 2), toward + margin * vertical / Math.tan(vfov / 2));
    }
    return distance;
}
export function trackOverlayLayout(canvasHeight: number, titlePx: number, trackCount: number, position: "top" | "bottom") {
    const count = Math.max(1, trackCount), columns = count > 36 ? 3 : count > 18 ? 2 : 1, rows = Math.ceil(count / columns), safeTop = canvasHeight * .07, safeBottom = canvasHeight * .93, titleHeight = titlePx * 1.7;
    const trackPx = Math.max(7, Math.min(titlePx * .48, (safeBottom - safeTop - titleHeight) / rows / 1.32)), blockHeight = titleHeight + rows * trackPx * 1.32;
    const y = position === "top" ? safeTop + titlePx : Math.max(safeTop + titlePx, safeBottom - blockHeight);
    return { columns, rows, trackPx, titleHeight, y, safeBottom, overflow: y + titleHeight + rows * trackPx * 1.32 > safeBottom };
}

