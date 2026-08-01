import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api, getStaff, uploadForm } from "../api";
import {
  appendRecordingChunk,
  stopRecorderAndBuildBlob,
  validateRecordingForUpload,
} from "../recordingMedia";
import {
  AUDIO_FILE_ACCEPT,
  DEFAULT_MAX_UPLOAD_MB,
  SOURCE_BROWSER_RECORDING,
  SOURCE_UPLOADED_FILE,
  canShowNewJobFromRecording,
  confidenceTone,
  emptyReviewedJob,
  formatByteSize,
  makeIdempotencyKey,
  matchStatusLabel,
  reviewedJobFromExtraction,
  validateAudioFileForUpload,
  validateReviewedJobLocally,
} from "../newJobFromRecordingHelpers.mjs";

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function NewJobFromRecordingPage() {
  const staff = getStaff();
  const navigate = useNavigate();
  const allowed = canShowNewJobFromRecording(staff?.role);

  const mimeType = useMemo(() => pickMimeType(), []);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const creatingRef = useRef(false);
  const fileInputRef = useRef(null);
  /** Keep File/Blob across wizard steps until upload completes. */
  const audioRef = useRef(null);

  const [step, setStep] = useState("record");
  const [phase, setPhase] = useState("idle");
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState(null);
  const [objectUrl, setObjectUrl] = useState("");
  const [audioSource, setAudioSource] = useState("");
  const [fileMeta, setFileMeta] = useState(null); // { name, size, mimeType }
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [masters, setMasters] = useState({ customers: [], projects: [], staff: [] });
  const [form, setForm] = useState(emptyReviewedJob());
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [maxUploadMb] = useState(DEFAULT_MAX_UPLOAD_MB);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, [objectUrl]);

  useEffect(() => {
    if (!allowed) return;
    (async () => {
      try {
        const data = await api("/jobs/from-recording/masters");
        setMasters({
          customers: data.customers || [],
          projects: data.projects || [],
          staff: data.staff || [],
        });
      } catch {
        // Masters optional for mock; review still works with typed names.
      }
    })();
  }, [allowed]);

  if (!allowed) {
    return (
      <div className="card">
        <p>Manager or admin role required to create jobs from recordings.</p>
        <Link to="/">Back to jobs</Link>
      </div>
    );
  }

  function clearRecording() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setBlob(null);
    audioRef.current = null;
    setObjectUrl("");
    setSeconds(0);
    setPhase("idle");
    setProgress(0);
    setAudioSource("");
    setFileMeta(null);
    chunksRef.current = [];
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function setReadyAudio(fileOrBlob, { source, name, mimeType, durationSeconds = 0 }) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    audioRef.current = fileOrBlob;
    setBlob(fileOrBlob);
    setObjectUrl(URL.createObjectURL(fileOrBlob));
    setAudioSource(source);
    setFileMeta({
      name: name || fileOrBlob.name || "recording.webm",
      size: fileOrBlob.size || 0,
      mimeType: mimeType || fileOrBlob.type || "audio/webm",
    });
    setSeconds(durationSeconds);
    setPhase("ready");
    setError("");
  }

  async function startRecording() {
    setError("");
    clearRecording();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        appendRecordingChunk(chunksRef.current, ev.data);
      };
      recorder.start(250);
      startedAtRef.current = Date.now();
      setPhase("recording");
      setAudioSource(SOURCE_BROWSER_RECORDING);
      timerRef.current = setInterval(() => {
        setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
    } catch (err) {
      setError(err.message || "Microphone access failed.");
    }
  }

  async function stopRecording() {
    if (!mediaRecorderRef.current) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const built = await stopRecorderAndBuildBlob(mediaRecorderRef.current, chunksRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    const check = validateRecordingForUpload({
      blob: built.blob,
      durationSeconds: seconds,
      chunkCount: chunksRef.current.length,
    });
    if (!check.ok) {
      setError(check.message || check.error || "Recording too short.");
      setPhase("idle");
      return;
    }
    setReadyAudio(built.blob, {
      source: SOURCE_BROWSER_RECORDING,
      name: `browser-recording.${(built.blob.type || "audio/webm").includes("mp4") ? "mp4" : "webm"}`,
      mimeType: built.blob.type || mimeType || "audio/webm",
      durationSeconds: seconds,
    });
  }

  function onFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const check = validateAudioFileForUpload(file, { maxUploadMb: maxUploadMb });
    if (!check.ok) {
      setError(check.error);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setReadyAudio(file, {
      source: SOURCE_UPLOADED_FILE,
      name: file.name,
      mimeType: check.mimeType || file.type,
      durationSeconds: 0,
    });
  }

  async function uploadAndProcess() {
    const audio = audioRef.current || blob;
    if (!audio || busy) return;
    setBusy("upload");
    setError("");
    setStep("transcribing");
    try {
      const formData = new FormData();
      const filename =
        fileMeta?.name || audio.name || "new-job-recording.webm";
      formData.append("file", audio, filename);
      formData.append("duration_seconds", String(seconds || 0));
      formData.append(
        "source",
        audioSource === SOURCE_UPLOADED_FILE ? SOURCE_UPLOADED_FILE : SOURCE_BROWSER_RECORDING
      );
      const uploaded = await uploadForm("/jobs/from-recording/uploads", formData, {
        onProgress: (pct) => setProgress(pct),
      });
      const draftRow = uploaded.draft;
      setDraft(draftRow);
      setIdempotencyKey(makeIdempotencyKey(draftRow.recording_id));
      setBusy("process");
      const processed = await api(
        `/jobs/from-recording/${encodeURIComponent(draftRow.recording_id)}/process`,
        { method: "POST", json: {} }
      );
      setDraft(processed.draft);
      setForm(reviewedJobFromExtraction(processed.draft.extraction, processed.draft.match_report));
      setConfirmCreate(false);
      setStep("review");
    } catch (err) {
      setError(err.message || "Upload or processing failed.");
      setStep("record");
    } finally {
      setBusy("");
      setProgress(0);
    }
  }

  async function retryProcess() {
    if (!draft?.recording_id || busy) return;
    setBusy("process");
    setError("");
    setStep("transcribing");
    try {
      const processed = await api(
        `/jobs/from-recording/${encodeURIComponent(draft.recording_id)}/process`,
        { method: "POST", json: {} }
      );
      setDraft(processed.draft);
      setForm(reviewedJobFromExtraction(processed.draft.extraction, processed.draft.match_report));
      setStep("review");
    } catch (err) {
      setError(err.message || "Processing failed.");
      setStep("record");
    } finally {
      setBusy("");
    }
  }

  function goConfirm() {
    const local = validateReviewedJobLocally(form);
    if (!local.ok) {
      setError(local.error);
      return;
    }
    setError("");
    setConfirmCreate(true);
    setStep("confirm");
  }

  async function createJob() {
    if (!confirmCreate || creatingRef.current || busy) return;
    const local = validateReviewedJobLocally(form);
    if (!local.ok) {
      setError(local.error);
      return;
    }
    creatingRef.current = true;
    setBusy("create");
    setError("");
    try {
      const result = await api("/jobs/from-recording", {
        method: "POST",
        json: {
          recording_id: draft.recording_id,
          expected_processing_version: draft.processing_version,
          job: form,
          idempotency_key: idempotencyKey || makeIdempotencyKey(draft.recording_id),
        },
      });
      setCreated(result);
      setDraft(result.draft);
      setStep("created");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message || "Conflict — reload and review again.");
      } else {
        setError(err.message || "Create job failed.");
      }
    } finally {
      creatingRef.current = false;
      setBusy("");
    }
  }

  const confidence = draft?.extraction?.confidence || {};
  const matchReport = draft?.match_report || {};
  const relativeDates = draft?.extraction?.relative_date_phrases || [];

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>New Job from Recording</h1>
          <p className="small muted" style={{ margin: 0 }}>
            Record or upload → review extracted details → confirm create. Jobs are never auto-created.
          </p>
        </div>
        <Link className="btn btn-ghost" to="/">
          Cancel
        </Link>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <ol className="small" style={{ display: "flex", gap: "1rem", flexWrap: "wrap", paddingLeft: "1.2rem" }}>
          {["Record/Upload", "Transcribing", "Review", "Confirm", "Created"].map((label, idx) => {
            const keys = ["record", "transcribing", "review", "confirm", "created"];
            const active = keys[idx] === step;
            return (
              <li key={label} style={{ fontWeight: active ? 700 : 400 }}>
                {label}
              </li>
            );
          })}
        </ol>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "#b00020" }}>
          <strong>Error</strong>
          <p>{error}</p>
          {(draft?.status === "TranscriptionFailed" || draft?.status === "ExtractionFailed") && (
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={retryProcess}>
              Retry transcription / extraction
            </button>
          )}
        </div>
      )}

      {step === "record" && (
        <div className="card">
          <h2>1. Record or upload</h2>
          <p className="muted small">
            Use the microphone or choose an existing audio file. Play back before submitting. You can
            replace or remove the clip.
          </p>

          <div
            className="new-job-audio-actions"
            style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}
          >
            {phase !== "recording" ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={startRecording}
                disabled={!!busy}
                data-testid="record-audio-btn"
              >
                Record audio
              </button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={stopRecording}>
                Stop ({formatTime(seconds)})
              </button>
            )}

            <button
              type="button"
              className="btn btn-ghost"
              disabled={!!busy || phase === "recording"}
              data-testid="choose-audio-file-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose audio file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={AUDIO_FILE_ACCEPT}
              className="visually-hidden"
              data-testid="audio-file-input"
              aria-label="Choose audio file"
              onChange={onFileSelected}
            />
          </div>

          <p className="small muted" style={{ marginTop: 0 }}>
            Supported: webm, mp3, wav, ogg, m4a, mp4 · max {maxUploadMb} MB
          </p>

          {fileMeta && phase === "ready" && (
            <div
              className="new-job-file-meta"
              data-testid="selected-file-meta"
              style={{
                marginBottom: "1rem",
                padding: "0.75rem",
                background: "var(--surface, #f6f8f6)",
                borderRadius: "8px",
              }}
            >
              <p style={{ margin: "0 0 0.35rem" }}>
                <strong>{fileMeta.name}</strong>
              </p>
              <p className="small muted" style={{ margin: 0 }}>
                {formatByteSize(fileMeta.size)} · {fileMeta.mimeType || "unknown type"} ·{" "}
                {audioSource === SOURCE_UPLOADED_FILE ? "Uploaded file" : "Browser recording"}
              </p>
              {objectUrl && (
                <div style={{ marginTop: "0.75rem" }} data-testid="audio-playback">
                  <audio controls src={objectUrl} style={{ width: "100%" }} />
                </div>
              )}
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!!busy}
                  data-testid="replace-audio-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!!busy}
                  data-testid="remove-audio-btn"
                  onClick={clearRecording}
                >
                  Remove
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!blob || phase !== "ready" || !!busy}
            data-testid="submit-transcription-btn"
            onClick={uploadAndProcess}
          >
            {busy === "upload" ? `Uploading ${progress || 0}%…` : "Upload / Process"}
          </button>
        </div>
      )}

      {step === "transcribing" && (
        <div className="card">
          <h2>2. Transcribing</h2>
          <p>Uploading audio to Drive (via FieldOS) and extracting job details. Audio is not sent through Apps Script.</p>
          <p className="muted">{busy || "Working…"}</p>
        </div>
      )}

      {(step === "review" || step === "confirm") && draft && (
        <div className="grid-2">
          <div className="card">
            <h2>3. Review job details</h2>
            <p className="small muted">Edit anything before create. Fuzzy master matches are suggestions only.</p>

            <label>
              Customer
              <select
                value={form.customer_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const row = masters.customers.find((c) => c.customer_id === id);
                  setForm((f) => ({
                    ...f,
                    customer_id: id,
                    customer_name: row?.customer_name || f.customer_name,
                  }));
                }}
              >
                <option value="">Select or keep typed name</option>
                {masters.customers.map((c) => (
                  <option key={c.customer_id} value={c.customer_id}>
                    {c.customer_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Customer name
              <input
                value={form.customer_name}
                onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
              />
            </label>
            <p className="small">
              Match: {matchStatusLabel(matchReport.customer?.status)} · confidence{" "}
              {confidence.customer_name ?? 0} ({confidenceTone(confidence.customer_name)})
            </p>

            <label>
              Project
              <select
                value={form.project_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const row = masters.projects.find((p) => p.project_id === id);
                  setForm((f) => ({
                    ...f,
                    project_id: id,
                    project_name: row?.project_name || f.project_name,
                  }));
                }}
              >
                <option value="">Select or keep typed name</option>
                {masters.projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.project_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project name
              <input
                value={form.project_name}
                onChange={(e) => setForm((f) => ({ ...f, project_name: e.target.value }))}
              />
            </label>

            <label>
              Job title
              <input
                value={form.job_title}
                onChange={(e) => setForm((f) => ({ ...f, job_title: e.target.value }))}
              />
            </label>
            <label>
              Description
              <textarea
                rows={3}
                value={form.job_description}
                onChange={(e) => setForm((f) => ({ ...f, job_description: e.target.value }))}
              />
            </label>
            <label>
              Scheduled date
              <input
                type="date"
                value={form.scheduled_date}
                onChange={(e) => setForm((f) => ({ ...f, scheduled_date: e.target.value }))}
              />
            </label>
            {relativeDates?.length > 0 && (
              <ul className="small">
                {relativeDates.map((row, i) => (
                  <li key={i}>
                    “{row.phrase}” → {row.resolved_date || "unresolved"}
                  </li>
                ))}
              </ul>
            )}
            <label>
              Scheduled time (optional)
              <input
                value={form.scheduled_time}
                onChange={(e) => setForm((f) => ({ ...f, scheduled_time: e.target.value }))}
              />
            </label>
            <label>
              Assigned staff
              <select
                multiple
                value={form.assigned_staff_ids}
                onChange={(e) => {
                  const ids = Array.from(e.target.selectedOptions).map((o) => o.value);
                  const names = ids.map(
                    (id) => masters.staff.find((s) => s.staff_id === id)?.staff_name || id
                  );
                  setForm((f) => ({ ...f, assigned_staff_ids: ids, assigned_staff_names: names }));
                }}
              >
                {masters.staff.map((s) => (
                  <option key={s.staff_id} value={s.staff_id}>
                    {s.staff_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Site address
              <input
                value={form.site_address}
                onChange={(e) => setForm((f) => ({ ...f, site_address: e.target.value }))}
              />
            </label>
            <label>
              Contact name
              <input
                value={form.contact_name}
                onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))}
              />
            </label>
            <label>
              Contact phone
              <input
                value={form.contact_phone}
                onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
              />
            </label>
            <label>
              Priority
              <input
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              />
            </label>
            <label>
              Notes
              <textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </label>
            <label>
              Status
              <input
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
              />
            </label>

            {(draft.extraction?.warnings || []).length > 0 && (
              <div>
                <strong>Warnings</strong>
                <ul>
                  {draft.extraction.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {(draft.extraction?.unresolved || []).length > 0 && (
              <div>
                <strong>Unresolved</strong>
                <ul>
                  {draft.extraction.unresolved.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {step === "review" && (
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={goConfirm}>
                Continue to confirm
              </button>
            )}
            {step === "confirm" && (
              <div>
                <p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmCreate}
                      onChange={(e) => setConfirmCreate(e.target.checked)}
                    />{" "}
                    I have reviewed the details and want to create this job sheet.
                  </label>
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!confirmCreate || !!busy || creatingRef.current}
                  onClick={createJob}
                >
                  {busy === "create" ? "Creating…" : "Create Job"}
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Transcript & audio</h2>
            {objectUrl && <audio controls src={objectUrl} style={{ width: "100%" }} />}
            <pre className="small" style={{ whiteSpace: "pre-wrap" }}>
              {draft.transcript || "(no transcript)"}
            </pre>
          </div>
        </div>
      )}

      {step === "created" && created && (
        <div className="card">
          <h2>5. Job created</h2>
          <p>
            <strong>{created.job?.job_sheet_id}</strong>
          </p>
          <p>
            {created.job?.customer_name || form.customer_name} ·{" "}
            {created.job?.project_name || form.project_name}
          </p>
          <p>Scheduled: {form.scheduled_date}</p>
          <p>Staff: {(form.assigned_staff_names || []).join(", ")}</p>
          <p className="small muted">
            Recording {created.recording_id} linked
            {created.idempotent ? " (idempotent replay)" : ""}.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate(`/jobs/${encodeURIComponent(created.job.job_sheet_id)}`)}
          >
            Open Job
          </button>
        </div>
      )}
    </div>
  );
}
