/* ---------------------------------------------------------------
   BACKEND API — every AI call goes through DecisionOS's own backend
   now (see /decisionos-backend). The Anthropic API key lives only
   on that server; the browser never sees it, and tool execution
   (runTool) now happens there too, not in this file. Point this at
   your deployed backend URL in production, e.g. via a build-time
   env var: `import.meta.env?.VITE_DECISIONOS_API_BASE`.
----------------------------------------------------------------*/
const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_DECISIONOS_API_BASE) ||
  "http://localhost:8787";

/* ---------------------------------------------------------------
   AUTH + API CLIENT — the backend (FASE 1/2) requires a Bearer JWT
   on every /api/* route except /api/auth/register and
   /api/auth/login. The token lives in localStorage so a refresh
   doesn't log the user out; apiFetch/apiUpload attach it to every
   request and broadcast a "decisionos:unauthorized" event on 401 so
   AuthGate can drop back to the login screen without every caller
   having to check the status code itself.
----------------------------------------------------------------*/
const TOKEN_KEY = "decisionos_token";
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function handleApiResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event("decisionos:unauthorized"));
  }
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    // Callers that need more than the message (e.g. the duplicate-file warning)
    // read these; everything else keeps using err.message as before.
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}
async function apiFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return handleApiResponse(res);
}
// Multipart upload (Excel files) — no Content-Type header so the browser
// sets the multipart boundary itself.
async function apiUpload(path, formData) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: authHeaders(), body: formData });
  return handleApiResponse(res);
}

// Authenticated file download (the Bearer token can't be sent by a plain
// <a href>, so the file is fetched here and handed to the browser as a Blob).
async function apiDownload(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) await handleApiResponse(res); // throws with the server's message / signs out on 401
  return res.blob();
}
// Saves a Blob through a temporary link, and only revokes the URL afterwards.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ---------------------------------------------------------------
   FASE 8 — job polling. Import/refresh endpoints now return 202 +
   { jobId, status: 'queued' } instead of blocking until the data is
   in. This polls GET /api/datasources/jobs/:jobId until the worker
   marks it completed/failed, calling onProgress after each poll so
   the UI can render a real progress bar instead of a bare spinner.
----------------------------------------------------------------*/
async function pollJob(jobId, { onProgress, intervalMs = 1200, timeoutMs = 10 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await apiFetch(`/api/datasources/jobs/${jobId}`);
    if (onProgress) onProgress(job);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(job.error || "import failed");
    if (Date.now() - startedAt > timeoutMs) throw new Error("import is taking longer than expected — check Data Quality → Sync history");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export { API_BASE, TOKEN_KEY, getToken, setToken, authHeaders, handleApiResponse, apiFetch, apiUpload, apiDownload, saveBlob, pollJob };
