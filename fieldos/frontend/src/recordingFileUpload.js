/**
 * Client-side helpers for selecting / validating audio files before upload.
 */

import { MIN_RECORDING_BYTES } from "./recordingMedia.js";

export const ACCEPTED_AUDIO_EXTENSIONS = [
  ".webm",
  ".wav",
  ".mp3",
  ".m4a",
  ".mp4",
  ".ogg",
  ".oga",
  ".mpeg",
  ".mpga",
  ".flac",
];

export const ACCEPTED_AUDIO_MIMES = new Set([
  "audio/webm",
  "video/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "video/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "application/ogg",
  "audio/flac",
  "audio/x-flac",
]);

export const ACCEPT_ATTR = ACCEPTED_AUDIO_EXTENSIONS.join(",");

const EXT_SET = new Set(ACCEPTED_AUDIO_EXTENSIONS.map((e) => e.slice(1)));

export function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function fileExtension(name) {
  const base = String(name || "").trim();
  const m = base.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * @param {{ name?: string, type?: string, size?: number }|null} file
 * @param {{ minBytes?: number, maxBytes?: number }} limits
 */
export function validateSelectedAudioFile(file, limits = {}) {
  const minBytes = limits.minBytes != null ? limits.minBytes : MIN_RECORDING_BYTES;
  const maxBytes = limits.maxBytes != null ? limits.maxBytes : 25 * 1024 * 1024;
  if (!file || !String(file.name || "").trim()) {
    return { ok: false, reason: "missing_file", message: "Choose an audio file to upload." };
  }
  const name = String(file.name).trim();
  const ext = fileExtension(name);
  const mime = String(file.type || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const size = typeof file.size === "number" ? file.size : 0;

  const mimeOk = !mime || mime === "application/octet-stream" || ACCEPTED_AUDIO_MIMES.has(mime);
  const extOk = EXT_SET.has(ext);
  if (!extOk && !(mime && ACCEPTED_AUDIO_MIMES.has(mime))) {
    return {
      ok: false,
      reason: "unsupported_format",
      message: "Unsupported audio format. Use webm, wav, mp3, m4a, mp4, ogg, or flac.",
      filename: name,
      mimeType: mime,
      byteLength: size,
    };
  }
  if (mime && mime !== "application/octet-stream" && !ACCEPTED_AUDIO_MIMES.has(mime) && !extOk) {
    return {
      ok: false,
      reason: "unsupported_mime",
      message: "Unsupported audio format.",
      filename: name,
      mimeType: mime,
      byteLength: size,
    };
  }
  if (!mimeOk && !extOk) {
    return {
      ok: false,
      reason: "unsupported_format",
      message: "Unsupported audio format.",
      filename: name,
      mimeType: mime,
      byteLength: size,
    };
  }
  if (size < minBytes) {
    return {
      ok: false,
      reason: "too_small",
      message: "Recording contains no audio. Please choose a larger file.",
      filename: name,
      mimeType: mime,
      byteLength: size,
    };
  }
  if (size > maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      message: "File is too large to upload.",
      filename: name,
      mimeType: mime,
      byteLength: size,
    };
  }
  return {
    ok: true,
    filename: name,
    mimeType: mime || "application/octet-stream",
    byteLength: size,
    formattedSize: formatBytes(size),
    extension: ext,
  };
}

export function buildFilePreview(file, validation) {
  return {
    filename: (validation && validation.filename) || (file && file.name) || "",
    mimeType: (validation && validation.mimeType) || (file && file.type) || "",
    byteLength: (validation && validation.byteLength) || (file && file.size) || 0,
    formattedSize: formatBytes((validation && validation.byteLength) || (file && file.size) || 0),
    ok: !!(validation && validation.ok),
    message: (validation && validation.message) || "",
  };
}

export function isProcessingStatus(status) {
  return String(status || "").trim().toLowerCase() === "processing";
}

export function safeUserError(err) {
  const msg = String((err && err.message) || err || "Request failed");
  if (/drive[_ ]?file|webhook|secret|stack|traceback/i.test(msg)) {
    return "Something went wrong. Please try again.";
  }
  return msg.slice(0, 300);
}
