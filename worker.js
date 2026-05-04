/**
 * Cloudflare Worker — 대시보드에 코드 붙여넣기 배포용 (import 없음)
 *
 * 역할: STL 업로드·목록·삭제 API, records/tools API, 캘린더 동기화(GET/PUT /api/calendar-events → models/calendar-events.json),
 *       견적서 서버 저장(GET/PUT /quotes, GET /quotes/next-dispatch — 저장소의 quotes/*.json). (인증 없음 — Worker URL 비공개 권장)
 * STL 업로드 시각은 models/meta.json 에 파일명 키로 함께 저장합니다.
 * 관리 UI는 GitHub Pages의 admin/index.html 에서 이 Worker를 호출합니다.
 * 공개 뷰어는 Pages(index.html). Worker 루트(/)는 Pages로 리다이렉트.
 *
 * Secrets / Vars: GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO,
 *          GITHUB_QUOTES_REPO (선택 — 비우면 GITHUB_REPO 의 quotes/ 에 저장),
 *          GITHUB_RECORDS_REPO (선택), GITHUB_TOOLS_REPO (선택),
 *          ADMIN_PASSWORD (선택) — 설정 시 Pages(index.html) 진입 시 Worker로 검증
 *
 * 업로드 후 뷰어 링크는 VIEWER_BASE(GitHub Pages URL) 기준입니다.
 */

const GITHUB_API = "https://api.github.com";
const DEFAULT_BRANCH = "main";
const MODELS_PATH = "models";
/** 견적서 JSON — GITHUB_REPO 또는 GITHUB_QUOTES_REPO 기준 상대 경로 */
const QUOTES_DIR = "quotes";
/** 발송번호 ↔ 파일명 매핑(서버 단일 원천). 목록 API에서는 숨김 */
const QUOTES_DISPATCH_INDEX = "_dispatch_index.json";
/** 자동 발송번호 브랜드 접두어 — 예: RIM-2026-482917 */
const QUOTE_DISPATCH_BRAND = "RIM";
/** STL 업로드 시각(ISO 8601) 기록 — GitHub models/meta.json */
const MODELS_META_REL = MODELS_PATH + "/meta.json";
/** 캘린더 공유 JSON — GitHub models/calendar-events.json (calendar-sync-url) */
const CALENDAR_EVENTS_REL = MODELS_PATH + "/calendar-events.json";
const VIEWER_BASE = "https://shinhp3.github.io/eoulrimstudio-models";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function gitContentsPath(relPath) {
  return relPath
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function viewerUrlForFilename(filename) {
  const base = VIEWER_BASE.replace(/\/$/, "");
  const baseName = String(filename).replace(/\.stl$/i, "");
  return base + "/?model=" + encodeURIComponent(baseName);
}

function normalizeStlFilename(name) {
  const lower = String(name).toLowerCase();
  if (!lower.endsWith(".stl")) return null;
  const base = name.slice(0, -4);
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return null;
  return base + ".stl";
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "eoulrimstudio-models-worker",
  };
}

async function githubJson(method, url, token, bodyObj) {
  const opts = {
    method,
    headers: {
      ...githubHeaders(token),
      ...(bodyObj !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (bodyObj !== undefined) opts.body = JSON.stringify(bodyObj);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  const err = new Error((data && data.message) || res.statusText || "HTTP " + res.status);
  err.status = res.status;
  err.data = data;
  if (!res.ok) throw err;
  return data;
}

async function timingSafeEqualUtf8(aStr, bStr) {
  const enc = new TextEncoder();
  const a = enc.encode(aStr);
  const b = enc.encode(bStr);
  try {
    if (a.byteLength !== b.byteLength) return false;
    return await crypto.subtle.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** ADMIN_PASSWORD 가 비어 있지 않으면 true — Pages가 게이트 표시 여부 판단 */
function handleAuthStatus(env) {
  const secret = env.ADMIN_PASSWORD != null ? String(env.ADMIN_PASSWORD) : "";
  const passwordRequired = secret.trim().length > 0;
  return jsonResponse({ passwordRequired });
}

async function handleAuthVerify(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const pw = typeof body.password === "string" ? body.password : "";
  const secret = env.ADMIN_PASSWORD != null ? String(env.ADMIN_PASSWORD) : "";
  if (!secret.trim()) {
    return jsonResponse({ ok: true, configured: false });
  }
  const ok = await timingSafeEqualUtf8(pw, secret);
  return jsonResponse({ ok, configured: true });
}

function requireEnv(env) {
  const token = env.GITHUB_TOKEN;
  const username = env.GITHUB_USERNAME;
  const repo = env.GITHUB_REPO;
  if (!token || !username || !repo) {
    const e = new Error("서버 설정(GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO)이 비어 있습니다.");
    e.status = 500;
    throw e;
  }
  return { token, username, repo };
}

/** 견적 저장용 저장소 — GITHUB_QUOTES_REPO 가 있으면 그쪽, 없으면 GITHUB_REPO */
function requireEnvQuotes(env) {
  const token = env.GITHUB_TOKEN;
  const username = env.GITHUB_USERNAME;
  const quotesRepo =
    env.GITHUB_QUOTES_REPO != null && String(env.GITHUB_QUOTES_REPO).trim()
      ? String(env.GITHUB_QUOTES_REPO).trim()
      : env.GITHUB_REPO;
  if (!token || !username || !quotesRepo) {
    const e = new Error(
      "견적 저장: GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO(또는 GITHUB_QUOTES_REPO)가 필요합니다."
    );
    e.status = 500;
    throw e;
  }
  return { token, username, repo: quotesRepo };
}

function recordsUtf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** @returns {{ map: Record<string, string>, sha?: string }} */
async function fetchModelsMeta(token, username, repo) {
  const apiPath =
    GITHUB_API +
    "/repos/" +
    username +
    "/" +
    repo +
    "/contents/" +
    gitContentsPath(MODELS_META_REL) +
    "?ref=" +
    encodeURIComponent(DEFAULT_BRANCH);
  try {
    const data = await githubJson("GET", apiPath, token);
    if (!data.content || data.encoding !== "base64") {
      return { map: {}, sha: undefined };
    }
    const bin = atob(String(data.content).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder("utf-8").decode(bytes);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { map: {}, sha: typeof data.sha === "string" ? data.sha : undefined };
    }
    const raw =
      parsed && typeof parsed.uploadedAt === "object" && parsed.uploadedAt !== null
        ? parsed.uploadedAt
        : {};
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === "string" && k.toLowerCase().endsWith(".stl") && typeof v === "string") {
        map[k] = v;
      }
    }
    return { map, sha: typeof data.sha === "string" ? data.sha : undefined };
  } catch (e) {
    if (e.status === 404) return { map: {}, sha: undefined };
    throw e;
  }
}

async function saveModelsMeta(token, username, repo, map, sha) {
  const apiPath =
    GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath(MODELS_META_REL);
  const payload = JSON.stringify({ version: 1, uploadedAt: map }, null, 2);
  const content = recordsUtf8ToBase64(payload);
  const putBody = {
    message: "Update models upload dates (meta.json)",
    content,
    branch: DEFAULT_BRANCH,
  };
  if (sha) putBody.sha = sha;
  await githubJson("PUT", apiPath, token, putBody);
}

async function handleUpload(request, env) {
  try {
    const { token, username, repo } = requireEnv(env);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "JSON 본문을 읽을 수 없습니다." }, 400);
    }

    const rawName = body.filename ?? body.name;
    const b64 = body.content ?? body.base64 ?? body.data ?? body.file;
    if (!rawName || typeof b64 !== "string") {
      return jsonResponse(
        { success: false, error: "filename 과 base64 content 필드가 필요합니다." },
        400
      );
    }

    const trimmed = b64.replace(/\s/g, "");
    if (!trimmed.length) {
      return jsonResponse({ success: false, error: "파일 내용이 비어 있습니다." }, 400);
    }

    const safeName = normalizeStlFilename(rawName);
    if (!safeName) {
      return jsonResponse(
        {
          success: false,
          error:
            "허용되지 않는 파일명입니다. .stl 확장자 및 영문·숫자·._- 만 사용하세요.",
        },
        400
      );
    }

    const relPath = MODELS_PATH + "/" + safeName;
    const apiPath = GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath(relPath);

    let sha;
    try {
      const existing = await githubJson(
        "GET",
        apiPath + "?ref=" + encodeURIComponent(DEFAULT_BRANCH),
        token
      );
      if (existing && existing.sha) sha = existing.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    const uploadedAt = new Date().toISOString();
    const putBody = {
      message: "Upload STL: " + safeName + " @ " + uploadedAt,
      content: trimmed,
      branch: DEFAULT_BRANCH,
    };
    if (sha) putBody.sha = sha;

    await githubJson("PUT", apiPath, token, putBody);

    let metaWarning = null;
    try {
      const meta = await fetchModelsMeta(token, username, repo);
      meta.map[safeName] = uploadedAt;
      await saveModelsMeta(token, username, repo, meta.map, meta.sha);
    } catch (me) {
      metaWarning = me.message || String(me);
    }

    const url = viewerUrlForFilename(safeName);
    const out = { success: true, url, filename: safeName, uploadedAt };
    if (metaWarning) out.metaWarning = metaWarning;
    return jsonResponse(out);
  } catch (e) {
    const msg = e.message || String(e);
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handleList(env, request) {
  try {
    const { token, username, repo } = requireEnv(env);
    const pathUrl =
      GITHUB_API +
      "/repos/" +
      username +
      "/" +
      repo +
      "/contents/" +
      gitContentsPath(MODELS_PATH) +
      "?ref=" +
      encodeURIComponent(DEFAULT_BRANCH);

    let data;
    try {
      data = await githubJson("GET", pathUrl, token);
    } catch (e) {
      if (e.status === 404) {
        return jsonResponse({ files: [] });
      }
      throw e;
    }

    if (!Array.isArray(data)) {
      return jsonResponse({ success: false, error: "목록 응답 형식이 올바르지 않습니다." }, 502);
    }

    let metaMap = {};
    try {
      const meta = await fetchModelsMeta(token, username, repo);
      metaMap = meta.map;
    } catch {
      metaMap = {};
    }

    const files = data
      .filter(
        (item) =>
          item.type === "file" && item.name && item.name.toLowerCase().endsWith(".stl")
      )
      .map((item) => {
        const filename = item.name;
        const uploadedAt = metaMap[filename] || null;
        return {
          filename,
          url: viewerUrlForFilename(filename),
          ...(uploadedAt ? { uploadedAt } : {}),
        };
      })
      .sort((a, b) => a.filename.localeCompare(b.filename));

    return jsonResponse({ files });
  } catch (e) {
    const msg = e.message || String(e);
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handleDelete(request, env) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "JSON 본문을 읽을 수 없습니다." }, 400);
    }
    const rawName = body.filename ?? body.name;
    if (!rawName || typeof rawName !== "string") {
      return jsonResponse({ success: false, error: "filename 필드가 필요합니다." }, 400);
    }
    const safeName = normalizeStlFilename(rawName);
    if (!safeName) {
      return jsonResponse({ success: false, error: "허용되지 않는 파일명입니다." }, 400);
    }
    const { token, username, repo } = requireEnv(env);
    const relPath = MODELS_PATH + "/" + safeName;
    const apiPath = GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath(relPath);
    let existing;
    try {
      existing = await githubJson(
        "GET",
        apiPath + "?ref=" + encodeURIComponent(DEFAULT_BRANCH),
        token
      );
    } catch (e) {
      if (e.status === 404) {
        return jsonResponse({ success: false, error: "파일을 찾을 수 없습니다." }, 404);
      }
      throw e;
    }
    if (!existing || !existing.sha) {
      return jsonResponse({ success: false, error: "GitHub 응답에 sha가 없습니다." }, 502);
    }
    await githubJson("DELETE", apiPath, token, {
      message: "Delete STL: " + safeName,
      sha: existing.sha,
      branch: DEFAULT_BRANCH,
    });

    try {
      const meta = await fetchModelsMeta(token, username, repo);
      if (meta.map[safeName]) {
        delete meta.map[safeName];
        await saveModelsMeta(token, username, repo, meta.map, meta.sha);
      }
    } catch {
      /* STL 삭제는 완료됨 — 메타만 불일치할 수 있음 */
    }

    return jsonResponse({ success: true });
  } catch (e) {
    const msg = e.message || String(e);
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handleGetRecords(env) {
  try {
    const token = env.GITHUB_TOKEN;
    const username = env.GITHUB_USERNAME;
    const repo = env.GITHUB_RECORDS_REPO;
    if (!token || !username || !repo) {
      return jsonResponse(
        { success: false, error: "서버 설정(GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_RECORDS_REPO)이 비어 있습니다." },
        500
      );
    }

    const apiPath =
      GITHUB_API +
      "/repos/" +
      username +
      "/" +
      repo +
      "/contents/" +
      gitContentsPath("records.json") +
      "?ref=" +
      encodeURIComponent(DEFAULT_BRANCH);

    let data;
    try {
      data = await githubJson("GET", apiPath, token);
    } catch (e) {
      if (e.status === 404) {
        const body = JSON.stringify({ records: [] });
        return new Response(body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders(),
          },
        });
      }
      throw e;
    }

    if (!data.content || data.encoding !== "base64") {
      return jsonResponse({ success: false, error: "GitHub 응답 형식이 올바르지 않습니다." }, 502);
    }

    const bin = atob(String(data.content).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder("utf-8").decode(bytes);
    const sha = typeof data.sha === "string" ? data.sha : "";
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    });
    headers.set("Access-Control-Expose-Headers", "X-GitHub-Content-Sha");
    if (sha) headers.set("X-GitHub-Content-Sha", sha);
    return new Response(text, { headers });
  } catch (e) {
    const msg = e.message || String(e);
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handlePutRecords(request, env) {
  try {
    const token = env.GITHUB_TOKEN;
    const username = env.GITHUB_USERNAME;
    const repo = env.GITHUB_RECORDS_REPO;
    if (!token || !username || !repo) {
      return jsonResponse(
        { success: false, error: "서버 설정(GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_RECORDS_REPO)이 비어 있습니다." },
        500
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "JSON 본문을 읽을 수 없습니다." }, 400);
    }

    if (!Array.isArray(body.records)) {
      return jsonResponse({ success: false, error: "records 배열이 필요합니다." }, 400);
    }

    const payload = JSON.stringify({ records: body.records }, null, 2);
    const content = recordsUtf8ToBase64(payload);
    const apiPath =
      GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath("records.json");

    const putBody = {
      message: "Update records.json",
      content,
      branch: DEFAULT_BRANCH,
    };
    if (typeof body.sha === "string" && body.sha.length > 0) putBody.sha = body.sha;

    await githubJson("PUT", apiPath, token, putBody);
    return jsonResponse({ success: true });
  } catch (e) {
    const msg = e.message || String(e);
    let status = 500;
    if (typeof e.status === "number" && e.status >= 400 && e.status < 600) status = e.status;
    return jsonResponse({ success: false, error: msg }, status);
  }
}


async function handleGetTools(env) {
  try {
    const token = env.GITHUB_TOKEN;
    const username = env.GITHUB_USERNAME;
    const repo = env.GITHUB_TOOLS_REPO || "eoulrimstudio-tools";
    if (!token || !username) {
      return jsonResponse({ success: false, error: "서버 설정이 비어 있습니다." }, 500);
    }
    const apiPath = GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath("tools.json") + "?ref=" + encodeURIComponent(DEFAULT_BRANCH);
    let data;
    try {
      data = await githubJson("GET", apiPath, token);
    } catch (e) {
      if (e.status === 404) {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
        });
      }
      throw e;
    }
    if (!data.content || data.encoding !== "base64") {
      return jsonResponse({ success: false, error: "GitHub 응답 형식이 올바르지 않습니다." }, 502);
    }
    const bin = atob(String(data.content).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder("utf-8").decode(bytes);
    const sha = typeof data.sha === "string" ? data.sha : "";
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
    headers.set("Access-Control-Expose-Headers", "X-GitHub-Content-Sha");
    if (sha) headers.set("X-GitHub-Content-Sha", sha);
    return new Response(text, { headers });
  } catch (e) {
    const msg = e.message || String(e);
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handlePutTools(request, env) {
  try {
    const token = env.GITHUB_TOKEN;
    const username = env.GITHUB_USERNAME;
    const repo = env.GITHUB_TOOLS_REPO || "eoulrimstudio-tools";
    if (!token || !username) {
      return jsonResponse({ success: false, error: "서버 설정이 비어 있습니다." }, 500);
    }
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ success: false, error: "JSON 본문을 읽을 수 없습니다." }, 400);
    }
    if (!Array.isArray(body.items)) {
      return jsonResponse({ success: false, error: "items 배열이 필요합니다." }, 400);
    }
    const payload = JSON.stringify({ items: body.items }, null, 2);
    const content = recordsUtf8ToBase64(payload);
    const apiPath = GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath("tools.json");
    const putBody = { message: "Update tools.json", content, branch: DEFAULT_BRANCH };
    if (typeof body.sha === "string" && body.sha.length > 0) putBody.sha = body.sha;
    await githubJson("PUT", apiPath, token, putBody);
    return jsonResponse({ success: true });
  } catch (e) {
    const msg = e.message || String(e);
    let status = 500;
    if (typeof e.status === "number" && e.status >= 400 && e.status < 600) status = e.status;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

/** Eoulrim Calendar — GitHub Contents API (GITHUB_REPO 의 models/) */
async function handleGetCalendarEvents(env) {
  try {
    const { token, username, repo } = requireEnv(env);
    const apiPath =
      GITHUB_API +
      "/repos/" +
      username +
      "/" +
      repo +
      "/contents/" +
      gitContentsPath(CALENDAR_EVENTS_REL) +
      "?ref=" +
      encodeURIComponent(DEFAULT_BRANCH);
    try {
      const data = await githubJson("GET", apiPath, token);
      if (!data.content || data.encoding !== "base64") {
        return jsonResponse({ success: false, error: "GitHub 응답 형식이 올바르지 않습니다." }, 502);
      }
      const bin = atob(String(data.content).replace(/\s/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const text = new TextDecoder("utf-8").decode(bytes);
      JSON.parse(text);
      return new Response(text, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders(),
        },
      });
    } catch (e) {
      if (e.status === 404) {
        return new Response("{}", {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders(),
          },
        });
      }
      throw e;
    }
  } catch (e) {
    const msg = e.message || String(e);
    const status =
      typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handlePutCalendarEvents(request, env) {
  try {
    const { token, username, repo } = requireEnv(env);
    const text = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonResponse({ success: false, error: "JSON 본문이 올바르지 않습니다." }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return jsonResponse({ success: false, error: "본문은 JSON 객체여야 합니다." }, 400);
    }
    const normalized = JSON.stringify(parsed);
    const content = recordsUtf8ToBase64(normalized);
    const apiPath =
      GITHUB_API +
      "/repos/" +
      username +
      "/" +
      repo +
      "/contents/" +
      gitContentsPath(CALENDAR_EVENTS_REL);

    let sha;
    try {
      const existing = await githubJson(
        "GET",
        apiPath + "?ref=" + encodeURIComponent(DEFAULT_BRANCH),
        token
      );
      if (existing && existing.sha) sha = existing.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    const iso = new Date().toISOString();
    const putBody = {
      message: "Update calendar: " + CALENDAR_EVENTS_REL + " @ " + iso,
      content,
      branch: DEFAULT_BRANCH,
    };
    if (sha) putBody.sha = sha;

    await githubJson("PUT", apiPath, token, putBody);
    return jsonResponse({ ok: true });
  } catch (e) {
    const msg = e.message || String(e);
    let status = 500;
    if (typeof e.status === "number" && e.status >= 400 && e.status < 600) status = e.status;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

function normalizeQuoteDispatchKey(v) {
  if (v == null) return "";
  return String(v).trim();
}

function decodeGithubFileUtf8(data) {
  if (!data.content || data.encoding !== "base64") return null;
  const bin = atob(String(data.content).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

async function githubQuotesDirEntries(token, username, repo) {
  const apiPath =
    GITHUB_API +
    "/repos/" +
    username +
    "/" +
    repo +
    "/contents/" +
    gitContentsPath(QUOTES_DIR) +
    "?ref=" +
    encodeURIComponent(DEFAULT_BRANCH);
  try {
    const data = await githubJson("GET", apiPath, token);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function fetchQuotesDispatchIndexRecord(token, username, repo) {
  const relPath = QUOTES_DIR + "/" + QUOTES_DISPATCH_INDEX;
  const apiPath =
    GITHUB_API +
    "/repos/" +
    username +
    "/" +
    repo +
    "/contents/" +
    gitContentsPath(relPath) +
    "?ref=" +
    encodeURIComponent(DEFAULT_BRANCH);
  try {
    const data = await githubJson("GET", apiPath, token);
    const text = decodeGithubFileUtf8(data);
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const map =
      parsed &&
      typeof parsed.map === "object" &&
      parsed.map !== null &&
      !Array.isArray(parsed.map)
        ? { ...parsed.map }
        : {};
    return { map, sha: typeof data.sha === "string" ? data.sha : undefined };
  } catch (e) {
    if (e.status === 404) return { map: {}, sha: undefined };
    throw e;
  }
}

async function putQuotesDispatchIndex(token, username, repo, map, sha) {
  const relPath = QUOTES_DIR + "/" + QUOTES_DISPATCH_INDEX;
  const apiPath =
    GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath(relPath);
  const bodyObj = { v: 1, map };
  const content = recordsUtf8ToBase64(JSON.stringify(bodyObj));
  const putBody = {
    message: "Update quote dispatch index",
    content,
    branch: DEFAULT_BRANCH,
  };
  if (sha) putBody.sha = sha;
  await githubJson("PUT", apiPath, token, putBody);
}

async function getQuoteJsonParsed(token, username, repo, fileName) {
  const relPath = QUOTES_DIR + "/" + fileName;
  const apiPath =
    GITHUB_API +
    "/repos/" +
    username +
    "/" +
    repo +
    "/contents/" +
    gitContentsPath(relPath) +
    "?ref=" +
    encodeURIComponent(DEFAULT_BRANCH);
  const data = await githubJson("GET", apiPath, token);
  const text = decodeGithubFileUtf8(data);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function removeQuoteFromDispatchIndex(token, username, repo, fileName) {
  const rec = await fetchQuotesDispatchIndexRecord(token, username, repo);
  const map = { ...rec.map };
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k] === fileName) {
      delete map[k];
      changed = true;
    }
  }
  if (!changed) return;
  await putQuotesDispatchIndex(token, username, repo, map, rec.sha);
}

/** {브랜드}-{연도}-XXXXXX 형태에서 이미 쓰인 6자리 접미사 집합 수집 */
function collectUsedSixDigitSuffixes(prefix, dispatchStrings) {
  const used = new Set();
  for (const raw of dispatchStrings) {
    const n = normalizeQuoteDispatchKey(raw);
    if (!n.startsWith(prefix)) continue;
    const rest = n.slice(prefix.length);
    if (/^\d{6}$/.test(rest)) used.add(rest);
  }
  return used;
}

function randomSixDigitSuffix() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
}

/** 다음 자동 발송번호 — 연도 고정 + 6자리 무작위 숫자(저장소·인덱스와 중복 시 재시도) */
async function handleDispatchNext(env) {
  try {
    const { token, username, repo } = requireEnvQuotes(env);
    const year = new Date().getFullYear();
    const prefix = QUOTE_DISPATCH_BRAND + "-" + year + "-";

    const list = await githubQuotesDirEntries(token, username, repo);
    const jsonFiles = list.filter(
      (f) =>
        f.type === "file" &&
        f.name.endsWith(".json") &&
        f.name !== QUOTES_DISPATCH_INDEX,
    );

    const dispatchStrings = [];
    const idx = await fetchQuotesDispatchIndexRecord(token, username, repo);
    for (const k of Object.keys(idx.map)) dispatchStrings.push(k);

    if (jsonFiles.length > 0) {
      let ptr = 0;
      const workers = Math.min(6, jsonFiles.length);
      async function oneWorker() {
        while (ptr < jsonFiles.length) {
          const i = ptr++;
          const f = jsonFiles[i];
          try {
            const parsed = await getQuoteJsonParsed(token, username, repo, f.name);
            if (parsed && parsed.dispatchNo != null) dispatchStrings.push(parsed.dispatchNo);
          } catch {
            /* 파일 손상 등은 건너뜀 */
          }
        }
      }
      await Promise.all(Array.from({ length: workers }, () => oneWorker()));
    }

    const usedSix = collectUsedSixDigitSuffixes(prefix, dispatchStrings);
    let next = "";
    for (let attempt = 0; attempt < 160; attempt++) {
      const suf = randomSixDigitSuffix();
      if (!usedSix.has(suf)) {
        next = prefix + suf;
        break;
      }
    }
    if (!next) {
      return jsonResponse(
        {
          success: false,
          error:
            "사용 가능한 무작위 발송번호를 만들지 못했습니다. 잠시 후 다시 시도하거나 수동으로 입력해 주세요.",
        },
        500,
      );
    }
    return jsonResponse({ dispatchNo: next });
  } catch (e) {
    const msg = e.message || String(e);
    const status =
      typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

/** 견적서 — quotes/ 목록 (프론트 app.js 와 동일 계약) */
async function handleQuotesList(env) {
  try {
    const { token, username, repo } = requireEnvQuotes(env);
    const data = await githubQuotesDirEntries(token, username, repo);
    if (!Array.isArray(data)) return jsonResponse({ items: [] });
    const items = data
      .filter(
        (f) =>
          f.type === "file" &&
          f.name.endsWith(".json") &&
          f.name !== QUOTES_DISPATCH_INDEX,
      )
      .map((f) => ({
        name: f.name,
        path: f.path,
        sha: f.sha,
        size: f.size,
        html_url: f.html_url,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return jsonResponse({ items });
  } catch (e) {
    const msg = e.message || String(e);
    const status =
      typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handleQuoteGet(env, fileName) {
  try {
    if (!fileName || fileName.includes("..") || fileName.includes("/")) {
      return jsonResponse({ success: false, error: "잘못된 파일 이름입니다." }, 400);
    }
    const { token, username, repo } = requireEnvQuotes(env);
    const relPath = QUOTES_DIR + "/" + fileName;
    const apiPath =
      GITHUB_API +
      "/repos/" +
      username +
      "/" +
      repo +
      "/contents/" +
      gitContentsPath(relPath) +
      "?ref=" +
      encodeURIComponent(DEFAULT_BRANCH);
    const data = await githubJson("GET", apiPath, token);
    if (data.type !== "file") {
      return jsonResponse({ success: false, error: "파일이 아닙니다." }, 400);
    }
    if (!data.content || data.encoding !== "base64") {
      return jsonResponse({ success: false, error: "GitHub 응답 형식이 올바르지 않습니다." }, 502);
    }
    const bin = atob(String(data.content).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder("utf-8").decode(bytes);
    return new Response(text, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(),
      },
    });
  } catch (e) {
    const msg = e.message || String(e);
    const status =
      typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handleQuotePut(request, env, fileName) {
  try {
    if (!fileName || fileName.includes("..") || fileName.includes("/")) {
      return jsonResponse({ success: false, error: "잘못된 파일 이름입니다." }, 400);
    }
    if (fileName === QUOTES_DISPATCH_INDEX) {
      return jsonResponse({ success: false, error: "예약된 파일 이름입니다." }, 400);
    }
    const { token, username, repo } = requireEnvQuotes(env);
    let bodyJson;
    try {
      bodyJson = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "JSON 본문을 읽을 수 없습니다." }, 400);
    }
    const dispatchKey = normalizeQuoteDispatchKey(bodyJson.dispatchNo);
    if (!dispatchKey) {
      return jsonResponse({ success: false, error: "발송번호가 비어 있습니다." }, 400);
    }

    const idxRec = await fetchQuotesDispatchIndexRecord(token, username, repo);
    const map = { ...idxRec.map };
    for (const k of Object.keys(map)) {
      if (map[k] === fileName && k !== dispatchKey) delete map[k];
    }
    const holder = map[dispatchKey];
    if (holder && holder !== fileName) {
      return jsonResponse(
        {
          success: false,
          error:
            "이미 사용 중인 발송번호입니다. 다른 번호로 바꾸거나 「발송번호 새로 받기」를 사용한 뒤 저장해 주세요.",
          duplicateFile: holder,
        },
        409,
      );
    }

    const normalized = JSON.stringify(bodyJson);
    const content = recordsUtf8ToBase64(normalized);
    const relPath = QUOTES_DIR + "/" + fileName;
    const apiPath =
      GITHUB_API + "/repos/" + username + "/" + repo + "/contents/" + gitContentsPath(relPath);

    let sha;
    try {
      const existing = await githubJson(
        "GET",
        apiPath + "?ref=" + encodeURIComponent(DEFAULT_BRANCH),
        token
      );
      if (existing && existing.sha) sha = existing.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    const putBody = {
      message: "Save quote " + fileName,
      content,
      branch: DEFAULT_BRANCH,
    };
    if (sha) putBody.sha = sha;

    await githubJson("PUT", apiPath, token, putBody);

    const idxCur = await fetchQuotesDispatchIndexRecord(token, username, repo);
    const m = { ...idxCur.map };
    for (const k of Object.keys(m)) {
      if (m[k] === fileName && k !== dispatchKey) delete m[k];
    }
    const blocking = m[dispatchKey];
    if (blocking && blocking !== fileName) {
      return jsonResponse(
        {
          success: false,
          error:
            "발송번호가 다른 저장과 겹쳤습니다. 발송번호를 바꾼 뒤 다시 저장해 주세요. (견적 파일은 이미 서버에 반영되었을 수 있습니다.)",
          duplicateFile: blocking,
        },
        409,
      );
    }
    m[dispatchKey] = fileName;
    await putQuotesDispatchIndex(token, username, repo, m, idxCur.sha);

    return jsonResponse({ ok: true, path: relPath });
  } catch (e) {
    const msg = e.message || String(e);
    let status = 500;
    if (typeof e.status === "number" && e.status >= 400 && e.status < 600) status = e.status;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

async function handleQuoteDelete(env, fileName) {
  try {
    if (!fileName || fileName.includes("..") || fileName.includes("/")) {
      return jsonResponse({ success: false, error: "잘못된 파일 이름입니다." }, 400);
    }
    const { token, username, repo } = requireEnvQuotes(env);
    const relPath = QUOTES_DIR + "/" + fileName;
    const apiPath =
      GITHUB_API +
      "/repos/" +
      username +
      "/" +
      repo +
      "/contents/" +
      gitContentsPath(relPath);
    let existing;
    try {
      existing = await githubJson(
        "GET",
        apiPath + "?ref=" + encodeURIComponent(DEFAULT_BRANCH),
        token
      );
    } catch (e) {
      if (e.status === 404) {
        return jsonResponse({ success: false, error: "파일을 찾을 수 없습니다." }, 404);
      }
      throw e;
    }
    if (!existing || !existing.sha) {
      return jsonResponse({ success: false, error: "GitHub 응답에 sha가 없습니다." }, 502);
    }
    await githubJson("DELETE", apiPath, token, {
      message: "Delete quote " + fileName,
      sha: existing.sha,
      branch: DEFAULT_BRANCH,
    });
    try {
      await removeQuoteFromDispatchIndex(token, username, repo, fileName);
    } catch {
      /* 인덱스 정리 실패는 삭제 자체는 완료된 상태 — 수동 동기화 가능 */
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    const msg = e.message || String(e);
    let status = 500;
    if (typeof e.status === "number" && e.status >= 400 && e.status < 600) status = e.status;
    return jsonResponse({ success: false, error: msg }, status);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const path = new URL(request.url).pathname;
    const quoteFileMatch = path.match(/^\/quotes\/([^/]+\.json)$/);

    if (path === "/quotes/next-dispatch" && request.method === "GET") {
      return handleDispatchNext(env);
    }
    if (path === "/quotes" && request.method === "GET") {
      return handleQuotesList(env);
    }
    if (quoteFileMatch && request.method === "GET") {
      return handleQuoteGet(env, decodeURIComponent(quoteFileMatch[1]));
    }
    if (quoteFileMatch && request.method === "PUT") {
      return handleQuotePut(request, env, decodeURIComponent(quoteFileMatch[1]));
    }
    if (quoteFileMatch && request.method === "DELETE") {
      return handleQuoteDelete(env, decodeURIComponent(quoteFileMatch[1]));
    }

    if (path === "/auth/status" && request.method === "GET") {
      return handleAuthStatus(env);
    }

    if (path === "/auth/verify" && request.method === "POST") {
      return handleAuthVerify(request, env);
    }

    if (path === "/records" && request.method === "GET") {
      return handleGetRecords(env);
    }

    if (path === "/records" && request.method === "PUT") {
      return handlePutRecords(request, env);
    }

    if (path === "/tools" && request.method === "GET") {
      return handleGetTools(env);
    }

    if (path === "/tools" && request.method === "PUT") {
      return handlePutTools(request, env);
    }

    if (path === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (path === "/list" && request.method === "GET") {
      return handleList(env, request);
    }

    if (path === "/delete" && request.method === "DELETE") {
      return handleDelete(request, env);
    }

    if (path === "/api/calendar-events" && request.method === "GET") {
      return handleGetCalendarEvents(env);
    }

    if (path === "/api/calendar-events" && request.method === "PUT") {
      return handlePutCalendarEvents(request, env);
    }

    if (request.method === "GET") {
      if (path === "/admin" || path === "/admin/index.html") {
        const adminPages = new URL("https://shinhp3.github.io/eoulrimstudio-models/admin/");
        return Response.redirect(adminPages.toString(), 302);
      }
      const pagesRoot = new URL("https://shinhp3.github.io/eoulrimstudio-models/");
      const incoming = new URL(request.url);
      pagesRoot.search = incoming.search;
      pagesRoot.hash = incoming.hash;
      return Response.redirect(pagesRoot.toString(), 302);
    }

    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  },
};
