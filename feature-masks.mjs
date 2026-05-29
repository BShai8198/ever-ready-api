// MediaPipe Face Landmarker feature mask helpers.
// These masks are designed for semantic makeup transfer and assume
// a 468-point face mesh (additional iris points are ignored).

const INNER_LIP_RING = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415,
  308, 324, 318, 402, 317, 14, 87, 178, 88, 95,
];

const LEFT_UPPER_LID = [246, 161, 160, 159, 158, 157, 173];
const RIGHT_UPPER_LID = [466, 388, 387, 386, 385, 384, 398];
const LEFT_BROW_LOWER = [70, 63, 105, 66, 107, 55, 65];
const RIGHT_BROW_LOWER = [300, 293, 334, 296, 336, 285, 295];

const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const LEFT_MOUTH_CORNER = 61;
const RIGHT_MOUTH_CORNER = 291;
const LEFT_NOSE_WING = 129;
const RIGHT_NOSE_WING = 358;
const LEFT_CHEEKBONE = 234;
const RIGHT_CHEEKBONE = 454;

/**
 * Returns semantic feature masks from MediaPipe Face Landmarker output.
 *
 * Accepts either:
 * - a direct landmark array: [{ x, y, z }, ...]
 * - a faceLandmarker result object containing `faceLandmarks[0]`
 * - an object containing `landmarks`
 *
 * Each returned mask includes:
 * - `svgPath`: SVG path string
 * - `points`: point arrays used to build the region
 * - `toCanvasPath()`: lazy Path2D builder for browser canvas use
 *
 * @param {Array|Object} input
 * @returns {{
 *   inner_lips: { svgPath: string, points: Array, toCanvasPath: Function },
 *   upper_eyelid_crease: {
 *     svgPath: string,
 *     left: { svgPath: string, points: Array, toCanvasPath: Function },
 *     right: { svgPath: string, points: Array, toCanvasPath: Function },
 *     toCanvasPath: Function
 *   },
 *   cheek_apples: {
 *     svgPath: string,
 *     left: { svgPath: string, center: Object, radii: Object, rotation: number, toCanvasPath: Function },
 *     right: { svgPath: string, center: Object, radii: Object, rotation: number, toCanvasPath: Function },
 *     toCanvasPath: Function
 *   }
 * }}
 */
export function getFeatureMasks(input) {
  const landmarks = resolveLandmarks(input);
  assertLandmarkCount(landmarks);

  const innerLipPoints = INNER_LIP_RING.map((index) => pointAt(landmarks, index));
  const innerLipPath = closedSplinePath(innerLipPoints);

  const leftUpperBand = makeUpperEyelidCreaseBand(landmarks, LEFT_UPPER_LID, LEFT_BROW_LOWER, -1);
  const rightUpperBand = makeUpperEyelidCreaseBand(landmarks, RIGHT_UPPER_LID, RIGHT_BROW_LOWER, 1);
  const leftUpperPath = closedSplinePath(leftUpperBand);
  const rightUpperPath = closedSplinePath(rightUpperBand);
  const upperCompoundPath = `${leftUpperPath} ${rightUpperPath}`.trim();

  const leftCheek = makeCheekAppleEllipse(landmarks, {
    eyeOuter: LEFT_EYE_OUTER,
    mouthCorner: LEFT_MOUTH_CORNER,
    noseWing: LEFT_NOSE_WING,
    cheekbone: LEFT_CHEEKBONE,
    rotation: -0.34,
  });
  const rightCheek = makeCheekAppleEllipse(landmarks, {
    eyeOuter: RIGHT_EYE_OUTER,
    mouthCorner: RIGHT_MOUTH_CORNER,
    noseWing: RIGHT_NOSE_WING,
    cheekbone: RIGHT_CHEEKBONE,
    rotation: 0.34,
  });
  const cheekCompoundPath = `${leftCheek.svgPath} ${rightCheek.svgPath}`.trim();

  return {
    inner_lips: buildPathResult(innerLipPath, innerLipPoints),
    upper_eyelid_crease: {
      svgPath: upperCompoundPath,
      left: buildPathResult(leftUpperPath, leftUpperBand),
      right: buildPathResult(rightUpperPath, rightUpperBand),
      toCanvasPath: makeCanvasPathFactory(upperCompoundPath),
    },
    cheek_apples: {
      svgPath: cheekCompoundPath,
      left: {
        svgPath: leftCheek.svgPath,
        center: leftCheek.center,
        radii: leftCheek.radii,
        rotation: leftCheek.rotation,
        toCanvasPath: makeCanvasPathFactory(leftCheek.svgPath),
      },
      right: {
        svgPath: rightCheek.svgPath,
        center: rightCheek.center,
        radii: rightCheek.radii,
        rotation: rightCheek.rotation,
        toCanvasPath: makeCanvasPathFactory(rightCheek.svgPath),
      },
      toCanvasPath: makeCanvasPathFactory(cheekCompoundPath),
    },
  };
}

function resolveLandmarks(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (Array.isArray(input?.faceLandmarks?.[0])) {
    return input.faceLandmarks[0];
  }

  if (Array.isArray(input?.landmarks)) {
    return input.landmarks;
  }

  throw new TypeError(
    "getFeatureMasks expected a MediaPipe landmark array or Face Landmarker result object."
  );
}

function assertLandmarkCount(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) {
    throw new RangeError(
      `getFeatureMasks expected at least 468 face landmarks, received ${landmarks?.length ?? 0}.`
    );
  }
}

function pointAt(landmarks, index) {
  const landmark = landmarks[index];
  if (!landmark || typeof landmark.x !== "number" || typeof landmark.y !== "number") {
    throw new RangeError(`Missing or invalid landmark at index ${index}.`);
  }

  return { x: landmark.x, y: landmark.y, z: landmark.z ?? 0 };
}

function averagePoints(points) {
  const total = points.reduce(
    (accumulator, point) => {
      accumulator.x += point.x;
      accumulator.y += point.y;
      return accumulator;
    },
    { x: 0, y: 0 }
  );

  return {
    x: total.x / points.length,
    y: total.y / points.length,
  };
}

function lerpPoint(a, b, t) {
  return {
    x: a.x + ((b.x - a.x) * t),
    y: a.y + ((b.y - a.y) * t),
    z: (a.z ?? 0) + (((b.z ?? 0) - (a.z ?? 0)) * t),
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function weightedAverage(entries) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight === 0) {
    return { x: 0, y: 0 };
  }

  const totals = entries.reduce(
    (accumulator, entry) => {
      accumulator.x += entry.point.x * entry.weight;
      accumulator.y += entry.point.y * entry.weight;
      return accumulator;
    },
    { x: 0, y: 0 }
  );

  return {
    x: totals.x / totalWeight,
    y: totals.y / totalWeight,
  };
}

function makeUpperEyelidCreaseBand(landmarks, eyelidIndices, browIndices, horizontalDirection) {
  const eyelidPoints = eyelidIndices.map((index) => pointAt(landmarks, index));
  const browPoints = browIndices.map((index) => pointAt(landmarks, index));

  const creasePoints = eyelidPoints.map((eyelidPoint, index) => {
    const browPoint = browPoints[Math.min(index, browPoints.length - 1)];
    const lifted = lerpPoint(eyelidPoint, browPoint, 0.56);

    return {
      x: lifted.x + (horizontalDirection * 0.004 * index),
      y: lifted.y - 0.003,
    };
  });

  const outerExtension = {
    x: eyelidPoints[0].x + (horizontalDirection * 0.015),
    y: eyelidPoints[0].y - 0.01,
  };

  const outerCreaseExtension = {
    x: creasePoints[0].x + (horizontalDirection * 0.018),
    y: creasePoints[0].y - 0.008,
  };

  return [
    outerExtension,
    ...eyelidPoints,
    ...creasePoints.slice().reverse(),
    outerCreaseExtension,
  ];
}

function makeCheekAppleEllipse(landmarks, config) {
  const eyeOuter = pointAt(landmarks, config.eyeOuter);
  const mouthCorner = pointAt(landmarks, config.mouthCorner);
  const noseWing = pointAt(landmarks, config.noseWing);
  const cheekbone = pointAt(landmarks, config.cheekbone);

  const eyeMouthMid = averagePoints([eyeOuter, mouthCorner]);
  const center = weightedAverage([
    { point: eyeMouthMid, weight: 0.46 },
    { point: noseWing, weight: 0.28 },
    { point: cheekbone, weight: 0.26 },
  ]);

  const radii = {
    x: distance(noseWing, cheekbone) * 0.30,
    y: distance(eyeOuter, mouthCorner) * 0.20,
  };

  const svgPath = ellipsePath(center, radii, config.rotation);
  return {
    svgPath,
    center,
    radii,
    rotation: config.rotation,
  };
}

function buildPathResult(svgPath, points) {
  return {
    svgPath,
    points,
    toCanvasPath: makeCanvasPathFactory(svgPath),
  };
}

function makeCanvasPathFactory(svgPath) {
  return function toCanvasPath() {
    if (typeof Path2D === "undefined") {
      throw new Error("Path2D is unavailable in this runtime. Use svgPath instead.");
    }

    return new Path2D(svgPath);
  };
}

function closedSplinePath(points) {
  if (!points.length) return "";
  if (points.length < 3) {
    return polygonPath(points);
  }

  const wrapped = [
    points[points.length - 1],
    ...points,
    points[0],
    points[1],
  ];

  let path = `M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`;
  for (let index = 1; index < wrapped.length - 2; index += 1) {
    const previous = wrapped[index - 1];
    const current = wrapped[index];
    const next = wrapped[index + 1];
    const afterNext = wrapped[index + 2];

    const controlPoint1 = {
      x: current.x + ((next.x - previous.x) / 6),
      y: current.y + ((next.y - previous.y) / 6),
    };
    const controlPoint2 = {
      x: next.x - ((afterNext.x - current.x) / 6),
      y: next.y - ((afterNext.y - current.y) / 6),
    };

    path += ` C ${formatNumber(controlPoint1.x)} ${formatNumber(controlPoint1.y)} ${formatNumber(controlPoint2.x)} ${formatNumber(controlPoint2.y)} ${formatNumber(next.x)} ${formatNumber(next.y)}`;
  }

  return `${path} Z`;
}

function polygonPath(points) {
  if (!points.length) return "";

  const segments = points.map((point, index) => {
    const prefix = index === 0 ? "M" : "L";
    return `${prefix} ${formatNumber(point.x)} ${formatNumber(point.y)}`;
  });

  return `${segments.join(" ")} Z`;
}

function ellipsePath(center, radii, rotation) {
  const kappa = 0.5522847498307936;
  const rx = radii.x;
  const ry = radii.y;
  const cx = center.x;
  const cy = center.y;

  const rawPoints = [
    { x: cx - rx, y: cy },
    { x: cx - rx, y: cy - (ry * kappa) },
    { x: cx - (rx * kappa), y: cy - ry },
    { x: cx, y: cy - ry },
    { x: cx + (rx * kappa), y: cy - ry },
    { x: cx + rx, y: cy - (ry * kappa) },
    { x: cx + rx, y: cy },
    { x: cx + rx, y: cy + (ry * kappa) },
    { x: cx + (rx * kappa), y: cy + ry },
    { x: cx, y: cy + ry },
    { x: cx - (rx * kappa), y: cy + ry },
    { x: cx - rx, y: cy + (ry * kappa) },
  ].map((point) => rotatePoint(point, center, rotation));

  return [
    `M ${formatNumber(rawPoints[0].x)} ${formatNumber(rawPoints[0].y)}`,
    `C ${formatNumber(rawPoints[1].x)} ${formatNumber(rawPoints[1].y)} ${formatNumber(rawPoints[2].x)} ${formatNumber(rawPoints[2].y)} ${formatNumber(rawPoints[3].x)} ${formatNumber(rawPoints[3].y)}`,
    `C ${formatNumber(rawPoints[4].x)} ${formatNumber(rawPoints[4].y)} ${formatNumber(rawPoints[5].x)} ${formatNumber(rawPoints[5].y)} ${formatNumber(rawPoints[6].x)} ${formatNumber(rawPoints[6].y)}`,
    `C ${formatNumber(rawPoints[7].x)} ${formatNumber(rawPoints[7].y)} ${formatNumber(rawPoints[8].x)} ${formatNumber(rawPoints[8].y)} ${formatNumber(rawPoints[9].x)} ${formatNumber(rawPoints[9].y)}`,
    `C ${formatNumber(rawPoints[10].x)} ${formatNumber(rawPoints[10].y)} ${formatNumber(rawPoints[11].x)} ${formatNumber(rawPoints[11].y)} ${formatNumber(rawPoints[0].x)} ${formatNumber(rawPoints[0].y)}`,
    "Z",
  ].join(" ");
}

function rotatePoint(point, center, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  return {
    x: center.x + (dx * cosine) - (dy * sine),
    y: center.y + (dx * sine) + (dy * cosine),
  };
}

function formatNumber(value) {
  return Number(value.toFixed(6)).toString();
}
