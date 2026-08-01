import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  api,
  downloadAuthenticatedFile,
  getStaff,
  getToken,
  uploadForm,
} from "../api";
import {
  ACTIVE_DAILY_WORK_SESSION_KEY,
  AUDIO_FILE_ACCEPT,
  DEFAULT_MAX_UPLOAD_MB,
  SOURCE_BROWSER_RECORDING,
  SOURCE_UPLOADED_FILE,
  canShowDailyWorkJobSheet,
  emptyReviewedJobSheet,
  formatManagerNotesPreview,
  makeIdempotencyKey,
  reviewedJobSheetFromExtraction,
  sessionStorageKey,
  sortRecordingsChronologically,
  sydneyTodayISO,
  validateReviewedJobSheetLocally,
} from "../dailyWorkHelpers.mjs";
import {
  OPEN_SESSIONS_REASONS,
  buildStartNewSessionDetailsForm,
  canCreateCompletedJobSheet,
  isStaleOpenSessionsResponse,
  logOpenSessionsFetch,
  nextOpenSessionsRequestId,
  shouldAutoResumeOnOpenSessionsLoad,
} from "../dailyWorkSessionLoad.mjs";
import { formatByteSize, validateAudioFileForUpload } from "../newJobFromRecordingHelpers.mjs";
import {
  appendRecordingChunk,
  stopRecorderAndBuildBlob,
  validateRecordingForUpload,
} from "../recordingMedia";

const LIST_FIELDS = [
  { key: "work_completed", label: "Work completed", movable: "follow_up_required" },
  { key: "materials_used", label: "Materials used" },
  { key: "equipment_used", label: "Equipment used" },
  { key: "hours_or_times", label: "Hours / times" },
  { key: "site_conditions", label: "Site conditions" },
  { key: "issues_found", label: "Issues found" },
  { key: "client_requests", label: "Client requests" },
  { key: "follow_up_required", label: "Follow-up required", movable: "work_completed" },
  { key: "safety_notes", label: "Safety / site notes" },
];

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

function recordingLabel(rec, index) {
  const raw = rec.recorded_at || rec.created_at || "";
  if (raw) {
    try {
      const dt = new Date(raw);
      const clock = dt.toLocaleTimeString("en-AU", {
        timeZone: "Australia/Sydney",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return `Recording ${index + 1} · ${clock}`;
    } catch {
      /* fall through */
    }
  }
  return `Recording ${index + 1}`;
}

function SessionAudioPlayer({ workSessionId, recordingId }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    (async () => {
      if (!workSessionId || !recordingId || !getToken()) return;
      setError("");
      try {
        const { blob } = await downloadAuthenticatedFile(
          `/daily-work-sessions/${encodeURIComponent(workSessionId)}/recordings/${encodeURIComponent(recordingId)}/audio`,
          { triggerDownload: false }
        );
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not load audio.");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workSessionId, recordingId]);

  if (error) return <p className="small muted">{error}</p>;
  if (!src) return <p className="small muted">Loading audio…</p>;
  return <audio controls src={src} style={{ width: "100%" }} />;
}

function ListFieldEditor({ fieldKey, label, items, onChange, onMove, moveTarget, moveLabel }) {
  return (
    <fieldset className="field" style={{ marginBottom: "1rem" }}>
      <legend>{label}</legend>
      {(items || []).map((item, idx) => (
        <div key={`${fieldKey}-${idx}`} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
          <input
            style={{ flex: 1 }}
            value={item.text || ""}
            onChange={(e) => {
              const next = [...items];
              next[idx] = { ...item, text: e.target.value };
              onChange(next);
            }}
          />
          {moveTarget && onMove && (
            <button type="button" className="btn btn-ghost" onClick={() => onMove(idx)}>
              → {moveLabel}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange(items.filter((_, i) => i !== idx))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => onChange([...(items || []), { text: "", recording_ids: [] }])}
      >
        Add line
      </button>
    </fieldset>
  );
}

export default function DailyWorkJobSheetPage() {
  const staff = getStaff();
  // getStaff() returns a new object every call — never put `staff` in hook deps.
  const staffRole = staff?.role || "";
  const navigate = useNavigate();
  const allowed = canShowDailyWorkJobSheet(staffRole);

  const mimeType = useMemo(() => pickMimeType(), []);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const creatingRef = useRef(false);
  const fileInputRef = useRef(null);
  const audioRef = useRef(null);
  const stepRef = useRef("list");
  const openSessionsRequestIdRef = useRef(0);
  const openSessionsInFlightRef = useRef(false);
  const openSessionsAbortRef = useRef(null);
  const staffRef = useRef(staff);
  staffRef.current = staff;
  const applySessionRef = useRef(null);

  const [step, setStep] = useState("list");
  const [openSessions, setOpenSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [masters, setMasters] = useState({ customers: [], projects: [], staff: [] });
  const [detailsForm, setDetailsForm] = useState(() =>
    buildStartNewSessionDetailsForm(staff, sydneyTodayISO)
  );
  const [jobSheet, setJobSheet] = useState(emptyReviewedJobSheet());
  const [phase, setPhase] = useState("idle");
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState(null);
  const [objectUrl, setObjectUrl] = useState("");
  const [audioSource, setAudioSource] = useState("");
  const [fileMeta, setFileMeta] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [createdJobId, setCreatedJobId] = useState("");
  /** After CreateFailed → return-to-review, create stays disabled until user confirms. */
  const [reviewConfirmed, setReviewConfirmed] = useState(true);
  const maxUploadMb = DEFAULT_MAX_UPLOAD_MB;

  const workSessionId = session?.work_session_id || "";

  const setWizardStep = useCallback((next) => {
    stepRef.current = next;
    setStep(next);
  }, []);

  const persistSessionId = useCallback((id) => {
    if (typeof sessionStorage === "undefined" || !id) return;
    sessionStorage.setItem(ACTIVE_DAILY_WORK_SESSION_KEY, id);
    sessionStorage.setItem(sessionStorageKey(id), "1");
  }, []);

  const clearPersistedSession = useCallback((id) => {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(ACTIVE_DAILY_WORK_SESSION_KEY);
    if (id) sessionStorage.removeItem(sessionStorageKey(id));
  }, []);

  const applySession = useCallback(
    (row, { advanceStep = true } = {}) => {
      setSession(row);
      if (row?.work_session_id) persistSessionId(row.work_session_id);
      if (row?.extraction?.job_sheet) {
        setJobSheet(reviewedJobSheetFromExtraction(row.extraction));
      } else {
        setJobSheet((prev) => ({
          ...emptyReviewedJobSheet(),
          ...prev,
          customer_name: row?.customer_name || prev.customer_name,
          project_id: row?.project_id || prev.project_id,
          project_name: row?.project_name || prev.project_name,
          work_date: row?.work_date || prev.work_date || sydneyTodayISO(),
          staff_ids: row?.staff_ids?.length ? row.staff_ids : prev.staff_ids,
          staff_names: row?.staff_names?.length ? row.staff_names : prev.staff_names,
          site_address: row?.site_address || prev.site_address,
        }));
      }
      const currentStaff = staffRef.current;
      setDetailsForm({
        work_date: row?.work_date || sydneyTodayISO(),
        customer_name: row?.customer_name || "",
        project_id: row?.project_id || "",
        project_name: row?.project_name || "",
        staff_ids: row?.staff_ids || (currentStaff?.staff_id ? [currentStaff.staff_id] : []),
        staff_names:
          row?.staff_names || (currentStaff?.staff_name ? [currentStaff.staff_name] : []),
        site_address: row?.site_address || "",
        starting_note: row?.starting_note || "",
      });
      if (!advanceStep) return;
      if (row?.job_created && row?.created_job_sheet_id) {
        setCreatedJobId(row.created_job_sheet_id);
        setWizardStep("created");
        setReviewConfirmed(true);
      } else if (row?.status === "CreateFailed") {
        setWizardStep("review");
        setReviewConfirmed(false);
        if (row.last_create_idempotency_key) {
          setIdempotencyKey(row.last_create_idempotency_key);
        }
      } else if (
        row?.status === "ReviewRequired" ||
        (row?.extraction?.job_sheet &&
          (row.extraction.job_sheet.work_completed?.length ||
            row.extraction.job_sheet.completion_summary))
      ) {
        setWizardStep("review");
        // Fresh extract / resumed ReviewRequired: create allowed after user is on review.
        setReviewConfirmed(row?.status === "ReviewRequired");
      } else if (row?.work_session_id) {
        setWizardStep("recordings");
      }
    },
    [persistSessionId, setWizardStep]
  );
  applySessionRef.current = applySession;

  const loadOpenSessions = useCallback(
    async (reason = OPEN_SESSIONS_REASONS.REFRESH, { resume = false } = {}) => {
      if (!allowed) return;

      if (openSessionsAbortRef.current) {
        openSessionsAbortRef.current.abort();
        openSessionsAbortRef.current = null;
      }

      const requestId = nextOpenSessionsRequestId(openSessionsRequestIdRef.current);
      openSessionsRequestIdRef.current = requestId;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      openSessionsAbortRef.current = controller;
      openSessionsInFlightRef.current = true;

      const stepBefore = stepRef.current;
      logOpenSessionsFetch("start", { reason, requestId, currentStep: stepBefore });

      setBusy("load");
      try {
        const data = await api("/daily-work-sessions?open_only=true");
        if (
          isStaleOpenSessionsResponse({
            requestId,
            latestRequestId: openSessionsRequestIdRef.current,
            aborted: controller?.signal?.aborted,
          })
        ) {
          logOpenSessionsFetch("stale", { reason, requestId, currentStep: stepRef.current });
          return;
        }
        setOpenSessions(data.items || []);
        logOpenSessionsFetch("end", {
          reason,
          requestId,
          currentStep: stepRef.current,
          itemCount: (data.items || []).length,
        });

        if (shouldAutoResumeOnOpenSessionsLoad(reason, resume)) {
          const resumeId =
            typeof sessionStorage !== "undefined"
              ? sessionStorage.getItem(ACTIVE_DAILY_WORK_SESSION_KEY)
              : "";
          if (resumeId) {
            const loaded = await api(`/daily-work-sessions/${encodeURIComponent(resumeId)}`);
            if (
              isStaleOpenSessionsResponse({
                requestId,
                latestRequestId: openSessionsRequestIdRef.current,
                aborted: controller?.signal?.aborted,
              })
            ) {
              logOpenSessionsFetch("stale", {
                reason,
                requestId,
                currentStep: stepRef.current,
              });
              return;
            }
            // Only auto-resume when still on the sessions list (do not yank Details).
            if (stepRef.current === "list") {
              applySessionRef.current?.(loaded.session);
            }
          }
        }
      } catch (err) {
        if (
          isStaleOpenSessionsResponse({
            requestId,
            latestRequestId: openSessionsRequestIdRef.current,
            aborted: controller?.signal?.aborted,
          })
        ) {
          return;
        }
        setError(err.message || "Failed to load sessions.");
      } finally {
        if (openSessionsRequestIdRef.current === requestId) {
          openSessionsInFlightRef.current = false;
          if (openSessionsAbortRef.current === controller) {
            openSessionsAbortRef.current = null;
          }
          setBusy((prev) => (prev === "load" ? "" : prev));
        }
      }
    },
    [allowed]
  );

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, [objectUrl]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api("/daily-work-sessions/masters");
        if (cancelled) return;
        setMasters({
          customers: data.customers || [],
          projects: data.projects || [],
          staff: data.staff || [],
        });
      } catch {
        /* optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  // Open sessions: once on mount (stable loadOpenSessions). No polling. No step/openSessions deps.
  useEffect(() => {
    if (!allowed) return;
    loadOpenSessions(OPEN_SESSIONS_REASONS.INITIAL, { resume: true });
    return () => {
      if (openSessionsAbortRef.current) {
        openSessionsAbortRef.current.abort();
        openSessionsAbortRef.current = null;
      }
      openSessionsRequestIdRef.current = nextOpenSessionsRequestId(
        openSessionsRequestIdRef.current
      );
    };
  }, [allowed, loadOpenSessions]);

  if (!allowed) {
    return (
      <div className="card">
        <p>Sign in to record daily work.</p>
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

  function setReadyAudio(fileOrBlob, { source, name, mimeType: mt, durationSeconds = 0 }) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    audioRef.current = fileOrBlob;
    setBlob(fileOrBlob);
    setObjectUrl(URL.createObjectURL(fileOrBlob));
    setAudioSource(source);
    setFileMeta({
      name: name || fileOrBlob.name || "recording.webm",
      size: fileOrBlob.size || 0,
      mimeType: mt || fileOrBlob.type || "audio/webm",
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
      recorder.ondataavailable = (ev) => appendRecordingChunk(chunksRef.current, ev.data);
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
    const built = await stopRecorderAndBuildBlob(mediaRecorderRef.current, {
      chunks: chunksRef.current,
      mimeType,
    });
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
    const check = validateAudioFileForUpload(file, { maxUploadMb });
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

  async function createSession() {
    setBusy("create");
    setError("");
    try {
      const body = {
        work_date: detailsForm.work_date || sydneyTodayISO(),
        customer_name: detailsForm.customer_name,
        project_id: detailsForm.project_id,
        project_name: detailsForm.project_name,
        staff_ids: detailsForm.staff_ids,
        staff_names: detailsForm.staff_names,
        site_address: detailsForm.site_address,
        starting_note: detailsForm.starting_note,
      };
      const data = await api("/daily-work-sessions", { method: "POST", json: body });
      applySession(data.session);
      setIdempotencyKey(makeIdempotencyKey(data.session.work_session_id));
      setWizardStep("recordings");
      // Refresh open-session list once after create — does not resume / change step.
      void loadOpenSessions(OPEN_SESSIONS_REASONS.POST_CREATE, { resume: false });
    } catch (err) {
      setError(err.message || "Could not create session.");
      // Stay on details when create fails before an ID exists.
      setWizardStep("details");
    } finally {
      setBusy("");
    }
  }

  async function resumeSession(id) {
    setBusy("load");
    setError("");
    try {
      const data = await api(`/daily-work-sessions/${encodeURIComponent(id)}`);
      applySession(data.session);
      if (!idempotencyKey) setIdempotencyKey(makeIdempotencyKey(id));
    } catch (err) {
      setError(err.message || "Could not load session.");
    } finally {
      setBusy("");
    }
  }

  async function uploadRecording() {
    const audio = audioRef.current || blob;
    if (!audio || !workSessionId || busy) return;
    setBusy("upload");
    setError("");
    try {
      const formData = new FormData();
      const filename = fileMeta?.name || audio.name || "daily-work-recording.webm";
      formData.append("file", audio, filename);
      formData.append("duration_seconds", String(seconds || 0));
      formData.append(
        "source",
        audioSource === SOURCE_UPLOADED_FILE ? SOURCE_UPLOADED_FILE : SOURCE_BROWSER_RECORDING
      );
      formData.append("recorded_at", new Date().toISOString());
      const data = await uploadForm(
        `/daily-work-sessions/${encodeURIComponent(workSessionId)}/recordings`,
        formData,
        { onProgress: (pct) => setProgress(pct) }
      );
      applySession(data.session);
      clearRecording();
    } catch (err) {
      setError(err.message || "Upload failed.");
    } finally {
      setBusy("");
      setProgress(0);
    }
  }

  async function removeRecording(recordingId) {
    if (!workSessionId || busy) return;
    setBusy("delete");
    setError("");
    try {
      const data = await api(
        `/daily-work-sessions/${encodeURIComponent(workSessionId)}/recordings/${encodeURIComponent(recordingId)}`,
        { method: "DELETE" }
      );
      applySession(data.session);
    } catch (err) {
      setError(err.message || "Could not remove recording.");
    } finally {
      setBusy("");
    }
  }

  async function processAndExtract() {
    if (!workSessionId || busy) return;
    setBusy("process");
    setError("");
    try {
      let data = await api(
        `/daily-work-sessions/${encodeURIComponent(workSessionId)}/process-all`,
        { method: "POST", json: {} }
      );
      data = await api(
        `/daily-work-sessions/${encodeURIComponent(workSessionId)}/extract`,
        { method: "POST", json: {} }
      );
      applySession(data.session);
      setReviewConfirmed(true);
      setWizardStep("review");
    } catch (err) {
      setError(err.message || "Processing failed.");
    } finally {
      setBusy("");
    }
  }

  async function returnToReview() {
    if (!workSessionId || !session || busy) return;
    setBusy("return-review");
    setError("");
    try {
      const data = await api(
        `/daily-work-sessions/${encodeURIComponent(workSessionId)}/return-to-review`,
        {
          method: "POST",
          json: { expected_session_version: session.version },
        }
      );
      applySession(data.session, { advanceStep: false });
      setReviewConfirmed(false);
      setWizardStep("review");
    } catch (err) {
      setError(err.message || "Could not return to review.");
      try {
        const reloaded = await api(
          `/daily-work-sessions/${encodeURIComponent(workSessionId)}`
        );
        applySession(reloaded.session, { advanceStep: false });
      } catch {
        /* keep prior error */
      }
    } finally {
      setBusy("");
    }
  }

  async function createJobSheet() {
    if (!workSessionId || !session || creatingRef.current || busy) return;
    if (session.status === "CreateFailed") {
      setError("Return to review first, confirm the job sheet, then create again.");
      return;
    }
    if (session.status !== "ReviewRequired") {
      setError(`Session must be ReviewRequired (status=${session.status}).`);
      return;
    }
    if (!reviewConfirmed) {
      setError("Confirm the review before creating the job sheet.");
      return;
    }
    const local = validateReviewedJobSheetLocally(jobSheet);
    if (!local.ok) {
      setError(local.error);
      return;
    }
    creatingRef.current = true;
    setBusy("create");
    setError("");
    try {
      const key =
        idempotencyKey ||
        session.last_create_idempotency_key ||
        makeIdempotencyKey(workSessionId);
      setIdempotencyKey(key);
      const result = await api(
        `/daily-work-sessions/${encodeURIComponent(workSessionId)}/create-job-sheet`,
        {
          method: "POST",
          json: {
            expected_session_version: session.version,
            reviewed_job_sheet: jobSheet,
            idempotency_key: key,
          },
        }
      );
      applySession(result.session);
      const jobId = result.job?.job_sheet_id || result.session?.created_job_sheet_id || "";
      setCreatedJobId(jobId);
      clearPersistedSession(workSessionId);
      setWizardStep("created");
      if (jobId) navigate(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message || "Conflict — reload and review again.");
      } else {
        setError(err.message || "Create job sheet failed.");
      }
      try {
        const reloaded = await api(
          `/daily-work-sessions/${encodeURIComponent(workSessionId)}`
        );
        applySession(reloaded.session);
      } catch {
        /* keep error text */
      }
    } finally {
      creatingRef.current = false;
      setBusy("");
    }
  }

  function saveAndContinueLater() {
    if (workSessionId) persistSessionId(workSessionId);
    navigate("/");
  }

  function startNewSession() {
    const stepBefore = stepRef.current;
    // Clear resume hint so a late/in-flight initial fetch cannot yank us off Details.
    clearPersistedSession(workSessionId || undefined);
    setSession(null);
    setCreatedJobId("");
    setIdempotencyKey("");
    setError("");
    setDetailsForm(buildStartNewSessionDetailsForm(staffRef.current, sydneyTodayISO));
    setJobSheet(emptyReviewedJobSheet());
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    audioRef.current = null;
    setBlob(null);
    setObjectUrl("");
    setSeconds(0);
    setPhase("idle");
    setProgress(0);
    setAudioSource("");
    setFileMeta(null);
    chunksRef.current = [];
    if (fileInputRef.current) fileInputRef.current.value = "";
    setWizardStep("details");
    logOpenSessionsFetch("skip", {
      reason: "start-new-session",
      currentStep: stepBefore,
      nextStep: "details",
    });
    // Intentionally do NOT call loadOpenSessions here.
  }

  function backToSessions() {
    setWizardStep("list");
    void loadOpenSessions(OPEN_SESSIONS_REASONS.REFRESH, { resume: false });
  }

  function refreshOpenSessions() {
    void loadOpenSessions(OPEN_SESSIONS_REASONS.REFRESH, { resume: false });
  }

  const sortedRecordings = sortRecordingsChronologically(session?.recordings || []);
  const extractionRecordings = session?.extraction?.recordings || [];
  const managerPreview = formatManagerNotesPreview(jobSheet);
  const stepLabels = ["Sessions", "Details", "Recordings", "Review", "Created"];

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Daily Work Job Sheet</h1>
          <p className="small muted" style={{ margin: 0 }}>
            Record today&apos;s completed work across multiple clips, review, then create a job sheet.
          </p>
        </div>
        <Link className="btn btn-ghost" to="/">
          Cancel
        </Link>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <ol className="small" style={{ display: "flex", gap: "1rem", flexWrap: "wrap", paddingLeft: "1.2rem" }}>
          {stepLabels.map((label) => {
            const keys = ["list", "details", "recordings", "review", "created"];
            const active = keys[stepLabels.indexOf(label)] === step;
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
        </div>
      )}

      {step === "list" && (
        <div className="card">
          <h2>Open daily work sessions</h2>
          <p className="muted small">Resume an in-progress session or start a new one for today.</p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={startNewSession}>
              Start new session
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!!busy}
              onClick={refreshOpenSessions}
            >
              Refresh
            </button>
          </div>
          {openSessions.length === 0 && !busy && (
            <p className="muted small" style={{ marginTop: "1rem" }}>
              No open sessions.
            </p>
          )}
          {openSessions.map((row) => (
            <div
              key={row.work_session_id}
              className="card"
              style={{ marginTop: "0.75rem", padding: "0.75rem" }}
            >
              <strong>{row.customer_name || row.project_name || row.work_session_id}</strong>
              <p className="small muted" style={{ margin: "0.25rem 0" }}>
                {row.work_date} · {row.recording_count || 0} recording(s) · {row.status}
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!!busy}
                onClick={() => resumeSession(row.work_session_id)}
              >
                Resume
              </button>
            </div>
          ))}
        </div>
      )}

      {step === "details" && (
        <div className="card">
          <h2>Session details</h2>
          <button type="button" className="btn btn-ghost" onClick={backToSessions} style={{ marginBottom: "0.75rem" }}>
            Back to sessions
          </button>
          <label className="field">
            Work date
            <input
              type="date"
              value={detailsForm.work_date}
              onChange={(e) => setDetailsForm((f) => ({ ...f, work_date: e.target.value }))}
            />
          </label>
          <label className="field">
            Customer
            <select
              value=""
              onChange={(e) => {
                const id = e.target.value;
                const row = masters.customers.find((c) => c.customer_id === id);
                if (!row) return;
                setDetailsForm((f) => ({
                  ...f,
                  customer_name: row.customer_name,
                }));
              }}
            >
              <option value="">Pick customer (optional)</option>
              {masters.customers.map((c) => (
                <option key={c.customer_id} value={c.customer_id}>
                  {c.customer_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Customer name
            <input
              value={detailsForm.customer_name}
              onChange={(e) => setDetailsForm((f) => ({ ...f, customer_name: e.target.value }))}
            />
          </label>
          <label className="field">
            Project
            <select
              value={detailsForm.project_id}
              onChange={(e) => {
                const id = e.target.value;
                const row = masters.projects.find((p) => p.project_id === id);
                setDetailsForm((f) => ({
                  ...f,
                  project_id: id,
                  project_name: row?.project_name || f.project_name,
                }));
              }}
            >
              <option value="">Select project</option>
              {masters.projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.project_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Project name
            <input
              value={detailsForm.project_name}
              onChange={(e) => setDetailsForm((f) => ({ ...f, project_name: e.target.value }))}
            />
          </label>
          <label className="field">
            Staff on site
            <select
              multiple
              value={detailsForm.staff_ids}
              onChange={(e) => {
                const ids = Array.from(e.target.selectedOptions).map((o) => o.value);
                const names = ids.map(
                  (id) => masters.staff.find((s) => s.staff_id === id)?.staff_name || id
                );
                setDetailsForm((f) => ({ ...f, staff_ids: ids, staff_names: names }));
              }}
            >
              {masters.staff.map((s) => (
                <option key={s.staff_id} value={s.staff_id}>
                  {s.staff_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Site address (optional)
            <input
              value={detailsForm.site_address}
              onChange={(e) => setDetailsForm((f) => ({ ...f, site_address: e.target.value }))}
            />
          </label>
          <label className="field">
            Starting note (optional)
            <textarea
              rows={2}
              value={detailsForm.starting_note}
              onChange={(e) => setDetailsForm((f) => ({ ...f, starting_note: e.target.value }))}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy}
            onClick={createSession}
          >
            Continue to recordings
          </button>
        </div>
      )}

      {step === "recordings" && session && (
        <div className="card">
          <h2>Recordings</h2>
          <p className="small muted">
            {session.customer_name || session.project_name} · {session.work_date}
          </p>

          <div
            className="daily-work-audio-actions"
            style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}
          >
            {phase !== "recording" ? (
              <button type="button" className="btn btn-primary" onClick={startRecording} disabled={!!busy}>
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
              onClick={() => fileInputRef.current?.click()}
            >
              Choose audio file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={AUDIO_FILE_ACCEPT}
              className="visually-hidden"
              aria-label="Choose audio file"
              onChange={onFileSelected}
            />
          </div>

          <p className="small muted" style={{ marginTop: 0 }}>
            Supported: webm, mp3, wav, ogg, m4a, mp4 · max {maxUploadMb} MB
          </p>

          {fileMeta && phase === "ready" && (
            <div
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
                {formatByteSize(fileMeta.size)} · {fileMeta.mimeType}
              </p>
              {objectUrl && <audio controls src={objectUrl} style={{ width: "100%", marginTop: "0.75rem" }} />}
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!!busy}
                  onClick={uploadRecording}
                >
                  {busy === "upload" ? `Uploading ${progress || 0}%…` : "Add recording"}
                </button>
                <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={clearRecording}>
                  Discard clip
                </button>
              </div>
            </div>
          )}

          <h3>Saved recordings</h3>
          {sortedRecordings.length === 0 && <p className="muted small">No recordings yet.</p>}
          {sortedRecordings.map((rec, idx) => (
            <div key={rec.recording_id} className="card" style={{ marginBottom: "0.75rem", padding: "0.75rem" }}>
              <strong>{recordingLabel(rec, idx)}</strong>
              <p className="small muted">{rec.status || "Saved"}</p>
              <SessionAudioPlayer workSessionId={workSessionId} recordingId={rec.recording_id} />
              {rec.transcript && (
                <pre className="small" style={{ whiteSpace: "pre-wrap" }}>
                  {rec.transcript}
                </pre>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!!busy || session.job_created}
                onClick={() => removeRecording(rec.recording_id)}
              >
                Remove
              </button>
            </div>
          ))}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "1rem" }}>
            <button type="button" className="btn btn-ghost" onClick={saveAndContinueLater}>
              Save and continue later
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!busy || sortedRecordings.length === 0}
              onClick={processAndExtract}
            >
              {busy === "process" ? "Processing…" : "Process recordings"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!!busy || !session.extraction?.job_sheet}
              onClick={() => setWizardStep("review")}
            >
              Review job sheet
            </button>
          </div>
        </div>
      )}

      {step === "review" && session && (
        <div className="grid-2">
          <div className="card">
            <h2>Recordings &amp; transcripts</h2>
            {extractionRecordings.length === 0 && sortedRecordings.length === 0 && (
              <p className="muted small">No recordings.</p>
            )}
            {(extractionRecordings.length ? extractionRecordings : sortedRecordings).map((rec, idx) => (
              <div key={rec.recording_id || idx} style={{ marginBottom: "1rem" }}>
                <strong>{recordingLabel(rec, idx)}</strong>
                {rec.recording_id && (
                  <SessionAudioPlayer workSessionId={workSessionId} recordingId={rec.recording_id} />
                )}
                <pre className="small" style={{ whiteSpace: "pre-wrap" }}>
                  {rec.transcript || "(no transcript)"}
                </pre>
              </div>
            ))}
            {session.extraction?.aggregated_transcript && (
              <div>
                <h3>Combined transcript</h3>
                <pre className="small" style={{ whiteSpace: "pre-wrap" }}>
                  {session.extraction.aggregated_transcript}
                </pre>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Review job sheet</h2>
            {!session.created_job_sheet_id && !session.job_created && (
              <p className="muted small">No job sheet has been created yet.</p>
            )}

            {session.status === "CreateFailed" && (
              <div
                className="card"
                style={{ borderColor: "#b00020", marginBottom: "1rem", background: "#fff8f8" }}
              >
                <strong>Job-sheet creation failed</strong>
                <p>
                  Your recordings and reviewed work have been kept.
                </p>
                {(session.create_failure_reason || session.failure_reason) && (
                  <p className="small muted">
                    {session.create_failure_reason || session.failure_reason}
                  </p>
                )}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!!busy}
                    onClick={returnToReview}
                  >
                    {busy === "return-review" ? "Returning…" : "Return to review"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!!busy}
                    onClick={saveAndContinueLater}
                  >
                    Cancel session
                  </button>
                </div>
              </div>
            )}

            {session.status === "ReviewRequired" && !reviewConfirmed && (
              <div className="card" style={{ marginBottom: "1rem" }}>
                <p className="small">
                  Re-check the reviewed work below, then confirm before creating the job sheet.
                  Create will not run automatically.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!!busy}
                  onClick={() => {
                    setReviewConfirmed(true);
                    setError("");
                  }}
                >
                  Confirm review — enable create
                </button>
              </div>
            )}

            <label className="field">
              Customer name
              <input
                value={jobSheet.customer_name}
                onChange={(e) => {
                  setReviewConfirmed(false);
                  setJobSheet((j) => ({ ...j, customer_name: e.target.value }));
                }}
                disabled={session.status === "CreateFailed"}
              />
            </label>
            <label className="field">
              Project name
              <input
                value={jobSheet.project_name}
                onChange={(e) => {
                  setReviewConfirmed(false);
                  setJobSheet((j) => ({ ...j, project_name: e.target.value }));
                }}
                disabled={session.status === "CreateFailed"}
              />
            </label>
            <label className="field">
              Work date
              <input
                type="date"
                value={jobSheet.work_date}
                onChange={(e) => {
                  setReviewConfirmed(false);
                  setJobSheet((j) => ({ ...j, work_date: e.target.value }));
                }}
                disabled={session.status === "CreateFailed"}
              />
            </label>
            <label className="field">
              Site address
              <input
                value={jobSheet.site_address}
                onChange={(e) => {
                  setReviewConfirmed(false);
                  setJobSheet((j) => ({ ...j, site_address: e.target.value }));
                }}
                disabled={session.status === "CreateFailed"}
              />
            </label>
            <label className="field">
              Completion summary
              <textarea
                rows={2}
                value={jobSheet.completion_summary}
                onChange={(e) => {
                  setReviewConfirmed(false);
                  setJobSheet((j) => ({ ...j, completion_summary: e.target.value }));
                }}
                disabled={session.status === "CreateFailed"}
              />
            </label>

            {LIST_FIELDS.map(({ key, label, movable }) => (
              <ListFieldEditor
                key={key}
                fieldKey={key}
                label={label}
                items={jobSheet[key]}
                onChange={
                  session.status === "CreateFailed"
                    ? () => {}
                    : (next) => {
                        setReviewConfirmed(false);
                        setJobSheet((j) => ({ ...j, [key]: next }));
                      }
                }
                moveTarget={session.status === "CreateFailed" ? undefined : movable}
                moveLabel={movable === "follow_up_required" ? "Follow-up" : "Completed"}
                onMove={
                  movable && session.status !== "CreateFailed"
                    ? (idx) => {
                        const fromField = key;
                        const toField = movable;
                        setReviewConfirmed(false);
                        setJobSheet((j) => {
                          const src = [...(j[fromField] || [])];
                          if (idx < 0 || idx >= src.length) return j;
                          const item = src.splice(idx, 1)[0];
                          return {
                            ...j,
                            [fromField]: src,
                            [toField]: [...(j[toField] || []), item],
                          };
                        });
                      }
                    : undefined
                }
              />
            ))}

            <label className="field">
              Manager notes preview
              <textarea rows={6} readOnly value={managerPreview} />
            </label>

            {(session.extraction?.warnings || []).length > 0 && (
              <div>
                <strong>Warnings</strong>
                <ul>
                  {session.extraction.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setWizardStep("recordings")}
                disabled={session.status === "CreateFailed"}
              >
                Back to recordings
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !!busy ||
                  creatingRef.current ||
                  !canCreateCompletedJobSheet({
                    status: session.status,
                    reviewConfirmed,
                    jobCreated: session.job_created,
                  })
                }
                onClick={createJobSheet}
              >
                {busy === "create"
                  ? "Creating…"
                  : session.status === "CreateFailed"
                    ? "Retry create after review"
                    : "Create completed job sheet"}
              </button>
            </div>
            {session.status === "ReviewRequired" && !reviewConfirmed && (
              <p className="small muted" style={{ marginTop: "0.5rem" }}>
                Create stays disabled until you confirm the review.
              </p>
            )}
          </div>
        </div>
      )}

      {step === "created" && (
        <div className="card">
          <h2>Job sheet created</h2>
          {createdJobId ? (
            <>
              <p>
                <strong>{createdJobId}</strong>
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate(`/jobs/${encodeURIComponent(createdJobId)}`)}
              >
                Open job
              </button>
            </>
          ) : (
            <p className="muted">Job sheet created.</p>
          )}
        </div>
      )}
    </div>
  );
}
