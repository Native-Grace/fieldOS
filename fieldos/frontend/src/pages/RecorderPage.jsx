import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { uploadRecording } from "../api";

const DRAFT_KEY_PREFIX = "fieldos_recording_draft_";

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

export default function RecorderPage() {
  const { jobSheetId } = useParams();
  const mimeType = useMemo(() => pickMimeType(), []);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const accumulatedMsRef = useRef(0);

  const [phase, setPhase] = useState("idle"); // idle | recording | paused | ready | uploading | uploaded | failed
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState(null);
  const [objectUrl, setObjectUrl] = useState("");
  const [status, setStatus] = useState("Tap Record to start. Microphone access is requested only then.");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploadResult, setUploadResult] = useState(null);

  // Restore local draft if previous upload failed / page reloaded
  useEffect(() => {
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + jobSheetId);
    if (!raw) return;
    (async () => {
      try {
        const draft = JSON.parse(raw);
        const restored = await dataUrlToBlob(draft.dataUrl);
        setBlob(restored);
        setSeconds(draft.durationSeconds || 0);
        setObjectUrl(URL.createObjectURL(restored));
        setPhase("ready");
        setStatus("Restored local recording. You can play, delete, or retry upload.");
      } catch {
        localStorage.removeItem(DRAFT_KEY_PREFIX + jobSheetId);
      }
    })();
  }, [jobSheetId]);

  useEffect(() => {
    return () => {
      stopTracks();
      if (timerRef.current) clearInterval(timerRef.current);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTracks() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  function startTimer() {
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = accumulatedMsRef.current + (Date.now() - startedAtRef.current);
      setSeconds(elapsed / 1000);
    }, 200);
  }

  function pauseTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    accumulatedMsRef.current += Date.now() - startedAtRef.current;
  }

  async function startRecording() {
    setError("");
    setUploadResult(null);
    if (!window.MediaRecorder) {
      setError("MediaRecorder is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      accumulatedMsRef.current = 0;
      setSeconds(0);

      const options = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const recorded = new Blob(chunksRef.current, { type });
        setBlob(recorded);
        const url = URL.createObjectURL(recorded);
        setObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setPhase("ready");
        setStatus("Recording ready. Play back, delete, or upload.");
        stopTracks();
      };

      recorder.start(1000);
      setPhase("recording");
      setStatus("Recording…");
      startTimer();
    } catch (err) {
      setError(`Microphone error: ${err.message}`);
      setStatus("Could not access microphone.");
      stopTracks();
    }
  }

  function pauseRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    pauseTimer();
    setPhase("paused");
    setStatus("Paused.");
  }

  function resumeRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
    startTimer();
    setPhase("recording");
    setStatus("Recording…");
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || (recorder.state !== "recording" && recorder.state !== "paused")) return;
    if (recorder.state === "recording") pauseTimer();
    if (timerRef.current) clearInterval(timerRef.current);
    recorder.stop();
  }

  function deleteRecording() {
    setBlob(null);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setObjectUrl("");
    setSeconds(0);
    accumulatedMsRef.current = 0;
    chunksRef.current = [];
    localStorage.removeItem(DRAFT_KEY_PREFIX + jobSheetId);
    setPhase("idle");
    setProgress(0);
    setUploadResult(null);
    setError("");
    setStatus("Deleted. Tap Record to start again.");
  }

  async function persistDraft(currentBlob, durationSeconds) {
    const dataUrl = await blobToDataUrl(currentBlob);
    localStorage.setItem(
      DRAFT_KEY_PREFIX + jobSheetId,
      JSON.stringify({
        dataUrl,
        durationSeconds,
        mimeType: currentBlob.type,
        savedAt: Date.now(),
      })
    );
  }

  async function doUpload() {
    if (!blob || blob.size === 0 || seconds < 0.3) {
      setError("Empty recording — nothing to upload.");
      return;
    }
    setError("");
    setPhase("uploading");
    setProgress(0);
    setStatus("Uploading…");
    try {
      await persistDraft(blob, seconds);
      const result = await uploadRecording(jobSheetId, blob, {
        durationSeconds: seconds,
        triggerProcessing: true,
        mimeType: blob.type || mimeType,
        onProgress: setProgress,
      });
      localStorage.removeItem(DRAFT_KEY_PREFIX + jobSheetId);
      setUploadResult(result);
      setPhase("uploaded");
      setStatus("Upload complete.");
    } catch (err) {
      setPhase("failed");
      setError(err.message || "Upload failed");
      setStatus("Upload failed. Your recording is kept locally — tap Retry.");
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link to={`/jobs/${jobSheetId}`} className="small">
          ← Job
        </Link>
      </div>

      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: "1.2rem" }}>Voice note</h1>
        <p className="job-id">{jobSheetId}</p>
        <div className="timer">{formatTime(seconds)}</div>
        <p className="status-line">{status}</p>
        {error && <div className="error-box">{error}</div>}

        {phase === "uploading" && (
          <div className="progress">
            <span style={{ width: `${progress}%` }} />
          </div>
        )}

        {objectUrl && phase !== "recording" && phase !== "paused" && (
          <audio controls src={objectUrl} />
        )}

        {phase === "idle" && (
          <button className="btn btn-danger" type="button" onClick={startRecording}>
            Record
          </button>
        )}

        {phase === "recording" && (
          <>
            <button className="btn btn-dark" type="button" onClick={pauseRecording}>
              Pause
            </button>
            <button className="btn btn-ghost" type="button" onClick={stopRecording}>
              Stop
            </button>
          </>
        )}

        {phase === "paused" && (
          <>
            <button className="btn btn-danger" type="button" onClick={resumeRecording}>
              Resume
            </button>
            <button className="btn btn-ghost" type="button" onClick={stopRecording}>
              Stop
            </button>
          </>
        )}

        {(phase === "ready" || phase === "failed") && (
          <>
            <button className="btn btn-primary" type="button" onClick={doUpload}>
              {phase === "failed" ? "Retry upload" : "Upload & submit"}
            </button>
            <button className="btn btn-ghost" type="button" onClick={deleteRecording}>
              Delete / re-record
            </button>
          </>
        )}

        {phase === "uploaded" && uploadResult && (
          <div className="warn-box">
            <div>
              <strong>{uploadResult.message}</strong>
            </div>
            <div className="small">
              Recording {uploadResult.recording_id} · order {uploadResult.recording_order}
            </div>
            <div className="small">
              Processing: {uploadResult.processing_triggered ? "triggered" : "not triggered"} —{" "}
              {uploadResult.processing_message}
            </div>
            <button className="btn btn-ghost" type="button" onClick={deleteRecording}>
              Record another
            </button>
            <Link className="btn btn-primary" to={`/jobs/${jobSheetId}`} style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
              Back to job
            </Link>
          </div>
        )}

        <p className="small muted">
          Format: {mimeType || "browser default"}. Mic permission is only requested when you tap Record.
        </p>
      </div>
    </div>
  );
}
