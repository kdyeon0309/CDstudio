import type { ReactNode } from "react";
import styles from "./FoldedBackSheet.module.css";

export default function FoldedBackSheet({ outside, inside }: { outside: ReactNode; inside: ReactNode }) {
  return <div className={styles.wrapper}>
    <section className={styles.foldSheet} aria-label="뒷표지 접기 A4 세로 인쇄 페이지">
      <span className={styles.sheetLabel}>뒷표지 접기 · 위 바깥면 / 아래 안쪽면</span>
      <div className={styles.foldStrip}>
        <span className={styles.outerCropMarks} aria-hidden="true"><i/><i/><i/><i/></span>
        <div className={styles.face} aria-label="위: 뒷표지 바깥면">{outside}</div>
        <div className={`${styles.face} ${styles.inside}`} aria-label="아래: 뒷표지 안쪽면">{inside}</div>
        <span className={styles.screenFoldLine} aria-hidden="true" />
        <span className={`${styles.foldTick} ${styles.foldTickLeft}`} aria-hidden="true" />
        <span className={`${styles.foldTick} ${styles.foldTickRight}`} aria-hidden="true" />
        {["topLeft","topRight","bottomLeft","bottomRight"].map((name) => <span key={name} className={`${styles.spineTick} ${styles[name]}`} aria-hidden="true" />)}
        <span className={`${styles.screenSpineLine} ${styles.spineLeft}`} aria-hidden="true" />
        <span className={`${styles.screenSpineLine} ${styles.spineRight}`} aria-hidden="true" />
      </div>
    </section>
  </div>;
}
