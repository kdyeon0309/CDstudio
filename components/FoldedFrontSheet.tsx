import type { ReactNode } from "react";
import styles from "./FoldedFrontSheet.module.css";

function OuterCropMarks() {
  return (
    <span className={styles.outerCropMarks} aria-hidden="true">
      <i className={styles.cropTopLeft} />
      <i className={styles.cropTopRight} />
      <i className={styles.cropBottomLeft} />
      <i className={styles.cropBottomRight} />
    </span>
  );
}

export default function FoldedFrontSheet({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className={styles.wrapper}>
      <section className={styles.foldSheet} aria-label="앞표지 접기 A4 가로 인쇄 페이지">
        <span className={styles.sheetLabel}>앞표지 접기 · 왼쪽 내부 / 오른쪽 앞표지</span>
        <div className={styles.foldStrip}>
          <OuterCropMarks />
          <div className={styles.foldPanel} aria-label="왼쪽: 앞표지 내부">{left}</div>
          <div className={styles.foldPanel} aria-label="오른쪽: 앞표지">{right}</div>
          <span className={styles.screenFoldLine} aria-hidden="true" />
          <span className={`${styles.foldTick} ${styles.foldTickTop}`} aria-hidden="true" />
          <span className={`${styles.foldTick} ${styles.foldTickBottom}`} aria-hidden="true" />
        </div>
      </section>
    </div>
  );
}
