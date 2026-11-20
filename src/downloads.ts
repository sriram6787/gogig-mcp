/**
 * Short-lived download links for report files the HTTP gateway produces.
 *
 * A file is kept in memory under a long random id for TTL_MS, then dropped.
 * The id is the only secret: anyone holding the link can fetch the file
 * until it expires, so links are long, unguessable and short-lived.
 */
import { randomBytes } from "node:crypto";
import type { DownloadedFile } from "./tools";

const TTL_MS = 15 * 60_000;
const store = new Map<string, { file: DownloadedFile; expiresAt: number }>();

function prune() {
  const now = Date.now();
  for (const [id, entry] of store) if (entry.expiresAt <= now) store.delete(id);
}
setInterval(prune, 60_000).unref();

/** Keeps `file` and returns its download id. */
export function putDownload(file: DownloadedFile): string {
  const id = randomBytes(24).toString("hex");
  store.set(id, { file, expiresAt: Date.now() + TTL_MS });
  return id;
}

/** The file for `id`, or undefined once it has expired. */
export function getDownload(id: string): DownloadedFile | undefined {
  prune();
  return store.get(id)?.file;
}

export const DOWNLOAD_TTL_MINUTES = TTL_MS / 60_000;
