const TOKEN_KEY = "fieldos_token";
const STAFF_KEY = "fieldos_staff";

export class ApiError extends Error {
  constructor(message, status, detail = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

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

/** Alias kept for callers that clear auth after a 401 download. */
export function clearToken() {
  clearSession();
}

async function parseError(res) {
  try {
    const body = await res.json();
    const detail = body.detail || body.message || res.statusText;
    if (Array.isArray(detail)) {
      return {
        message: detail
          .map((row) => (typeof row === "string" ? row : row?.msg || JSON.stringify(row)))
          .filter(Boolean)
          .join("; "),
        detail,
      };
    }
    if (detail && typeof detail === "object") {
      return {
        message: String(detail.message || JSON.stringify(detail)),
        detail,
      };
    }
    return { message: typeof detail === "string" ? detail : String(detail), detail: null };
  } catch {
    return { message: res.statusText || `Request failed (${res.status})`, detail: null };
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
    const parsed = await parseError(res);
    throw new ApiError(parsed.message, res.status, parsed.detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Parse a Content-Disposition filename, supporting quoted and UTF-8 forms.
 * Never logs or returns tokens — disposition must not carry credentials.
 */
export function parseContentDispositionFilename(disposition) {
  const header = String(disposition || "");
  if (!header) return "";
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"+|"+$/g, ""));
    } catch {
      return utf8[1].trim().replace(/^"+|"+$/g, "");
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1]) return bare[1].trim().replace(/^"+|"+$/g, "");
  return "";
}

/**
 * Authenticated binary download.
 *
 * Token stays in the Authorization header — never in the URL, query string,
 * filename, or logs. Triggers a same-tab blob download so /reports is not left.
 *
 * @param {string} path API path under /api/v1 (e.g. `/reports/RPT-1/download`)
 * @param {string|{fallbackName?:string,fallbackFilename?:string,expectPdf?:boolean,triggerDownload?:boolean}} [fallbackOrOptions]
 * @returns {Promise<{blob: Blob, fileName: string}>}
 */
export async function downloadAuthenticatedFile(path, fallbackOrOptions = "download.bin") {
  let fallbackName = "download.bin";
  let expectPdf;
  let triggerDownload = true;
  if (typeof fallbackOrOptions === "string") {
    fallbackName = fallbackOrOptions || "download.bin";
  } else if (fallbackOrOptions && typeof fallbackOrOptions === "object") {
    fallbackName =
      fallbackOrOptions.fallbackName ||
      fallbackOrOptions.fallbackFilename ||
      "download.bin";
    if (typeof fallbackOrOptions.expectPdf === "boolean") {
      expectPdf = fallbackOrOptions.expectPdf;
    }
    if (typeof fallbackOrOptions.triggerDownload === "boolean") {
      triggerDownload = fallbackOrOptions.triggerDownload;
    }
  }
  if (typeof expectPdf !== "boolean") {
    expectPdf = /\.pdf$/i.test(fallbackName) || /\.pdf(\?|$)/i.test(String(path));
  }

  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`/api/v1${path}`, {
    method: "GET",
    headers,
  });

  if (response.status === 401) {
    clearSession();
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }

  if (!response.ok) {
    let message = `Download failed (${response.status})`;
    try {
      message = (await parseError(response)) || message;
    } catch {
      /* keep status message */
    }
    throw new ApiError(message, response.status);
  }

  const blob = await response.blob();
  if (!blob || !blob.size) {
    throw new ApiError(
      expectPdf ? "The downloaded PDF was empty." : "The downloaded file was empty.",
      response.status || 422
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (expectPdf && !contentType.toLowerCase().includes("application/pdf")) {
    throw new ApiError("The server did not return a PDF.", response.status || 422);
  }

  const disposition = response.headers.get("content-disposition") || "";
  const fileName = parseContentDispositionFilename(disposition) || fallbackName;

  if (triggerDownload) {
    triggerBrowserDownload(blob, fileName);
  }

  return { blob, fileName };
}

export function triggerBrowserDownload(blob, fileName) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName || "download.bin";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
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
      const ext = type.includes("mp4")
        ? "mp4"
        : type.includes("mpeg") || type.includes("mp3")
          ? "mp3"
          : type.includes("wav")
            ? "wav"
            : type.includes("ogg")
              ? "ogg"
              : type.includes("flac")
                ? "flac"
                : "webm";
      name = `recording.${ext}`;
    }
    form.append("file", blob, name);
    form.append("duration_seconds", String(durationSeconds || 0));
    form.append("trigger_processing", triggerProcessing ? "true" : "false");
    xhr.send(form);
  });
}

/** Generic multipart upload with progress (Create Job from Recording, etc.). */
export function uploadForm(path, formData, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1${path}`);
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
        reject(new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(formData);
  });
}
