// A QR code, black on white with the standard's four-module quiet zone, drawn at a whole
// number of pixels per module so every module comes out the same size.

import { useMemo } from "react";

import { encodeQr, qrPath } from "./qr";

const QUIET = 4;

export function QrCode({ text, target = 184 }: { text: string; target?: number }) {
  const q = useMemo(() => encodeQr(text), [text]);
  const n = q.size + QUIET * 2;
  const px = n * Math.max(3, Math.round(target / n));
  return (
    <svg className="qr" width={px} height={px} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label={`QR code: ${text}`}>
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(q, QUIET)} fill="#000" />
    </svg>
  );
}
