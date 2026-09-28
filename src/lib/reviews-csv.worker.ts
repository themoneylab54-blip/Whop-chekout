import { parseReviewsBytes } from "./reviews-import";

/*
 * Parses an uploaded review export off the main thread (a 15 MB file would freeze the builder):
 * receives the file's bytes, answers { ok: true, result } or { ok: false }.
 */

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ArrayBuffer>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (e) => {
  try {
    scope.postMessage({ ok: true, result: parseReviewsBytes(e.data) });
  } catch {
    scope.postMessage({ ok: false });
  }
};
