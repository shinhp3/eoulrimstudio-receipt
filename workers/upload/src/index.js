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
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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
      routes: ['GET /quotes', 'GET /quotes/:name.json', 'PUT /quotes/:name.json'],
    });
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
      .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
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
    const relPath = `${prefix}/${fileName}`;
    const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(relPath.split('/'))}`;

    let bodyJson;
    try {
      bodyJson = await request.json();
    } catch {
      return errJson('JSON 본문이 아닙니다.', 400);
    }

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
    return json({ ok: true, path: relPath });
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
