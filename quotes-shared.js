/**
 * 견적 앱 공통: Worker 연동, 서버 payload
 * index.html 에서 app.js 보다 먼저 로드하세요.
 */

const STORAGE_KEY = 'eoulrim-quote-draft-v1';

const CLOUD_API_BASE =
  typeof window !== 'undefined' && window.__EOULRIM_UPLOAD_API__
    ? String(window.__EOULRIM_UPLOAD_API__).replace(/\/+$/, '').trim()
    : '';

function assertCloudApiConfigured() {
  if (!CLOUD_API_BASE) {
    throw new Error(
      'Worker 주소가 비어 있습니다. HTML에서 window.__EOULRIM_UPLOAD_API__를 설정해 주세요.',
    );
  }
}

const SUPPLIER_FIELDS = [
  'bizNo',
  'companyName',
  'ceo',
  'address',
  'bizType',
  'bizItem',
  'contact',
  'phone',
  'bankName',
  'bankAccountNo',
  'vatPercent',
  /** 담당자 옆 표시용 PNG 데이터 URL */
  'contactSignature',
];

function defaultSupplier() {
  return {
    bizNo: '',
    companyName: '',
    ceo: '',
    address: '',
    bizType: '',
    bizItem: '',
    contact: '',
    phone: '',
    bankName: '',
    bankAccountNo: '',
    vatPercent: '10',
    contactSignature: '',
  };
}

/** 미리보기·저장 JSON용 한 줄 표시 */
function formatBankAccountLine(bankName, bankAccountNo) {
  const n = String(bankName ?? '').trim();
  const a = String(bankAccountNo ?? '').trim();
  if (n && a) return `${n} / ${a}`;
  return n || a || '';
}

/** 예전 단일 필드(은행 / 계좌) 분리 */
function splitLegacyBankAccountLine(combined) {
  const s = String(combined ?? '').trim();
  if (!s) return { bankName: '', bankAccountNo: '' };
  const idx = s.indexOf('/');
  if (idx === -1) return { bankName: '', bankAccountNo: s };
  return {
    bankName: s.slice(0, idx).trim(),
    bankAccountNo: s.slice(idx + 1).trim(),
  };
}

/** 브라우저 로컬 날짜 YYYY-MM-DD (발행일 등에 사용) */
function todayIsoDateLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultState() {
  return {
    dispatchNo: '',
    quoteSaveName: '',
    issueDate: todayIsoDateLocal(),
    validityDays: '',
    bankAccount: '',
    notes: '',
    lines: [{ name: '', qty: '', unitPrice: '', vatPercent: '10' }],
  };
}

function supplierEmbeddingFromPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const hasAnyKey = SUPPLIER_FIELDS.some((k) =>
    Object.prototype.hasOwnProperty.call(parsed, k),
  );
  if (!hasAnyKey) return null;
  const o = { ...defaultSupplier() };
  for (const k of SUPPLIER_FIELDS) {
    o[k] = parsed[k] ?? '';
  }
  return o;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function cloudFetch(path, options = {}) {
  const url = `${CLOUD_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
}

async function readWorkerError(res) {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.error === 'string') {
      return j.detail ? `${j.error}\n${j.detail}` : j.error;
    }
  } catch (_) {
    /* plain text */
  }
  return raw || `HTTP ${res.status}`;
}

async function listCloudQuotes() {
  assertCloudApiConfigured();
  const res = await cloudFetch('/quotes');
  if (!res.ok) {
    throw new Error(`${await readWorkerError(res)} (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

async function getCloudQuote(fileName) {
  assertCloudApiConfigured();
  const safe = encodeURIComponent(fileName);
  const res = await cloudFetch(`/quotes/${safe}`);
  if (!res.ok) {
    throw new Error(`${await readWorkerError(res)} (${res.status})`);
  }
  return res.json();
}

async function putCloudQuote(fileName, payload) {
  assertCloudApiConfigured();
  const safe = encodeURIComponent(fileName);
  const res = await cloudFetch(`/quotes/${safe}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`${await readWorkerError(res)} (${res.status})`);
  }
  return res.json();
}

/** Worker가 저장소 전역 기준으로 부여하는 다음 RIM-{연도}-6자리무작위숫자 발송번호 */
async function fetchNextDispatchNo() {
  assertCloudApiConfigured();
  const res = await cloudFetch('/quotes/next-dispatch');
  if (!res.ok) {
    throw new Error(`${await readWorkerError(res)} (${res.status})`);
  }
  const data = await res.json();
  const no = String(data.dispatchNo || '').trim();
  if (!no) throw new Error('발송번호를 받지 못했습니다.');
  return no;
}

async function deleteCloudQuote(fileName) {
  assertCloudApiConfigured();
  const safe = encodeURIComponent(fileName);
  const res = await cloudFetch(`/quotes/${safe}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`${await readWorkerError(res)} (${res.status})`);
  }
  try {
    return await res.json();
  } catch {
    return { ok: true };
  }
}

/** 발송번호·공급자 상호·최소 1개 품목(품명 + 수량 또는 단가) 있으면 완료 */
function isQuoteComplete(state) {
  if (!state || typeof state !== 'object') return false;
  const dispatch = String(state.dispatchNo || '').trim();
  const company = String(state.companyName || '').trim();
  if (!dispatch || !company) return false;
  const lines = Array.isArray(state.lines) ? state.lines : [];
  return lines.some((l) => {
    const nm = String(l.name || '').trim();
    const q = String(l.qty || '').trim();
    const p = String(l.unitPrice || '').trim();
    return nm !== '' && (q !== '' || p !== '');
  });
}

function suggestedQuoteFileName(state) {
  const complete = isQuoteComplete(state);
  let raw = String(state.dispatchNo || '').trim().slice(0, 48);
  if (!raw) raw = complete ? 'quote' : '미작성';
  const safe =
    raw.replace(/[^\w가-힣0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') ||
    (complete ? 'quote' : '미작성');
  const d = new Date().toISOString().slice(0, 10);
  const r = Math.random().toString(36).slice(2, 8);
  return `${safe}_${d}_${r}.json`;
}

function cloudPayloadFromState(state) {
  const now = new Date().toISOString();
  const complete = isQuoteComplete(state);
  return {
    quoteStorageVersion: 3,
    savedAt: now,
    serverSavedDate: now,
    quoteComplete: complete,
    quoteStatusLabel: complete ? '완료' : '미작성',
    quoteSaveName: state.quoteSaveName ?? '',
    dispatchNo: state.dispatchNo ?? '',
    issueDate: state.issueDate ?? '',
    validityDays: state.validityDays ?? '',
    bankName: state.bankName ?? '',
    bankAccountNo: state.bankAccountNo ?? '',
    bankAccount:
      formatBankAccountLine(state.bankName, state.bankAccountNo) ||
      String(state.bankAccount ?? '').trim(),
    notes: state.notes ?? '',
    lines: Array.isArray(state.lines)
      ? state.lines.map((l) => ({
          name: l.name ?? '',
          qty: l.qty ?? '',
          unitPrice: l.unitPrice ?? '',
          vatPercent:
            l.vatPercent != null && String(l.vatPercent).trim() !== ''
              ? String(l.vatPercent).trim()
              : '10',
        }))
      : [],
    bizNo: state.bizNo ?? '',
    companyName: state.companyName ?? '',
    ceo: state.ceo ?? '',
    address: state.address ?? '',
    bizType: state.bizType ?? '',
    bizItem: state.bizItem ?? '',
    contact: state.contact ?? '',
    phone: state.phone ?? '',
    vatPercent:
      state.vatPercent != null && String(state.vatPercent).trim() !== ''
        ? String(state.vatPercent).trim()
        : '10',
    contactSignature: state.contactSignature ?? '',
  };
}

function stateFromCloudPayload(parsed) {
  const base = defaultState();
  if (!parsed || typeof parsed !== 'object') return base;
  const lines =
    Array.isArray(parsed.lines) && parsed.lines.length
      ? parsed.lines.map((l) => ({
          name: l.name ?? '',
          qty: l.qty ?? '',
          unitPrice: l.unitPrice ?? '',
          vatPercent:
            l.vatPercent != null && String(l.vatPercent).trim() !== ''
              ? String(l.vatPercent).trim()
              : '10',
        }))
      : base.lines;
  const supplierRow = SUPPLIER_FIELDS.reduce((acc, k) => {
    acc[k] = parsed[k] ?? '';
    return acc;
  }, {});
  let bankName = String(supplierRow.bankName ?? '').trim();
  let bankAccountNo = String(supplierRow.bankAccountNo ?? '').trim();
  const bankAccount = parsed.bankAccount ?? '';
  if (!bankName && !bankAccountNo && String(bankAccount).trim()) {
    const sp = splitLegacyBankAccountLine(bankAccount);
    bankName = sp.bankName;
    bankAccountNo = sp.bankAccountNo;
  }
  return {
    ...base,
    quoteSaveName: parsed.quoteSaveName ?? '',
    dispatchNo: parsed.dispatchNo ?? '',
    issueDate: parsed.issueDate ?? base.issueDate,
    validityDays: parsed.validityDays ?? '',
    bankAccount,
    notes: parsed.notes ?? '',
    lines,
    ...supplierRow,
    bankName,
    bankAccountNo,
  };
}

function fmtSavedAtKo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function fmtIssueDateKo(isoYmd) {
  if (!isoYmd) return '—';
  const [y, m, day] = isoYmd.split('-');
  if (!y || !m || !day) return isoYmd;
  return `${y}.${m}.${day}`;
}

/** 서버 JSON 또는 화면 상태로 표시용 상태 문자열 */
function quoteStatusLabelFromPayload(data) {
  if (!data || typeof data !== 'object') return '미작성';
  if (typeof data.quoteStatusLabel === 'string' && data.quoteStatusLabel.trim())
    return data.quoteStatusLabel.trim();
  if (data.quoteComplete === true) return '완료';
  if (data.quoteComplete === false) return '미작성';
  return isQuoteComplete(stateFromCloudPayload(data)) ? '완료' : '미작성';
}
