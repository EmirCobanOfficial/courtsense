// Court geometry in meters. Origin: center of the near baseline, +y toward the net, +x to the camera's right.
export type Pt = [number, number];
export type Homography = number[]; // 3x3 row-major, h[8] = 1

export const COURT = {
  length: 23.77,
  net: 11.885,
  singlesHalf: 4.115,
  doublesHalf: 5.485,
  serviceFromBaseline: 5.485, // service line is 6.40 m from the net
};

// The four points the coach clicks, in this order (their names live in lib/i18n.ts, cal_0..cal_3). All are clearly visible from a camera behind the near baseline.
export const CALIBRATION_POINTS: { world: Pt }[] = [
  { world: [-COURT.singlesHalf, 0] },
  { world: [COURT.singlesHalf, 0] },
  { world: [COURT.singlesHalf, COURT.serviceFromBaseline] },
  { world: [-COURT.singlesHalf, COURT.serviceFromBaseline] },
];

const { length: L, net: N, singlesHalf: S, doublesHalf: D } = COURT;
const farService = L - COURT.serviceFromBaseline;

// Line segments for drawing the court, in world meters.
export const COURT_LINES: [Pt, Pt][] = [
  [[-D, 0], [D, 0]],
  [[-D, L], [D, L]],
  [[-D, 0], [-D, L]],
  [[D, 0], [D, L]],
  [[-S, 0], [-S, L]],
  [[S, 0], [S, L]],
  [[-S, COURT.serviceFromBaseline], [S, COURT.serviceFromBaseline]],
  [[-S, farService], [S, farService]],
  [[0, COURT.serviceFromBaseline], [0, farService]],
  [[-D - 0.9, N], [D + 0.9, N]],
];

// Solve the homography mapping 4 src points onto 4 dst points (DLT with h33 = 1).
export function solveHomography(src: Pt[], dst: Pt[]): Homography {
  if (src.length !== 4 || dst.length !== 4) throw new Error("need exactly 4 point pairs");
  const A: number[][] = [];
  src.forEach(([x, y], i) => {
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  });
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error("degenerate points: three or more are collinear");
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

export function applyHomography(h: Homography, [x, y]: Pt): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}
