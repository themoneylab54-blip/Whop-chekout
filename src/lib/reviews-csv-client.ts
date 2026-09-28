import { parseReviewsBytes, type CsvImportResult } from "./reviews-import";

/** A file the worker read but could not parse, or took too long on: never re-parsed on the main thread. */
export class CsvWorkerError extends Error {}

/** Longest a worker may take on one file before the import gives up. */
export const CSV_WORKER_TIMEOUT_MS = 30_000;

/**
 * Reviews of an uploaded CSV export, parsed in a Web Worker so a large file never freezes the
 * builder. Only where a worker cannot start (old browser, blocked script) is the file parsed on
 * the main thread, after a paint so the "reading" indicator is shown first. A worker that
 * started but failed on the file (ok: false, unreadable answer, timeout) rejects: parsing the
 * same file again on the main thread would freeze the builder for the same result.
 */
export async function parseReviewsFile(file: Blob, timeoutMs = CSV_WORKER_TIMEOUT_MS): Promise<CsvImportResult> {
  const bytes = await file.arrayBuffer();
  if (typeof Worker !== "undefined") {
    try {
      return await parseInWorker(bytes, timeoutMs);
    } catch (err) {
      if (err instanceof CsvWorkerError) throw err;
      // The worker could not start: falls back to the main thread below.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return parseReviewsBytes(bytes);
}

function parseInWorker(bytes: ArrayBuffer, timeoutMs: number): Promise<CsvImportResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./reviews-csv.worker.ts", import.meta.url), { type: "module" });
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new CsvWorkerError(`La lecture du fichier a pris plus de ${Math.round(timeoutMs / 1000)} secondes : exportez moins d'avis (seulement les publiés) et réessayez.`)),
        ),
      timeoutMs,
    );
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: CsvImportResult }>) =>
      finish(() => {
        if (e.data?.ok && e.data.result) resolve(e.data.result);
        else reject(new CsvWorkerError("Lecture du fichier impossible : vérifiez qu'il s'agit bien d'un export CSV de votre application d'avis."));
      });
    worker.onmessageerror = () =>
      finish(() => reject(new CsvWorkerError("Lecture du fichier impossible : la réponse du lecteur de fichier est illisible. Réessayez.")));
    worker.onerror = (e) => {
      e.preventDefault();
      // Failed to start (script blocked / unsupported): the main thread takes over.
      finish(() => reject(new Error("CSV worker unavailable")));
    };
    // Copied, not transferred: the bytes are still needed if the worker cannot start.
    worker.postMessage(bytes);
  });
}
