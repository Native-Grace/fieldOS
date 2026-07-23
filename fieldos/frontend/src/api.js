const TOKEN_KEY = "fieldos_token";
const STAFF_KEY = "fieldos_staff";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStaff() {
  const raw = localStorage.getItem(STAFF_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function setSession(token, staff) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STAFF_KEY);
}

async function parseError(res) {
  try {
    const body = await res.json();
    return body.detail || body.message || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.json) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
    delete options.json;
  }
  const res = await fetch(`/api/v1${path}`, { ...options, headers });
  if (res.status === 401) {
    clearSession();
  }
  if (!res.ok) {
    throw new Error(await parseError(res));
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Upload with progress via XHR (fetch has no upload progress). */
export function uploadRecording(
  jobSheetId,
  blob,
  { durationSeconds, triggerProcessing, onProgress, mimeType, filename } = {}
) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const path = `/api/v1/jobs/${encodeURIComponent(jobSheetId)}/recordings/upload`;
    xhr.open("POST", path);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = { message: xhr.responseText };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else {
        const detail = body.detail || body.message || `Upload failed (${xhr.status})`;
        reject(new Error(typeof detail === "string" ? detail : JSON.stringify(detail)));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));

    const form = new FormData();
    const type = mimeType || blob.type || "audio/webm";
    let name = filename || (blob && blob.name) || "";
    if (!name) {
      const ext = type.includes("mp4") ? "mp4" : type.includes("mpeg") || type.includes("mp3") ? "mp3" : type.includes("wav") ? "wav" : type.includes("ogg") ? "ogg" : type.includes("flac") ? "flac" : "webm";
      name = `recording.${ext}`;
    }
    form.append("file", blob, name);
    form.append("duration_seconds", String(durationSeconds || 0));
    form.append("trigger_processing", triggerProcessing ? "true" : "false");
    xhr.send(form);
  });
}
