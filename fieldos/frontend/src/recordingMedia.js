/**
 * Pure MediaRecorder helpers for FieldOS voice notes (testable without DOM React).
 */

export const MIN_RECORDING_BYTES = 1024;
export const MIN_RECORDING_SECONDS = 0.5;

export const NO_AUDIO_MESSAGE = "Recording contains no audio. Please record again.";

/**
 * @param {Blob|null|undefined} data
 * @returns {boolean}
 */
export function isNonEmptyChunk(data) {
  return !!(data && typeof data.size === "number" && data.size > 0);
}

/**
 * @param {Array<Blob>} chunks
 * @param {Blob|null|undefined} chunk
 * @returns {Array<Blob>} same array instance (mutated in place)
 */
export function appendRecordingChunk(chunks, chunk) {
  const target = Array.isArray(chunks) ? chunks : [];
  if (isNonEmptyChunk(chunk)) target.push(chunk);
  return target;
}

/**
 * @param {Array<Blob>} chunks
 * @param {string} mimeType
 * @returns {Blob}
 */
export function buildRecordingBlob(chunks, mimeType) {
  const type = mimeType || "audio/webm";
  return new Blob(Array.isArray(chunks) ? chunks : [], { type });
}

/**
 * @param {{ blob: Blob|null|undefined, durationSeconds?: number, chunkCount?: number }} input
 * @returns {{ ok: true } | { ok: false, reason: string, message: string }}
 */
export function validateRecordingForUpload(input) {
  const blob = input && input.blob;
  const durationSeconds = Number(input && input.durationSeconds != null ? input.durationSeconds : 0);
  const chunkCount = Number(input && input.chunkCount != null ? input.chunkCount : NaN);

  if (!Number.isNaN(chunkCount) && chunkCount < 1) {
    return {
      ok: false,
      reason: "no_chunks",
      message: NO_AUDIO_MESSAGE,
      chunkCount,
    };
  }
  if (!blob) {
    return { ok: false, reason: "missing_blob", message: NO_AUDIO_MESSAGE };
  }
  const size = typeof blob.size === "number" ? blob.size : 0;
  if (size < MIN_RECORDING_BYTES) {
    return {
      ok: false,
      reason: "blob_too_small",
      message: NO_AUDIO_MESSAGE,
      byteLength: size,
    };
  }
  if (!(durationSeconds >= MIN_RECORDING_SECONDS)) {
    return {
      ok: false,
      reason: "duration_too_short",
      message: NO_AUDIO_MESSAGE,
      durationSeconds,
    };
  }
  return { ok: true, byteLength: size, durationSeconds, chunkCount };
}

/**
 * Sanitised diagnostics (no audio bytes / no data URLs).
 * @param {object} partial
 */
export function buildRecordingDiagnostics(partial) {
  return {
    selectedMimeType: partial.selectedMimeType || "",
    recorderMimeType: partial.recorderMimeType || "",
    chunkCount: Number(partial.chunkCount || 0),
    chunkSizes: Array.isArray(partial.chunkSizes) ? partial.chunkSizes.slice() : [],
    finalBlobSize: Number(partial.finalBlobSize || 0),
    durationSeconds: Number(partial.durationSeconds || 0),
    mediaRecorderState: partial.mediaRecorderState || "",
    audioTrackReadyState: partial.audioTrackReadyState || "",
    audioTrackMuted: !!partial.audioTrackMuted,
    audioTrackEnabled: partial.audioTrackEnabled !== false,
    phase: partial.phase || "",
  };
}

/**
 * Wait for MediaRecorder stop + final dataavailable flush.
 * Prefer attaching handlers before calling stop().
 *
 * @param {MediaRecorder} recorder
 * @param {{ chunks: Blob[], mimeType: string, onDiag?: Function }} opts
 * @returns {Promise<{ blob: Blob, chunks: Blob[], diagnostics: object }>}
 */
export function stopRecorderAndBuildBlob(recorder, opts) {
  const chunks = opts.chunks;
  const mimeType = opts.mimeType || "audio/webm";
  const onDiag = opts.onDiag;

  return new Promise((resolve, reject) => {
    if (!recorder) {
      reject(new Error("MediaRecorder is not available."));
      return;
    }

    const finish = () => {
      const blob = buildRecordingBlob(chunks, recorder.mimeType || mimeType);
      const diagnostics = buildRecordingDiagnostics({
        selectedMimeType: mimeType,
        recorderMimeType: recorder.mimeType || "",
        chunkCount: chunks.length,
        chunkSizes: chunks.map((c) => c.size),
        finalBlobSize: blob.size,
        mediaRecorderState: recorder.state,
        phase: "stopped",
      });
      if (onDiag) onDiag(diagnostics);
      resolve({ blob, chunks, diagnostics });
    };

    if (recorder.state === "inactive") {
      finish();
      return;
    }

    const previousOnStop = recorder.onstop;
    recorder.onstop = (event) => {
      try {
        if (typeof previousOnStop === "function") previousOnStop.call(recorder, event);
      } finally {
        finish();
      }
    };

    try {
      recorder.stop();
    } catch (err) {
      reject(err);
    }
  });
}
