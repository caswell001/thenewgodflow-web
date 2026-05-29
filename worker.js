// thenewgodflow-web Worker
// Serves static assets by default; intercepts /api/admin/* for the protected admin dashboard.

const ALLOWED_ORIGINS = [
  "https://thenewgodflow.com",
  "https://www.thenewgodflow.com",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// Constant-time string compare
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false, status: 401, error: "Missing bearer token" };
  if (!env.ADMIN_PASSWORD) return { ok: false, status: 500, error: "Admin not configured" };
  if (!safeEqual(m[1], env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return { ok: false, status: 401, error: "Invalid password" };
  }
  return { ok: true };
}

async function resendList(env, opts = {}) {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) {
    return { ok: false, error: "Resend not configured. Set RESEND_API_KEY and RESEND_AUDIENCE_ID as Worker secrets." };
  }
  const url = `https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!r.ok) {
    return { ok: false, error: `Resend ${r.status}: ${(await r.text()).slice(0, 300)}` };
  }
  const data = await r.json();
  return { ok: true, contacts: data.data || [] };
}

async function resendUnsubscribe(env, email) {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) {
    return { ok: false, error: "Resend not configured" };
  }
  const url = `https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ unsubscribed: true }),
  });
  if (!r.ok) return { ok: false, error: await r.text() };
  return { ok: true };
}

// --- Author page editor (PR-on-save) ---
// Pulls structured fields from a parsed version of author/index.html, lets dashboard PATCH them,
// and on save creates a branch + commits + opens a PR. User merges in GitHub to deploy.

const REPO_OWNER = "caswell001";
const REPO_NAME = "thenewgodflow-web";

const AUTHOR_FIELDS = [
  { id: "caption_html", marker: ["<p class=\"caption\">", "</p>"] },
  { id: "first_book_html", marker: ["<p class=\"first-book\">", "</p>"] },
  { id: "para1_html", marker: ["<!-- para1:start -->", "<!-- para1:end -->"] },
  { id: "para2_html", marker: ["<!-- para2:start -->", "<!-- para2:end -->"] },
  { id: "closing_html", marker: ["<!-- closing:start -->", "<!-- closing:end -->"] },
  { id: "connect_heading", marker: ["<p class=\"connect\">", "</p>"] },
  { id: "ig_button_html", marker: ["<a class=\"ig\"", "</a>"], includeMarkers: true },
];

function extractFields(html) {
  const out = {};
  for (const f of AUTHOR_FIELDS) {
    const [a, b] = f.marker;
    const i = html.indexOf(a);
    if (i < 0) { out[f.id] = null; continue; }
    if (f.includeMarkers) {
      const j = html.indexOf(b, i);
      out[f.id] = j < 0 ? null : html.slice(i, j + b.length);
    } else {
      const start = i + a.length;
      const j = html.indexOf(b, start);
      out[f.id] = j < 0 ? null : html.slice(start, j).trim();
    }
  }
  return out;
}

function replaceFields(html, fields) {
  let out = html;
  for (const f of AUTHOR_FIELDS) {
    if (!(f.id in fields) || fields[f.id] == null) continue;
    const [a, b] = f.marker;
    const i = out.indexOf(a);
    if (i < 0) continue;
    if (f.includeMarkers) {
      const j = out.indexOf(b, i);
      if (j < 0) continue;
      out = out.slice(0, i) + fields[f.id] + out.slice(j + b.length);
    } else {
      const start = i + a.length;
      const j = out.indexOf(b, start);
      if (j < 0) continue;
      out = out.slice(0, start) + "\n      " + fields[f.id] + "\n    " + out.slice(j);
    }
  }
  return out;
}

async function gh(env, method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "thenewgodflow-admin",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, ok: r.ok, data };
}

async function getAuthorHtmlFromMain(env) {
  const r = await gh(env, "GET", `/repos/${REPO_OWNER}/${REPO_NAME}/contents/author/index.html?ref=main`);
  if (!r.ok) return { ok: false, error: r.data };
  return { ok: true, content: atob(r.data.content.replace(/\n/g, "")), sha: r.data.sha };
}

async function openAuthorPR(env, fields, commitMessage) {
  if (!env.GITHUB_PAT) return { ok: false, error: "GITHUB_PAT not configured" };
  const cur = await getAuthorHtmlFromMain(env);
  if (!cur.ok) return cur;
  const newHtml = replaceFields(cur.content, fields);
  if (newHtml === cur.content) return { ok: false, error: "No changes detected" };

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const branch = `admin/author-${ts}`;

  // get main sha
  const ref = await gh(env, "GET", `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/main`);
  if (!ref.ok) return { ok: false, error: ref.data };
  const parentSha = ref.data.object.sha;

  // create branch
  const newRef = await gh(env, "POST", `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: parentSha,
  });
  if (!newRef.ok) return { ok: false, error: newRef.data };

  // update file on branch
  const upd = await gh(env, "PUT", `/repos/${REPO_OWNER}/${REPO_NAME}/contents/author/index.html`, {
    message: commitMessage || `Author page edit (${ts})`,
    content: btoa(unescape(encodeURIComponent(newHtml))),
    sha: cur.sha,
    branch,
  });
  if (!upd.ok) return { ok: false, error: upd.data };

  // open PR
  const pr = await gh(env, "POST", `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
    title: commitMessage || `Author page edit ${ts}`,
    head: branch,
    base: "main",
    body: "Edit made via /admin dashboard. Merge to deploy.\n\nReview the diff before merging.",
  });
  if (!pr.ok) return { ok: false, error: pr.data };

  return { ok: true, prNumber: pr.data.number, prUrl: pr.data.html_url, branch };
}

async function listOpenPRs(env) {
  if (!env.GITHUB_PAT) return { ok: false, error: "GITHUB_PAT not configured" };
  const r = await gh(env, "GET", `/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=20`);
  if (!r.ok) return { ok: false, error: r.data };
  return {
    ok: true,
    prs: (r.data || []).map((p) => ({
      number: p.number, title: p.title, url: p.html_url, branch: p.head.ref, created: p.created_at,
    })),
  };
}

// --- Main fetch handler ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!url.pathname.startsWith("/api/admin/")) {
      return env.ASSETS.fetch(request);
    }

    const auth = await requireAdmin(request, env);
    if (!auth.ok) return json({ error: auth.error }, auth.status, cors);

    // ROUTES
    if (url.pathname === "/api/admin/ping" && request.method === "GET") {
      return json({ ok: true, time: new Date().toISOString() }, 200, cors);
    }

    if (url.pathname === "/api/admin/subscribers" && request.method === "GET") {
      const r = await resendList(env);
      if (!r.ok) return json({ error: r.error }, 500, cors);
      return json({ contacts: r.contacts }, 200, cors);
    }

    if (url.pathname === "/api/admin/unsubscribe" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = (body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "Email required" }, 400, cors);
      const r = await resendUnsubscribe(env, email);
      if (!r.ok) return json({ error: r.error }, 500, cors);
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/api/admin/author" && request.method === "GET") {
      const cur = await getAuthorHtmlFromMain(env);
      if (!cur.ok) return json({ error: cur.error }, 500, cors);
      return json({ fields: extractFields(cur.content), sha: cur.sha }, 200, cors);
    }

    if (url.pathname === "/api/admin/author" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const fields = body.fields || {};
      const message = (body.message || "").toString().slice(0, 200);
      const r = await openAuthorPR(env, fields, message);
      if (!r.ok) return json({ error: r.error }, 500, cors);
      return json(r, 200, cors);
    }

    if (url.pathname === "/api/admin/prs" && request.method === "GET") {
      const r = await listOpenPRs(env);
      if (!r.ok) return json({ error: r.error }, 500, cors);
      return json(r, 200, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  },
};
