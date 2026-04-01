
// --- INDICES ---
// Detailed Iris Landmarks for accurate sizing
// Right Eye: Center 468. Top 470, Bottom 472, Left (Nasal) 471, Right (Temporal) 469
// Left Eye: Center 473. Top 475, Bottom 477, Left (Temporal) 474, Right (Nasal) 476
export const RIGHT_IRIS_INDICES = { 
  center: 468, 
  top: 470,
  bottom: 472,
  left: 471, // Nasal (towards nose)
  right: 469, // Temporal (towards ear)
};
export const LEFT_IRIS_INDICES = { 
  center: 473, 
  top: 475,
  bottom: 477,
  left: 474, // Temporal
  right: 476, // Nasal
};


// Blink Detection Indices (Upper/Lower eyelids)
export const LEFT_BLINK_INDICES = [159, 145];
export const RIGHT_BLINK_INDICES = [386, 374];

/**
 * Calculates Euclidean distance between two 2D points.
 */
export const getDistance = (p1: {x: number, y: number}, p2: {x: number, y: number}) => {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Simple Linear Interpolation (Lerp) for smoothing values
 */
export const lerp = (start: number, end: number, factor: number) => {
  return start + (end - start) * factor;
};

/**
 * Maps a normalized MediaPipe landmark (0-1) to canvas coordinates (pixels)
 * considering the "object-fit: cover" aspect ratio logic.
 */
export const mapLandmark = (
  lm: {x: number, y: number},
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number
) => {
  const videoAspect = videoWidth / videoHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  let scale, xOffset, yOffset;

  if (canvasAspect > videoAspect) {
    // Canvas is wider than video (crop top/bottom)
    scale = canvasWidth / videoWidth;
    xOffset = 0;
    yOffset = (canvasHeight - videoHeight * scale) / 2;
  } else {
    // Canvas is taller than video (crop sides)
    scale = canvasHeight / videoHeight;
    xOffset = (canvasWidth - videoWidth * scale) / 2;
    yOffset = 0;
  }

  // Account for horizontal flip (mirror effect)
  const mappedX = (1 - lm.x) * videoWidth * scale + xOffset;
  const mappedY = lm.y * videoHeight * scale + yOffset;

  return { x: mappedX, y: mappedY };
};
