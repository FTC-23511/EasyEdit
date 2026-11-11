// The preview canvas is never more than this many pixels on its long side; a 4K project previews at half size.
export const PREVIEW_MAX_SIDE = 1920;

// The canvas's backing size for a project, and the factor that maps project pixels onto it.
export function previewSize(doc: { width: number; height: number }): { width: number; height: number; scale: number } {
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(doc.width, doc.height));
  return { width: Math.round(doc.width * scale), height: Math.round(doc.height * scale), scale };
}

// The largest box with this aspect ratio (width / height) that fits inside the given box.
export function fitBox(aspect: number, boxWidth: number, boxHeight: number): { width: number; height: number } {
  const width = Math.max(0, boxWidth);
  const height = Math.max(0, boxHeight);
  if (width / aspect <= height) return { width, height: width / aspect };
  return { width: height * aspect, height };
}
