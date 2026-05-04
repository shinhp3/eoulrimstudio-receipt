/**
 * GitHub Contents API 프록시. 토큰은 Worker 시크릿(GITHUB_TOKEN)에만 둡니다.
 *
 * 바인딩:
 * - Secret: GITHUB_TOKEN
 * - Var (택1 또는 조합):
 *   - GITHUB_REPOSITORY = "owner/repo"  → 이 값이 있으면 우선 사용
 *   - 또는 GITHUB_USERNAME + GITHUB_REPO
 * - Var (선택): GITHUB_BRANCH (기본 main), QUOTES_PREFIX (기본 quotes)
 */

const GH_API = 'https://api.github.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function errJson(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

function text(msg, status = 400) {
  return new Response(msg, { status, headers: corsHeaders() });
}

function encodePath(segments) {
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

/** owner/repo 해석 (GITHUB_REPOSITORY 단일 변수 지원) */
function resolveRepo(env) {
  const full = (env.GITHUB_REPOSITORY || '').trim();
  if (full.includes('/')) {
    const i = full.indexOf('/');
    const owner = full.slice(0, i).trim();
    const repo = full.slice(i + 1).trim();
    if (owner && repo) return { owner, repo };
  }
  const owner = (env.GITHUB_USERNAME || '').trim();
  const repo = (env.GITHUB_REPO || '').trim();
  return { owner, repo };
}

async function ghFetch(env, path, init = {}) {
  const url = `${GH_API}${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'eoulrimstudio-upload-worker',
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}

function normalizePathname(url) {
  let pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname.startsWith('/api')) pathname = pathname.slice(4) || '/';
  return pathname;
}

const QUOTES_DISPATCH_INDEX = '_dispatch_index.json';
/** 자동 발송번호 브랜드 접두어 — 예: RIM-2026-482917 */
const QUOTE_DISPATCH_BRAND = 'RIM';

function normalizeQuoteDispatchKey(v) {
  if (v == null) return '';
  return String(v).trim();
}

function decodeGithubFileUtf8(meta) {
  if (!meta.content || meta.encoding !== 'base64') return null;
  const bin = atob(meta.content.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function utf8ToBase64Json(obj) {
  const str = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function quoteRelPath(prefix, fileName) {
  return `${prefix}/${fileName}`;
}

async function ghQuotesDirList(env, owner, repo, branch, prefix) {
  const ghPath = `/repos/${owner}/${repo}/contents/${encodePath(prefix.split('/'))}`;
  const res = await ghFetch(env, `${ghPath}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return [];
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub 목록 실패: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchQuotesDispatchIndexRecord(env, owner, repo, branch, prefix) {
  const relPath = quoteRelPath(prefix, QUOTES_DISPATCH_INDEX);
  const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;
  const res = await ghFetch(env, `${apiPath}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return { map: {}, sha: undefined };
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`인덱스 읽기 실패: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = decodeGithubFileUtf8(data);
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const map =
    parsed && typeof parsed.map === 'object' && parsed.map !== null && !Array.isArray(parsed.map)
      ? { ...parsed.map }
      : {};
  return { map, sha: data.sha };
}

async function putQuotesDispatchIndex(env, owner, repo, branch, prefix, map, sha) {
  const relPath = quoteRelPath(prefix, QUOTES_DISPATCH_INDEX);
  const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;
  const bodyObj = { v: 1, map };
  const content = utf8ToBase64Json(bodyObj);
  const putBody = { message: 'Update quote dispatch index', content, branch };
  if (sha) putBody.sha = sha;
  const putRes = await ghFetch(env, apiPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`인덱스 저장 실패: ${putRes.status} ${t.slice(0, 200)}`);
  }
}

async function getQuoteJsonParsed(env, owner, repo, branch, prefix, fileName) {
  const relPath = quoteRelPath(prefix, fileName);
  const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;
  const res = await ghFetch(env, `${apiPath}?ref=${encodeURIComponent(branch)}`);
  if (!res.ok) return null;
  const meta = await res.json();
  const text = decodeGithubFileUtf8(meta);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function removeQuoteFromDispatchIndex(env, owner, repo, branch, prefix, fileName) {
  const rec = await fetchQuotesDispatchIndexRecord(env, owner, repo, branch, prefix);
  const map = { ...rec.map };
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k] === fileName) {
      delete map[k];
      changed = true;
    }
  }
  if (!changed) return;
  await putQuotesDispatchIndex(env, owner, repo, branch, prefix, map, rec.sha);
}

function collectUsedSixDigitSuffixes(brandYearPrefix, dispatchStrings) {
  const used = new Set();
  for (const raw of dispatchStrings) {
    const n = normalizeQuoteDispatchKey(raw);
    if (!n.startsWith(brandYearPrefix)) continue;
    const rest = n.slice(brandYearPrefix.length);
    if (/^\d{6}$/.test(rest)) used.add(rest);
  }
  return used;
}

function randomSixDigitSuffix() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

async function handleDispatchNext(env, owner, repo, branch, prefix) {
  try {
    const year = new Date().getFullYear();
    const pref = `${QUOTE_DISPATCH_BRAND}-${year}-`;
    const list = await ghQuotesDirList(env, owner, repo, branch, prefix);
    const jsonFiles = list.filter(
      (f) =>
        f.type === 'file' &&
        f.name.endsWith('.json') &&
        f.name !== QUOTES_DISPATCH_INDEX,
    );

    const dispatchStrings = [];
    const idx = await fetchQuotesDispatchIndexRecord(env, owner, repo, branch, prefix);
    for (const k of Object.keys(idx.map)) dispatchStrings.push(k);

    if (jsonFiles.length > 0) {
      let ptr = 0;
      const workers = Math.min(6, jsonFiles.length);
      async function oneWorker() {
        while (ptr < jsonFiles.length) {
          const i = ptr++;
          const f = jsonFiles[i];
          try {
            const parsed = await getQuoteJsonParsed(env, owner, repo, branch, prefix, f.name);
            if (parsed && parsed.dispatchNo != null) dispatchStrings.push(parsed.dispatchNo);
          } catch {
            /* */
          }
        }
      }
      await Promise.all(Array.from({ length: workers }, () => oneWorker()));
    }

    const usedSix = collectUsedSixDigitSuffixes(pref, dispatchStrings);
    let next = '';
    for (let attempt = 0; attempt < 160; attempt++) {
      const suf = randomSixDigitSuffix();
      if (!usedSix.has(suf)) {
        next = pref + suf;
        break;
      }
    }
    if (!next) {
      return errJson(
        '사용 가능한 무작위 발송번호를 만들지 못했습니다. 잠시 후 다시 시도하거나 수동으로 입력해 주세요.',
        500,
      );
    }
    return json({ dispatchNo: next });
  } catch (e) {
    return errJson(e.message || String(e), 500);
  }
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { owner, repo } = resolveRepo(env);
  if (!env.GITHUB_TOKEN || !owner || !repo) {
    return errJson(
      'Worker 설정 필요: GITHUB_TOKEN 시크릿 + GITHUB_REPOSITORY(owner/repo) 또는 GITHUB_USERNAME·GITHUB_REPO',
      500,
    );
  }

  const branch = (env.GITHUB_BRANCH || 'main').trim();
  const prefix = (env.QUOTES_PREFIX || 'quotes').replace(/^\/+|\/+$/g, '');

  const url = new URL(request.url);
  const pathname = normalizePathname(url);

  if (pathname === '/' && request.method === 'GET') {
    return json({
      ok: true,
      service: 'eoulrimstudio-upload',
      repo: `${owner}/${repo}`,
      branch,
      quotesPrefix: prefix,
      routes: [
        'GET /quotes/next-dispatch',
        'GET /quotes',
        'GET /quotes/:name.json',
        'PUT /quotes/:name.json',
        'DELETE /quotes/:name.json',
      ],
    });
  }

  if (pathname === '/quotes/next-dispatch' && request.method === 'GET') {
    return handleDispatchNext(env, owner, repo, branch, prefix);
  }

  if (pathname === '/quotes' && request.method === 'GET') {
    const ghPath = `/repos/${owner}/${repo}/contents/${encodePath(prefix.split('/'))}`;
    const res = await ghFetch(env, `${ghPath}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) {
      return json({ items: [] });
    }
    if (!res.ok) {
      const t = await res.text();
      return errJson(`GitHub 목록 실패: ${res.status}`, 502, { detail: t.slice(0, 500) });
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      return json({ items: [] });
    }
    const items = data
      .filter(
        (f) =>
          f.type === 'file' &&
          f.name.endsWith('.json') &&
          f.name !== QUOTES_DISPATCH_INDEX,
      )
      .map((f) => ({
        name: f.name,
        path: f.path,
        sha: f.sha,
        size: f.size,
        html_url: f.html_url,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return json({ items });
  }

  const putMatch = pathname.match(/^\/quotes\/([^/]+\.json)$/);
  if (putMatch && request.method === 'PUT') {
    const fileName = decodeURIComponent(putMatch[1]);
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      return errJson('잘못된 파일 이름입니다.', 400);
    }
    if (fileName === QUOTES_DISPATCH_INDEX) {
      return errJson('예약된 파일 이름입니다.', 400);
    }

    let bodyJson;
    try {
      bodyJson = await request.json();
    } catch {
      return errJson('JSON 본문이 아닙니다.', 400);
    }
    const dispatchKey = normalizeQuoteDispatchKey(bodyJson.dispatchNo);
    if (!dispatchKey) {
      return errJson('발송번호가 비어 있습니다.', 400);
    }

    try {
      const idxRec = await fetchQuotesDispatchIndexRecord(env, owner, repo, branch, prefix);
      const map = { ...idxRec.map };
      for (const k of Object.keys(map)) {
        if (map[k] === fileName && k !== dispatchKey) delete map[k];
      }
      const holder = map[dispatchKey];
      if (holder && holder !== fileName) {
        return errJson(
          '이미 사용 중인 발송번호입니다. 다른 번호로 바꾸거나 「발송번호 새로 받기」를 사용한 뒤 저장해 주세요.',
          409,
          { duplicateFile: holder },
        );
      }

      const relPath = `${prefix}/${fileName}`;
      const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;
      const bytes = new TextEncoder().encode(JSON.stringify(bodyJson));
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const content = btoa(binary);

      const getExisting = await ghFetch(env, `${apiPath}?ref=${encodeURIComponent(branch)}`);
      let sha;
      if (getExisting.ok) {
        const meta = await getExisting.json();
        sha = meta.sha;
      }

      const putBody = {
        message: `Save quote ${fileName}`,
        content,
        branch,
      };
      if (sha) putBody.sha = sha;

      const putRes = await ghFetch(env, apiPath, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody),
      });

      if (!putRes.ok) {
        const t = await putRes.text();
        return errJson(`GitHub 저장 실패: ${putRes.status}`, 502, { detail: t.slice(0, 500) });
      }

      const idxCur = await fetchQuotesDispatchIndexRecord(env, owner, repo, branch, prefix);
      const m = { ...idxCur.map };
      for (const k of Object.keys(m)) {
        if (m[k] === fileName && k !== dispatchKey) delete m[k];
      }
      const blocking = m[dispatchKey];
      if (blocking && blocking !== fileName) {
        return errJson(
          '발송번호가 다른 저장과 겹쳤습니다. 발송번호를 바꾼 뒤 다시 저장해 주세요. (견적 파일은 이미 서버에 반영되었을 수 있습니다.)',
          409,
          { duplicateFile: blocking },
        );
      }
      m[dispatchKey] = fileName;
      await putQuotesDispatchIndex(env, owner, repo, branch, prefix, m, idxCur.sha);

      return json({ ok: true, path: relPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errJson(msg, 500);
    }
  }

  const getMatch = pathname.match(/^\/quotes\/([^/]+\.json)$/);
  if (getMatch && request.method === 'GET') {
    const fileName = decodeURIComponent(getMatch[1]);
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      return errJson('잘못된 파일 이름입니다.', 400);
    }
    const relPath = `${prefix}/${fileName}`;
    const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;
    const res = await ghFetch(env, `${apiPath}?ref=${encodeURIComponent(branch)}`);
    if (!res.ok) {
      const t = await res.text();
      const status = res.status === 404 ? 404 : 502;
      return errJson(`GitHub 읽기 실패: ${res.status}`, status, { detail: t.slice(0, 500) });
    }
    const meta = await res.json();
    if (meta.type !== 'file') {
      return errJson('파일이 아닙니다.', 400);
    }
    if (!meta.content || meta.encoding !== 'base64') {
      return errJson('GitHub 응답 형식이 예상과 다릅니다.', 502);
    }
    const bin = atob(meta.content.replace(/\s/g, ''));
    const jsonText = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return new Response(jsonText, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(),
      },
    });
  }

  if (getMatch && request.method === 'DELETE') {
    const fileName = decodeURIComponent(getMatch[1]);
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      return errJson('잘못된 파일 이름입니다.', 400);
    }
    const relPath = `${prefix}/${fileName}`;
    const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;
    const getRes = await ghFetch(env, `${apiPath}?ref=${encodeURIComponent(branch)}`);
    if (!getRes.ok) {
      const t = await getRes.text();
      const status = getRes.status === 404 ? 404 : 502;
      return errJson(`파일 조회 실패: ${getRes.status}`, status, { detail: t.slice(0, 500) });
    }
    const meta = await getRes.json();
    if (!meta.sha) {
      return errJson('GitHub 응답에 sha가 없습니다.', 502);
    }
    const delRes = await ghFetch(env, apiPath, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Delete quote ${fileName}`,
        sha: meta.sha,
        branch,
      }),
    });
    if (!delRes.ok) {
      const t = await delRes.text();
      return errJson(`GitHub 삭제 실패: ${delRes.status}`, 502, { detail: t.slice(0, 500) });
    }
    try {
      await removeQuoteFromDispatchIndex(env, owner, repo, branch, prefix, fileName);
    } catch {
      /* 삭제는 완료됨 */
    }
    return json({ ok: true });
  }

  return text('Not Found', 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error('[eoulrimstudio-upload]', e);
      const msg = e instanceof Error ? e.message : String(e);
      return errJson(`Worker 오류: ${msg}`, 500);
    }
  },
};
