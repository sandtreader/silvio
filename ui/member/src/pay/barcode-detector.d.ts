// Minimal ambient typing for the native BarcodeDetector API, which is not in
// TypeScript's lib.dom yet (Chromium/Android have it; feature-detected at
// runtime with 'BarcodeDetector' in window).

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
