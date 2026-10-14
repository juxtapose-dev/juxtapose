// The fixed answers for `placeholder` (issue #177). The same bytes on every
// capture, so a page whose image or frame is a random third-party URL renders
// the same pixels every run.

/** A 64x64 solid gray (#cccccc) PNG, base64. */
export const IMAGE_PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PMQ0AAAwDoPrXVlGVsHsJOCB9LgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIClwFFIkI7EKRuHwAAAABJRU5ErkJggg==';

/** An empty HTML document, for a sub-frame. */
export const FRAME_PLACEHOLDER_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>';
