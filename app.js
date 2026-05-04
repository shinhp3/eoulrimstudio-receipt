/* 전역: html2canvas, window.jspdf.jsPDF (UMD) — quotes-shared.js 를 먼저 로드 */

const SUPPLIER_KEY = 'eoulrim-supplier-defaults-v1';
const TABLE_BODY_ROWS = 14;

const LINE_REMOVE_TRASH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

const DASH_EDIT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5z"/></svg>';

function lineRemoveButtonHtml() {
  return `<button type="button" class="btn btn-ghost btn-icon btn-remove-line" title="행 삭제" aria-label="행 삭제">${LINE_REMOVE_TRASH_SVG}</button>`;
}

/** 행이 2줄 이상일 때만 휴지통 표시(행 추가 후부터) */
function syncLineRemoveButtons(root) {
  const tbody = root.querySelector('#lines-body');
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr[data-line-row]')];
  const show = rows.length > 1;
  rows.forEach((tr) => {
    let td = tr.querySelector('td.line-remove-cell');
    if (!td) {
      td = tr.querySelector('td:last-child');
      if (!td) return;
      td.classList.add('line-remove-cell');
    }
    if (show) {
      if (!td.querySelector('.btn-remove-line')) td.innerHTML = lineRemoveButtonHtml();
    } else {
      td.innerHTML = '';
    }
  });
}

function getJsPDF() {
  return window.jspdf && window.jspdf.jsPDF;
}

function loadSupplierDefaults() {
  try {
    const raw = localStorage.getItem(SUPPLIER_KEY);
    if (!raw) return defaultSupplier();
    return { ...defaultSupplier(), ...JSON.parse(raw) };
  } catch {
    return defaultSupplier();
  }
}

function saveSupplierDefaults(s) {
  localStorage.setItem(SUPPLIER_KEY, JSON.stringify({ ...defaultSupplier(), ...s }));
}

/** 견적 초안에 예전 형식으로 공급자가 들어 있으면 한 번만 기본값 저장소로 옮김 */
function migrateDraftSupplierIfNeeded(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const hasOld =
    parsed.bizNo ||
    parsed.companyName ||
    parsed.ceo ||
    parsed.address ||
    parsed.bizType ||
    parsed.bizItem ||
    parsed.contact ||
    parsed.phone ||
    parsed.bankAccount;
  const existing = loadSupplierDefaults();
  const supplierEmpty = !Object.values(existing).some((v) => String(v || '').trim());
  if (hasOld && supplierEmpty) {
    let bankName = parsed.bankName ?? '';
    let bankAccountNo = parsed.bankAccountNo ?? '';
    if (!String(bankName).trim() && !String(bankAccountNo).trim() && String(parsed.bankAccount || '').trim()) {
      const sp = splitLegacyBankAccountLine(parsed.bankAccount);
      bankName = sp.bankName;
      bankAccountNo = sp.bankAccountNo;
    }
    let vatPercent = String(parsed.vatPercent ?? '').trim();
    if (!vatPercent && Array.isArray(parsed.lines) && parsed.lines.length) {
      const fp = normalizeVatPercent(parsed.lines[0].vatPercent);
      if (parsed.lines.every((l) => normalizeVatPercent(l.vatPercent) === fp)) vatPercent = String(fp);
    }
    if (!vatPercent) vatPercent = '10';
    saveSupplierDefaults({
      bizNo: parsed.bizNo ?? '',
      companyName: parsed.companyName ?? '',
      ceo: parsed.ceo ?? '',
      address: parsed.address ?? '',
      bizType: parsed.bizType ?? '',
      bizItem: parsed.bizItem ?? '',
      contact: parsed.contact ?? '',
      phone: parsed.phone ?? '',
      bankName,
      bankAccountNo,
      vatPercent,
    });
  }
}

function parseNum(v) {
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

function fmtDateYMD(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${y}년${m}월${d}일`;
}

function bankAccountDisplayFromState(state) {
  const line = formatBankAccountLine(state.bankName, state.bankAccountNo);
  if (line) return line;
  return String(state.bankAccount || '').trim();
}

function safeContactSignatureDataUrl(raw) {
  const u = String(raw ?? '').trim().replace(/\s+/g, '');
  if (
    u.startsWith('data:image/png;base64,') ||
    u.startsWith('data:image/jpeg;base64,') ||
    u.startsWith('data:image/jpg;base64,')
  ) {
    return u.replace(/"/g, '');
  }
  return '';
}

/** 미리보기 공급자 칸 — 담당자 이름 + 서명 이미지 */
function supplierContactCellHtml(state) {
  const name = escapeHtml(state.contact || '');
  const url = safeContactSignatureDataUrl(state.contactSignature);
  if (!url) return name;
  const img =
    '<span class="supplier-sign-wrap"><img class="supplier-sign-img" src="' +
    url +
    '" alt="" role="presentation" /></span>';
  return name ? `${name} ${img}` : img;
}

function isSignatureCanvasBlank(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width < 2 || canvas.height < 2) return true;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 48) continue;
    if (r < 248 && g < 248 && b < 248) return false;
    if (r + g + b < 740) return false;
  }
  return true;
}

function syncSupplierSignatureToHidden(root) {
  const modal = root.querySelector('#supplier-modal');
  const canvas = modal?.querySelector('#modal-signature-canvas');
  const hid = modal?.querySelector('[data-supplier-f="contactSignature"]');
  if (!canvas || !hid || !canvas.getContext('2d')) return;
  if (isSignatureCanvasBlank(canvas)) hid.value = '';
  else hid.value = canvas.toDataURL('image/png');
}

function bindSupplierSignaturePad(root) {
  const modal = root.querySelector('#supplier-modal');
  const canvas = modal?.querySelector('#modal-signature-canvas');
  const hid = modal?.querySelector('[data-supplier-f="contactSignature"]');
  const clearBtn = modal?.querySelector('#modal-signature-clear');
  if (!canvas || !hid) return;

  const ctx = canvas.getContext('2d');
  const CSS_W = 320;
  const CSS_H = 120;

  function setupCtx() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${CSS_W}px`;
    canvas.style.height = `${CSS_H}px`;
    canvas.style.touchAction = 'none';
    canvas.width = Math.round(CSS_W * dpr);
    canvas.height = Math.round(CSS_H * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CSS_W, CSS_H);
  }

  function redrawFromHidden() {
    setupCtx();
    const url = String(hid.value || '').trim().replace(/\s+/g, '');
    if (!safeContactSignatureDataUrl(url)) return;
    const img = new Image();
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, CSS_W, CSS_H);
      } catch (_) {
        setupCtx();
      }
    };
    img.onerror = () => setupCtx();
    img.src = url;
  }

  setupCtx();

  let drawing = false;
  let lastX = 0;
  let lastY = 0;

  function pos(ev) {
    const r = canvas.getBoundingClientRect();
    const cx = ev.clientX ?? ev.touches?.[0]?.clientX ?? 0;
    const cy = ev.clientY ?? ev.touches?.[0]?.clientY ?? 0;
    return { x: cx - r.left, y: cy - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    drawing = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    const { x, y } = pos(e);
    lastX = x;
    lastY = y;
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const { x, y } = pos(e);
    ctx.strokeStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x;
    lastY = y;
  });

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;
    try {
      if (e.pointerId != null) canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  }

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  clearBtn?.addEventListener('click', () => {
    hid.value = '';
    setupCtx();
  });

  root._supplierSignatureUi = { redrawFromHidden };
  redrawFromHidden();
}

function normalizeVatPercent(raw) {
  if (raw == null || String(raw).trim() === '') return 10;
  const r = parseNum(raw);
  if (!Number.isFinite(r) || r < 0) return 10;
  return r;
}

/** 품목표 헤더용 — 채워진 행의 부가세율이 모두 같으면 (10%) 등, 없거나 다르면 (%) */
function vatColumnTitleSuffixHtml(lines, spanClassName) {
  const keys = [];
  for (const ln of Array.isArray(lines) ? lines : []) {
    const { supply } = lineComputed(ln.qty, ln.unitPrice, ln.vatPercent);
    const hasContent =
      String(ln.name || '').trim() !== '' ||
      supply !== 0 ||
      parseNum(ln.qty) !== 0 ||
      parseNum(ln.unitPrice) !== 0;
    if (!hasContent) continue;
    keys.push(normalizeVatPercent(ln.vatPercent));
  }
  const pctInner =
    keys.length && keys.every((k) => k === keys[0]) ? `${keys[0]}%` : '%';
  return `<span class="${spanClassName}">(${pctInner})</span>`;
}

/** 공급가·부가세·금액 (부가세율 % 는 행마다) */
function lineComputed(qtyRaw, unitRaw, vatPctRaw) {
  const qty = parseNum(qtyRaw);
  const unit = parseNum(unitRaw);
  const pct = normalizeVatPercent(vatPctRaw);
  const supply = qty * unit;
  const vat = Math.round(supply * (pct / 100));
  const amount = supply + vat;
  return { supply, vat, amount, vatPct: pct };
}

/** 금액·수량·부가세율로 단가(공급가 단가) 역산 */
function deriveUnitPriceFromAmount(qtyRaw, vatPctRaw, amountRaw) {
  const qty = parseNum(qtyRaw);
  const pct = normalizeVatPercent(vatPctRaw);
  const A = Math.round(parseNum(amountRaw));
  if (qty <= 0 || A <= 0) return null;
  const supply = Math.round(A / (1 + pct / 100));
  const unit = supply / qty;
  if (!Number.isFinite(unit) || unit < 0) return null;
  return Math.round(unit);
}

function quoteDisplayNameFromModalInput(raw) {
  return String(raw || '')
    .trim()
    .replace(/\.json$/i, '')
    .trim();
}

function fileNameFromSaveModalInput(raw, fallbackFileName) {
  const base = quoteDisplayNameFromModalInput(raw);
  if (!base) return fallbackFileName;
  const safe =
    base.replace(/[^\w가-힣0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'quote';
  return `${safe}.json`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    migrateDraftSupplierIfNeeded(parsed);
    const base = defaultState();
    let bankName = parsed.bankName ?? '';
    let bankAccountNo = parsed.bankAccountNo ?? '';
    let bankAccount = parsed.bankAccount ?? '';
    if (!String(bankName).trim() && !String(bankAccountNo).trim() && String(bankAccount).trim()) {
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
      bankName,
      bankAccountNo,
      bankAccount,
      notes: parsed.notes ?? '',
      lines:
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
          : base.lines,
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  const slim = {
    quoteSaveName: state.quoteSaveName,
    dispatchNo: state.dispatchNo,
    issueDate: state.issueDate,
    validityDays: state.validityDays,
    bankName: state.bankName,
    bankAccountNo: state.bankAccountNo,
    bankAccount:
      formatBankAccountLine(state.bankName, state.bankAccountNo) ||
      String(state.bankAccount || '').trim(),
    notes: state.notes,
    lines: state.lines,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
}

/** 작성 폼이 있으면 로컬 초안(STORAGE_KEY)에 저장 — 탭 전환·페이지 이탈 시 */
function persistDraftFromDom() {
  const root = document.getElementById('app');
  if (!root?.querySelector('#lines-body')) return;
  try {
    saveState(collectStateFromDom(root));
  } catch {
    /* DOM 미준비 등은 무시 */
  }
}

let dashboardQuotesInvalidateNext = true;
let dashboardFetchGen = 0;
let dashboardQuotesMetasCache = null;
let dashboardDispatchFilterRaw = '';
/** issue-desc | issue-asc | saved-desc | saved-asc */
let dashboardSortOrder = 'issue-desc';

const SESSION_NEW_QUOTE_KEY = 'eoulrim-dash-new-quote';
/** 방금 저장한 항목 옆 NEW 표시 유지 시간(ms) */
const DASH_NEW_BADGE_MS = 5 * 60 * 1000;

function markDashboardJustSaved(fileName) {
  try {
    sessionStorage.setItem(
      SESSION_NEW_QUOTE_KEY,
      JSON.stringify({ fileName, ts: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

function dashNewBadgeHtml(fileName) {
  try {
    const raw = sessionStorage.getItem(SESSION_NEW_QUOTE_KEY);
    if (!raw) return '';
    const o = JSON.parse(raw);
    if (!o || o.fileName !== fileName || typeof o.ts !== 'number') return '';
    if (Date.now() - o.ts > DASH_NEW_BADGE_MS) return '';
    return '<span class="dashboard-quote-new-badge">NEW</span>';
  } catch {
    return '';
  }
}

/** 서버 목록이 바뀌었을 가능성 — 대시보드 다음 진입 시 다시 불러옴 */
function markDashboardQuotesStale() {
  dashboardQuotesInvalidateNext = true;
}

function dashboardWrapHasStableListUi(wrap) {
  return !!(wrap?.querySelector('table.dashboard-table') || wrap.querySelector('p.dashboard-empty'));
}

/** 동시에 여러 견적 본문을 받지 않도록 제한 — 목록이 많을 때 메모리·동시 연결 부담 완화 */
async function mapPool(items, limit, mapper) {
  if (!items.length) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return out;
}

function mergeSupplierIntoState(base, root) {
  const embed = root && root._embeddedSupplier;
  const s = embed ? { ...defaultSupplier(), ...embed } : loadSupplierDefaults();
  const bnB = String(base.bankName ?? '').trim();
  const baB = String(base.bankAccountNo ?? '').trim();
  const hasQuoteBank = bnB !== '' || baB !== '';
  let vr = String(s.vatPercent ?? '').trim();
  if (!vr && Array.isArray(base.lines) && base.lines.length) {
    const fp = normalizeVatPercent(base.lines[0].vatPercent);
    if (base.lines.every((l) => normalizeVatPercent(l.vatPercent) === fp)) vr = String(fp);
  }
  const vatPercent = vr || '10';
  const lines = Array.isArray(base.lines)
    ? base.lines.map((l) => ({ ...l, vatPercent }))
    : base.lines;
  return {
    ...base,
    lines,
    bizNo: s.bizNo,
    companyName: s.companyName,
    ceo: s.ceo,
    address: s.address,
    bizType: s.bizType,
    bizItem: s.bizItem,
    contact: s.contact,
    phone: s.phone,
    bankName: hasQuoteBank ? base.bankName : s.bankName,
    bankAccountNo: hasQuoteBank ? base.bankAccountNo : s.bankAccountNo,
    vatPercent,
    contactSignature: s.contactSignature ?? '',
  };
}

function collectStateFromDom(root) {
  const q = (sel) => root.querySelector(sel);
  const lines = [];
  const vatGlobal = supplierVatPercentFromUi(root);
  root.querySelectorAll('[data-line-row]').forEach((row) => {
    lines.push({
      name: row.querySelector('[data-f="name"]')?.value ?? '',
      qty: row.querySelector('[data-f="qty"]')?.value ?? '',
      unitPrice: row.querySelector('[data-f="unitPrice"]')?.value ?? '',
      vatPercent: vatGlobal,
    });
  });
  const quote = {
    quoteSaveName: q('[data-field="quoteSaveName"]')?.value ?? '',
    dispatchNo: q('[data-field="dispatchNo"]')?.value ?? '',
    issueDate: q('[data-field="issueDate"]')?.value ?? '',
    validityDays: q('[data-field="validityDays"]')?.value ?? '',
    bankName: q('[data-field="bankName"]')?.value ?? '',
    bankAccountNo: q('[data-field="bankAccountNo"]')?.value ?? '',
    notes: q('[data-field="notes"]')?.value ?? '',
    lines,
  };
  const merged = mergeSupplierIntoState(quote, root);
  return {
    ...merged,
    bankAccount:
      formatBankAccountLine(merged.bankName, merged.bankAccountNo) ||
      String(merged.bankAccount || '').trim(),
  };
}

const QUOTE_SUPPLIER_COMP_KEYS = [
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
  'contactSignature',
];

function quoteDraftComparable(root) {
  const s = collectStateFromDom(root);
  const supplier = {};
  for (const k of QUOTE_SUPPLIER_COMP_KEYS) {
    supplier[k] = String(s[k] ?? '').trim();
  }
  return {
    quoteSaveName: String(s.quoteSaveName || '').trim(),
    dispatchNo: String(s.dispatchNo || '').trim(),
    issueDate: String(s.issueDate || '').trim(),
    validityDays: String(s.validityDays || '').trim(),
    bankAccount: String(s.bankAccount || '').trim(),
    notes: String(s.notes || '').trim(),
    lines: (s.lines || []).map((l) => ({
      name: String(l.name || '').trim(),
      qty: String(l.qty || '').trim(),
      unitPrice: String(l.unitPrice || '').trim(),
      vatPercent: String(l.vatPercent ?? '10').trim(),
    })),
    supplier,
  };
}

function captureQuoteDirtyBaseline(root) {
  root._quoteDirtyBaselineJson = JSON.stringify(quoteDraftComparable(root));
}

function updateSaveButtonEnabled(root) {
  const btn = root.querySelector('#btn-save');
  if (!btn) return;
  if (root._quoteDirtyBaselineJson == null) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    return;
  }
  const dirty = JSON.stringify(quoteDraftComparable(root)) !== root._quoteDirtyBaselineJson;
  btn.disabled = !dirty;
  btn.setAttribute('aria-disabled', dirty ? 'false' : 'true');
}

function isQuoteDraftDirty(root) {
  if (root._quoteDirtyBaselineJson == null) return false;
  return JSON.stringify(quoteDraftComparable(root)) !== root._quoteDirtyBaselineJson;
}

/** 미리보기 패널 안에서 견적서 전체가 보이도록 비율 축소(내부 스크롤 없음) */
function fitQuotePreview(root) {
  const stage = root.querySelector('#quote-fit-stage');
  const slot = root.querySelector('#quote-fit-slot');
  const wrap = root.querySelector('#quote-fit-scale-wrap');
  const doc = root.querySelector('#quote-print-root');
  if (!stage || !slot || !wrap || !doc) return;

  wrap.style.transform = 'none';
  wrap.style.width = '';
  wrap.style.height = '';
  slot.style.width = '';
  slot.style.height = '';

  const pad = 4;
  const sw = Math.max(40, stage.clientWidth - pad * 2);
  const sh = Math.max(40, stage.clientHeight - pad * 2);

  const nw = Math.max(1, doc.scrollWidth, doc.offsetWidth);
  const nh = Math.max(1, doc.scrollHeight, doc.offsetHeight);

  if (stage.clientWidth < 8 || stage.clientHeight < 8) return;

  const scale = Math.min(sw / nw, sh / nh, 1);

  wrap.style.width = `${nw}px`;
  wrap.style.height = `${nh}px`;
  wrap.style.transform = `scale(${scale})`;
  wrap.style.transformOrigin = 'top left';

  slot.style.width = `${Math.ceil(nw * scale)}px`;
  slot.style.height = `${Math.ceil(nh * scale)}px`;
  slot.style.overflow = 'hidden';
  slot.style.marginLeft = 'auto';
  slot.style.marginRight = 'auto';
}

/** 품목 칸 입력 중에는 미리보기 스케일·줌 리셋을 줄여 깜빡임 완화 */
function isTypingPreviewLineItem(root) {
  const ae = document.activeElement;
  return (
    ae &&
    root.contains(ae) &&
    ae.closest('[data-line-row]') &&
    ae.matches?.('input[data-f]')
  );
}

function scheduleFitQuotePreview(root) {
  if (!root) return;
  clearTimeout(root._fitPreviewDebounce);
  root._fitPreviewDebounce = setTimeout(() => {
    root._fitPreviewDebounce = null;
    fitQuotePreview(root);
  }, 200);
}

function unwrapQuoteFitForCapture(root) {
  const slot = root.querySelector('#quote-fit-slot');
  const wrap = root.querySelector('#quote-fit-scale-wrap');
  if (!slot || !wrap) {
    return () => fitQuotePreview(root);
  }
  const bkSlot = slot.style.cssText;
  const bkWrap = wrap.style.cssText;
  wrap.style.transform = 'none';
  wrap.style.width = '';
  wrap.style.height = '';
  slot.style.width = '';
  slot.style.height = '';
  slot.style.overflow = 'visible';
  return () => {
    slot.style.cssText = bkSlot;
    wrap.style.cssText = bkWrap;
    fitQuotePreview(root);
  };
}

function clearPreviewFocus(root) {
  root.querySelectorAll('#quote-print-root .is-preview-focus').forEach((el) => {
    el.classList.remove('is-preview-focus');
  });
}

function clearPreviewItemZoom(root) {
  const doc = root.querySelector('#quote-print-root');
  if (!doc) return;
  doc.classList.remove('is-preview-item-zoom');
  doc.classList.remove('preview-zoom-instant');
  doc.style.transform = '';
  doc.style.transformOrigin = '';
  root._previewZoomKey = null;
  root._previewZoomShiftX = null;
  root._previewZoomOriginYpct = null;
}

/** 미리보기 내용만 갱신될 때 확대 행렬만 제거(같은 칸 입력 시 깜빡임 방지용 키는 유지) */
function stripPreviewZoomTransform(root) {
  const doc = root.querySelector('#quote-print-root');
  if (!doc) return;
  doc.classList.remove('is-preview-item-zoom');
  doc.classList.remove('preview-zoom-instant');
  doc.style.transform = '';
  doc.style.transformOrigin = '';
  root._previewZoomShiftX = null;
  root._previewZoomOriginYpct = null;
}

/** 품목 입력 중 미리보기 확대 — 세로는 해당 칸, 가로는 슬롯(미리보기) 중앙에 맞춤 */
function applyPreviewItemZoom(root, tdEl, rowIdx, colKey) {
  const doc = root.querySelector('#quote-print-root');
  const slot = root.querySelector('#quote-fit-slot');
  if (!doc || !tdEl || !slot) return;

  const zoomKey = `${rowIdx}:${colKey}`;
  const sameCell = root._previewZoomKey === zoomKey;
  root._previewZoomKey = zoomKey;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      /* 같은 칸에서 글자만 바뀔 때는 transform 초기화 생략 → 확대 유지·깜빡임 감소 */
      if (!sameCell) {
        doc.style.transform = 'none';
        doc.style.transformOrigin = '';
        void doc.offsetHeight;
      }

      const dr = doc.getBoundingClientRect();
      const cr = tdEl.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      if (dr.width < 4 || dr.height < 4) return;

      const s = 1.32;
      const slotCx = sr.left + sr.width / 2;
      const cellCx = cr.left + cr.width / 2;
      /* 같은 칸 입력 중 열 너비가 바뀌면 cellCx가 출렁여 좌우로 흔들림 → 최초 값 고정 */
      let shiftX;
      let oyPct;
      if (
        sameCell &&
        root._previewZoomShiftX != null &&
        Number.isFinite(root._previewZoomShiftX) &&
        root._previewZoomOriginYpct != null &&
        Number.isFinite(root._previewZoomOriginYpct)
      ) {
        shiftX = root._previewZoomShiftX;
        oyPct = root._previewZoomOriginYpct;
      } else {
        shiftX = slotCx - cellCx;
        oyPct = ((cr.top + cr.height / 2 - dr.top) / dr.height) * 100;
        oyPct = Math.max(4, Math.min(96, oyPct));
        root._previewZoomShiftX = shiftX;
        root._previewZoomOriginYpct = oyPct;
      }

      doc.style.transformOrigin = `50% ${oyPct}%`;
      if (sameCell) doc.classList.add('preview-zoom-instant');
      doc.style.transform = `translate(${shiftX}px, 0) scale(${s})`;
      doc.classList.add('is-preview-item-zoom');
      if (sameCell) {
        requestAnimationFrame(() => doc.classList.remove('preview-zoom-instant'));
      }
    });
  });
}

function syncPreviewFocus(root, target) {
  clearPreviewFocus(root);

  if (!target || !target.closest || target.closest('#supplier-modal')) {
    clearPreviewItemZoom(root);
    return;
  }

  const preview = root.querySelector('#quote-print-root');
  if (!preview) return;

  const itemCol = target.getAttribute?.('data-preview-col');
  if (itemCol && target.closest('[data-line-row]')) {
    const tr = target.closest('[data-line-row]');
    const tbody = root.querySelector('#lines-body');
    if (!tr || !tbody) return;
    const idx = [...tbody.querySelectorAll('[data-line-row]')].indexOf(tr);
    const tdEl = preview.querySelector(`tbody tr[data-preview-row="${idx}"] td.${itemCol}`);
    tdEl?.classList.add('is-preview-focus');
    applyPreviewItemZoom(root, tdEl, idx, itemCol);
    return;
  }

  clearPreviewItemZoom(root);

  const region = target.getAttribute?.('data-sync-highlight');
  if (region) {
    preview.querySelector(`[data-preview-region="${region}"]`)?.classList.add('is-preview-focus');
  }
}

function renderQuotePreview(el, state) {
  const rows = [];
  let sumSupply = 0;
  let sumVat = 0;
  let sumAmt = 0;

  state.lines.forEach((ln) => {
    const { supply, vat, amount } = lineComputed(ln.qty, ln.unitPrice, ln.vatPercent);
    const hasContent =
      String(ln.name).trim() !== '' ||
      supply !== 0 ||
      parseNum(ln.qty) !== 0 ||
      parseNum(ln.unitPrice) !== 0;
    if (hasContent) {
      sumSupply += supply;
      sumVat += vat;
      sumAmt += amount;
    }
    rows.push({ ...ln, supply, vat, amount, hasContent });
  });

  const padded = [];
  for (let i = 0; i < TABLE_BODY_ROWS; i++) {
    const r = rows[i];
    if (r) {
      padded.push(r);
    } else {
      padded.push({
        name: '',
        qty: '',
        unitPrice: '',
        vatPercent: '10',
        supply: 0,
        vat: 0,
        amount: 0,
        hasContent: false,
      });
    }
  }

  const tbody = padded
    .map((r, idx) => {
      const name = escapeHtml(r.name);
      const qtyShow = r.hasContent && String(r.qty).trim() !== '' ? String(r.qty).trim() : '';
      const unitNum = parseNum(r.unitPrice);
      const unitDisp =
        r.hasContent && unitNum !== 0 ? fmtMoney(Math.round(unitNum)) : '';
      const supplyDisp = r.hasContent && r.supply !== 0 ? fmtMoney(r.supply) : '';
      const vatDisp = r.hasContent && r.vat !== 0 ? fmtMoney(r.vat) : '';
      const amtDisp = r.hasContent && r.amount !== 0 ? fmtMoney(r.amount) : '';
      return `<tr data-preview-row="${idx}">
        <td class="col-name">${name}</td>
        <td class="col-qty">${qtyShow ? escapeHtml(qtyShow) : ''}</td>
        <td class="col-price">${unitDisp}</td>
        <td class="col-supply">${supplyDisp}</td>
        <td class="col-vat">${vatDisp}</td>
        <td class="col-amt">${amtDisp}</td>
      </tr>`;
    })
    .join('');

  const validity = escapeHtml(state.validityDays || '');
  const bank = escapeHtml(bankAccountDisplayFromState(state));
  const notes = escapeHtml(state.notes || '');

  el.innerHTML = `
    <div class="quote-title" data-preview-region="preview-title">견 적 서</div>
    <div class="quote-header-row">
      <div class="header-left-box" data-preview-region="preview-header-left">
        <div class="line"><span class="label">발송번호</span><span>${escapeHtml(state.dispatchNo || '')}</span></div>
        <div class="header-msg">아래와 같이 견적서를 발송합니다.</div>
        <div class="line"><span class="label">일자</span><span>${escapeHtml(fmtDateYMD(state.issueDate))}</span></div>
      </div>
      <div class="supplier-wrap" data-preview-region="preview-supplier">
        <div class="supplier-side">공 급 자</div>
        <div class="supplier-grid">
          <div class="sg-label">사업자번호</div><div>${escapeHtml(state.bizNo || '')}</div>
          <div class="sg-label">상 호</div><div>${escapeHtml(state.companyName || '')}</div>
          <div class="sg-label">대 표 자</div><div>${escapeHtml(state.ceo || '')}</div>
          <div class="sg-label">소 재 지</div><div>${escapeHtml(state.address || '')}</div>
          <div class="sg-label">업 태</div><div>${escapeHtml(state.bizType || '')}</div>
          <div class="sg-label">종 목</div><div>${escapeHtml(state.bizItem || '')}</div>
          <div class="sg-label">담 당 자</div><div class="supplier-contact-cell">${supplierContactCellHtml(state)}</div>
          <div class="sg-label">전화번호</div><div>${escapeHtml(state.phone || '')}</div>
        </div>
      </div>
    </div>
    <div class="items-table-wrap" data-preview-region="preview-items">
      <table class="items-table" aria-label="견적 품목">
        <thead>
          <tr>
            <th class="col-name">품명</th>
            <th class="col-qty">수량</th>
            <th class="col-price">단가</th>
            <th class="col-supply">공급가액</th>
            <th class="col-vat">부가세 ${vatColumnTitleSuffixHtml(state.lines, 'th-inline-muted')}</th>
            <th class="col-amt">금액</th>
          </tr>
        </thead>
        <tbody>
          ${tbody}
          <tr class="summary-row" data-preview-region="preview-summary">
            <td class="sum-label" colspan="3">합계금액</td>
            <td class="col-supply">${fmtMoney(sumSupply)}</td>
            <td class="col-vat">${fmtMoney(sumVat)}</td>
            <td class="col-amt">${fmtMoney(sumAmt)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="quote-footer" data-preview-region="preview-footer">
      <div class="foot-line">유효기간 : 견적 유효기간은 발행 후 ${validity ? `[ ${validity} ]` : '[　　　]'} 일</div>
      <div class="foot-line">송금계좌 : ${bank}</div>
      <div class="foot-line">기타 : ${notes}</div>
    </div>
  `;
}

function supplierModalMarkup() {
  const s = loadSupplierDefaults();
  return `
    <div class="modal-backdrop is-hidden" id="supplier-modal" aria-hidden="true">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="supplier-modal-title">
        <div class="modal-head">
          <h3 id="supplier-modal-title">공급자 정보</h3>
          <button type="button" class="btn btn-icon-plain" id="supplier-modal-x" aria-label="닫기">×</button>
        </div>
        <p class="modal-desc">기본 공급자로 저장됩니다.</p>
        <div class="grid-form modal-grid">
          <div class="field"><label for="modal-bizNo">사업자번호</label><input id="modal-bizNo" data-supplier-f="bizNo" type="text" value="${escapeHtml(s.bizNo)}" /></div>
          <div class="field"><label for="modal-companyName">상호</label><input id="modal-companyName" data-supplier-f="companyName" type="text" value="${escapeHtml(s.companyName)}" /></div>
          <div class="field"><label for="modal-ceo">대표자</label><input id="modal-ceo" data-supplier-f="ceo" type="text" value="${escapeHtml(s.ceo)}" /></div>
          <div class="field"><label for="modal-contact">담당자</label><input id="modal-contact" data-supplier-f="contact" type="text" value="${escapeHtml(s.contact)}" /></div>
          <div class="field field-full field-signature-block">
            <label for="modal-signature-canvas">담당자 서명</label>
            <p class="signature-hint">아래 판에 마우스나 손가락으로 서명하세요.</p>
            <div class="signature-pad-wrap">
              <canvas id="modal-signature-canvas" aria-label="서명 판"></canvas>
            </div>
            <input type="hidden" id="modal-contactSignature" data-supplier-f="contactSignature" value="" />
            <button type="button" class="btn btn-secondary btn-signature-clear" id="modal-signature-clear">서명 지우기</button>
          </div>
          <div class="field"><label for="modal-phone">전화번호</label><input id="modal-phone" data-supplier-f="phone" type="text" value="${escapeHtml(s.phone)}" /></div>
          <div class="field"><label for="modal-bankName">은행명</label><input id="modal-bankName" data-supplier-f="bankName" type="text" value="${escapeHtml(s.bankName)}" placeholder="예: 국민은행" /></div>
          <div class="field"><label for="modal-bankAccountNo">계좌번호</label><input id="modal-bankAccountNo" data-supplier-f="bankAccountNo" type="text" value="${escapeHtml(s.bankAccountNo)}" placeholder="숫자만 또는 하이픈 포함" /></div>
          <div class="field"><label for="modal-vatPercent">부가세율 <span class="label-muted">(%)</span></label><input id="modal-vatPercent" data-supplier-f="vatPercent" type="text" inputmode="decimal" value="${escapeHtml(String(s.vatPercent != null && String(s.vatPercent).trim() !== '' ? s.vatPercent : '10'))}" placeholder="10" /></div>
          <div class="field"><label for="modal-bizType">업태</label><input id="modal-bizType" data-supplier-f="bizType" type="text" value="${escapeHtml(s.bizType)}" /></div>
          <div class="field"><label for="modal-bizItem">종목</label><input id="modal-bizItem" data-supplier-f="bizItem" type="text" value="${escapeHtml(s.bizItem)}" /></div>
          <div class="field field-full"><label for="modal-address">소재지</label><textarea id="modal-address" data-supplier-f="address">${escapeHtml(s.address)}</textarea></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="supplier-close">닫기</button>
          <button type="button" class="btn btn-primary" id="supplier-save">저장</button>
        </div>
      </div>
    </div>
  `;
}

function saveQuoteModalMarkup() {
  return `
    <div class="modal-backdrop is-hidden" id="save-quote-modal" aria-hidden="true">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="save-quote-modal-title">
        <div class="modal-head">
          <h3 id="save-quote-modal-title">견적 저장</h3>
          <button type="button" class="btn btn-icon-plain" id="save-quote-modal-x" aria-label="닫기">×</button>
        </div>
        <p class="modal-desc">저장 이름(.json 생략 가능)</p>
        <div class="field">
          <label for="save-quote-modal-input">저장 이름</label>
          <input type="text" id="save-quote-modal-input" autocomplete="off" placeholder="예: HK사업부_발주_20260504" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="save-quote-cancel">취소</button>
          <button type="button" class="btn btn-primary" id="save-quote-confirm">서버에 저장</button>
        </div>
      </div>
    </div>
  `;
}

function openSaveQuoteModal(root) {
  const modal = root.querySelector('#save-quote-modal');
  const inp = root.querySelector('#save-quote-modal-input');
  const hid = root.querySelector('[data-field="quoteSaveName"]');
  if (!modal || !inp) return;
  const fromState = (hid?.value || '').trim();
  const fromFile = root._cloudQuoteFileName
    ? root._cloudQuoteFileName.replace(/\.json$/i, '')
    : '';
  const dispatch = root.querySelector('[data-field="dispatchNo"]')?.value?.trim() ?? '';
  inp.value = fromState || fromFile || dispatch || '';
  modal.classList.remove('is-hidden');
  modal.setAttribute('aria-hidden', 'false');
  inp.focus();
  inp.select?.();
}

function closeSaveQuoteModal(root) {
  const modal = root.querySelector('#save-quote-modal');
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function newQuoteConfirmModalMarkup() {
  return `
    <div class="modal-backdrop is-hidden" id="new-quote-confirm-modal" aria-hidden="true">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="new-quote-confirm-title">
        <div class="modal-head">
          <h3 id="new-quote-confirm-title">새로 작성</h3>
          <button type="button" class="btn btn-icon-plain" id="new-quote-confirm-x" aria-label="닫기">×</button>
        </div>
        <p class="modal-desc">현재 입력을 초기화합니다.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="new-quote-confirm-cancel">취소</button>
          <button type="button" class="btn btn-primary" id="new-quote-confirm-ok">새로 작성</button>
        </div>
      </div>
    </div>`;
}

function saveSuccessModalMarkup() {
  return `
    <div class="modal-backdrop is-hidden" id="save-success-modal" aria-hidden="true">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="save-success-title">
        <div class="modal-head">
          <h3 id="save-success-title">저장 완료</h3>
          <button type="button" class="btn btn-icon-plain" id="save-success-x" aria-label="닫기">×</button>
        </div>
        <p class="modal-desc" id="save-success-msg"></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" id="save-success-ok">확인</button>
        </div>
      </div>
    </div>`;
}

function openNewQuoteConfirmModal(root) {
  const modal = root.querySelector('#new-quote-confirm-modal');
  if (!modal) return;
  modal.classList.remove('is-hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeNewQuoteConfirmModal(root) {
  const modal = root.querySelector('#new-quote-confirm-modal');
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function openSaveSuccessModal(root, messageText) {
  const modal = root.querySelector('#save-success-modal');
  const msg = root.querySelector('#save-success-msg');
  if (!modal || !msg) return;
  msg.textContent = messageText;
  modal.classList.remove('is-hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeSaveSuccessModal(root) {
  const modal = root.querySelector('#save-success-modal');
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function goDashboardAfterSaveFromModal(root) {
  closeSaveSuccessModal(root);
  switchMainTab('dashboard');
  fetchDashboardServerRows({ force: true });
}

function supplierForUi(root) {
  if (root && root._embeddedSupplier != null) {
    return { ...defaultSupplier(), ...root._embeddedSupplier };
  }
  return loadSupplierDefaults();
}

function supplierVatPercentFromUi(root) {
  const r = String(supplierForUi(root).vatPercent ?? '').trim();
  return r || '10';
}

function updateSupplierStrip(root) {
  const el = root.querySelector('#supplier-strip-summary');
  if (!el) return;
  const s = supplierForUi(root);
  const name = (s.companyName || '').trim();
  el.textContent = name || '미설정 · 설정에서 입력';
}

function updateComposeSectionStatus(root) {
  const s = collectStateFromDom(root);
  const sup = supplierForUi(root);
  const headerOk =
    String(s.dispatchNo || '').trim() !== '' &&
    String(s.issueDate || '').trim() !== '' &&
    String(sup.companyName || '').trim() !== '';
  const linesOk =
    Array.isArray(s.lines) &&
    s.lines.some((l) => {
      const nm = String(l.name || '').trim();
      const q = String(l.qty || '').trim();
      const p = String(l.unitPrice || '').trim();
      return nm !== '' && (q !== '' || p !== '');
    });
  const notesOk =
    String(s.validityDays || '').trim() !== '' ||
    bankAccountDisplayFromState(s) !== '' ||
    String(s.notes || '').trim() !== '';

  [
    ['header', headerOk],
    ['lines', linesOk],
    ['notes', notesOk],
  ].forEach(([key, ok]) => {
    root.querySelectorAll(`[data-compose-dot="${key}"]`).forEach((dot) => {
      dot.classList.toggle('is-done', ok);
      dot.classList.toggle('is-todo', !ok);
      dot.setAttribute('aria-label', ok ? '작성됨' : '미작성');
    });
  });
}

function collectSupplierFromModal(modal) {
  const o = { ...defaultSupplier() };
  modal.querySelectorAll('[data-supplier-f]').forEach((inp) => {
    const k = inp.getAttribute('data-supplier-f');
    if (k) o[k] = inp.value ?? '';
  });
  return o;
}

function openSupplierModal(root) {
  const modal = root.querySelector('#supplier-modal');
  if (!modal) return;
  const s = supplierForUi(root);
  modal.querySelectorAll('[data-supplier-f]').forEach((inp) => {
    const k = inp.getAttribute('data-supplier-f');
    if (k) inp.value = s[k] ?? '';
  });
  root._supplierSignatureUi?.redrawFromHidden?.();
  modal.classList.remove('is-hidden');
  modal.setAttribute('aria-hidden', 'false');
  clearPreviewFocus(root);
  clearPreviewItemZoom(root);
  root.querySelector('#quote-print-root [data-preview-region="preview-supplier"]')?.classList.add('is-preview-focus');
  modal.querySelector('#modal-bizNo')?.focus();
}

function closeSupplierModal(root) {
  const modal = root.querySelector('#supplier-modal');
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
  root.querySelector('#quote-print-root [data-preview-region="preview-supplier"]')?.classList.remove('is-preview-focus');
}

function renderForm(root, state, onChange) {
  if (root._quoteInputHandler) {
    root.removeEventListener('input', root._quoteInputHandler);
    root.removeEventListener('change', root._quoteInputHandler);
  }
  root._quoteInputHandler = onChange;

  if (root._focusInHandler) {
    root.removeEventListener('focusin', root._focusInHandler);
  }
  root._focusInHandler = (ev) => syncPreviewFocus(root, ev.target);
  root.addEventListener('focusin', root._focusInHandler);

  if (root._focusOutHandler) {
    root.removeEventListener('focusout', root._focusOutHandler);
  }
  root._focusOutHandler = (ev) => {
    const saveMo = root.querySelector('#save-quote-modal');
    if (saveMo && !saveMo.classList.contains('is-hidden')) return;
    const modal = root.querySelector('#supplier-modal');
    if (modal && !modal.classList.contains('is-hidden')) return;
    const t = ev.target;
    if (t && t.matches?.('[data-sync-highlight], [data-f], [data-preview-col]')) {
      window.requestAnimationFrame(() => {
        const ae = document.activeElement;
        if (!ae || !root.contains(ae)) {
          clearPreviewFocus(root);
          clearPreviewItemZoom(root);
        }
      });
    }
  };
  root.addEventListener('focusout', root._focusOutHandler);

  const supplierSummary =
    (supplierForUi(root).companyName || '').trim() || '미설정 · 설정에서 입력';

  const quoteSaveInitial =
    (state.quoteSaveName || '').trim() ||
    (root._cloudQuoteFileName ? root._cloudQuoteFileName.replace(/\.json$/i, '') : '');

  const linesHtml = state.lines
    .map(
      (_, i) => `
    <tr data-line-row>
      <td><input type="text" data-f="name" data-preview-col="col-name" placeholder="품명" value="${escapeHtml(state.lines[i].name)}" /></td>
      <td class="num"><input type="text" inputmode="decimal" data-f="qty" data-preview-col="col-qty" placeholder="0" value="${escapeHtml(state.lines[i].qty)}" /></td>
      <td class="num"><input type="text" inputmode="decimal" data-f="unitPrice" data-preview-col="col-price" placeholder="0" value="${escapeHtml(state.lines[i].unitPrice)}" /></td>
      <td class="num computed" data-c="supply"></td>
      <td class="num line-vat-pack">
        <span class="vat-money-val" data-c="vat"></span>
      </td>
      <td class="num"><input type="text" inputmode="decimal" data-f="lineAmount" data-preview-col="col-amt" placeholder="0" value="" /></td>
      <td class="line-remove-cell">${state.lines.length > 1 ? lineRemoveButtonHtml() : ''}</td>
    </tr>`
    )
    .join('');

  root.innerHTML = `
    <div class="page-wrap">
      <h1 class="app-title">견적서 작성</h1>

      <div class="workspace">
        <div class="workspace-main">
          <div class="panel panel-quote-compose">
            <div class="compose-panel-head-row">
              <div class="compose-panel-title-wrap">
                <input
                  type="text"
                  id="quoteSaveName"
                  class="compose-panel-title-input"
                  data-field="quoteSaveName"
                  aria-label="견적 제목"
                  placeholder="견적 제목 · 저장 시 이름으로 사용"
                  autocomplete="off"
                  spellcheck="false"
                  value="${escapeHtml(quoteSaveInitial)}"
                />
              </div>
              <button type="button" class="btn btn-secondary btn-compose-new" id="btn-compose-new-quote" title="새 견적으로 시작"><span class="btn-compose-new-plus" aria-hidden="true">+</span> 새로 작성</button>
            </div>

            <section class="compose-section" aria-labelledby="compose-h-supplier">
              <div class="compose-section-head">
                <h3 id="compose-h-supplier" class="compose-section-title">
                  <span class="compose-status-dot is-todo" data-compose-dot="header" role="img" aria-label="미작성"></span>
                  <span class="compose-section-title-text">공급자 · 견적 헤더</span>
                </h3>
                <button type="button" class="btn btn-gear btn-gear-inline" id="btn-supplier-settings" title="공급자 정보 설정" aria-label="공급자 정보 설정"><span class="gear-icon" aria-hidden="true">⚙</span></button>
              </div>
              <div class="basic-supplier-line">
                <span class="basic-supplier-label">공급자</span>
                <span class="basic-supplier-name" id="supplier-strip-summary">${escapeHtml(supplierSummary)}</span>
              </div>
              <div class="grid-form grid-form-quote-meta">
                <div class="field field-dispatch">
                  <label for="dispatchNo">발송번호</label>
                  <div class="dispatch-no-row">
                    <input id="dispatchNo" data-field="dispatchNo" data-sync-highlight="preview-header-left" type="text" placeholder="자동 또는 직접 입력 · 예: RIM-2026-482917" value="${escapeHtml(state.dispatchNo)}" />
                    <button type="button" class="btn btn-secondary btn-dispatch-new" id="btn-dispatch-new" title="서버에서 다음 일련번호 받기" aria-label="발송번호 새로 받기">새 번호 받기</button>
                  </div>
                </div>
                <div class="field field-issue-date">
                  <label for="issueDate">발행일</label>
                  <input id="issueDate" data-field="issueDate" data-sync-highlight="preview-header-left" type="date" value="${escapeHtml(state.issueDate)}" />
                </div>
              </div>
            </section>

            <section class="compose-section" aria-labelledby="compose-h-lines">
              <h3 id="compose-h-lines" class="compose-section-title">
                <span class="compose-status-dot is-todo" data-compose-dot="lines" role="img" aria-label="미작성"></span>
                <span class="compose-section-title-text">품목</span>
              </h3>
              <div class="items-editor">
                <table class="items-sheet">
                  <colgroup>
                    <col span="6" class="items-col-eq" />
                    <col class="items-col-actions-final" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">품명</th>
                      <th scope="col" class="num">수량</th>
                      <th scope="col" class="num">단가 <span class="th-inline-muted">(VAT별도)</span></th>
                      <th scope="col" class="num">공급가액</th>
                      <th scope="col" class="num">부가세 <span class="th-inline-muted">(%)</span></th>
                      <th scope="col" class="num">금액</th>
                      <th scope="col" class="items-th-actions" aria-label="행 삭제"></th>
                    </tr>
                  </thead>
                  <tbody id="lines-body">${linesHtml}</tbody>
                </table>
              </div>
              <div class="row-actions row-actions-add">
                <button type="button" class="btn-add-line-main" id="btn-add-line" title="품목 행 추가" aria-label="품목 행 추가">
                  <span class="btn-add-line-plus" aria-hidden="true">+</span>
                  <span class="btn-add-line-text">행 추가</span>
                </button>
              </div>
            </section>

            <section class="compose-section" aria-labelledby="compose-h-notes">
              <h3 id="compose-h-notes" class="compose-section-title">
                <span class="compose-status-dot is-todo" data-compose-dot="notes" role="img" aria-label="미작성"></span>
                <span class="compose-section-title-text">비고 · 계좌</span>
              </h3>
              <div class="grid-form grid-form-quote-footer">
                <div class="field field-validity">
                  <label for="validityDays">유효기간 <span class="label-muted">(일)</span></label>
                  <input id="validityDays" data-field="validityDays" data-sync-highlight="preview-footer" type="text" placeholder="30" inputmode="numeric" value="${escapeHtml(state.validityDays)}" />
                </div>
                <div class="field field-bank">
                  <label>송금계좌</label>
                  <p class="bank-account-readonly" id="bank-account-display">${escapeHtml(bankAccountDisplayFromState(state))}</p>
                  <input type="hidden" data-field="bankName" value="${escapeHtml(state.bankName ?? '')}" />
                  <input type="hidden" data-field="bankAccountNo" value="${escapeHtml(state.bankAccountNo ?? '')}" />
                </div>
                <div class="field field-full field-notes">
                  <label for="notes">기타 비고</label>
                  <textarea id="notes" data-field="notes" data-sync-highlight="preview-footer" placeholder="예: 운반비 별도">${escapeHtml(state.notes)}</textarea>
                </div>
              </div>
            </section>
          </div>
        </div>

        <aside class="workspace-preview">
          <div class="preview-toolbar panel">
            <div class="preview-toolbar-main">
              <button type="button" class="btn btn-primary" id="btn-save" disabled aria-disabled="true">저장</button>
            </div>
            <div class="preview-toolbar-export">
              <button type="button" class="btn btn-primary" id="btn-pdf">PDF</button>
              <button type="button" class="btn btn-secondary" id="btn-png">PNG</button>
            </div>
          </div>
          <div class="preview-section panel preview-panel">
            <h2 class="preview-heading">미리보기</h2>
            <div class="quote-scroll">
              <div class="quote-fit-stage" id="quote-fit-stage">
                <div class="quote-fit-slot" id="quote-fit-slot">
                  <div class="quote-fit-scale-wrap" id="quote-fit-scale-wrap">
                    <div class="quote-document" id="quote-print-root"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
    ${supplierModalMarkup()}
    ${saveQuoteModalMarkup()}
    ${newQuoteConfirmModalMarkup()}
    ${saveSuccessModalMarkup()}
    <div class="export-loading" id="export-loading" role="status" aria-live="polite">
      <div class="export-loading-inner">
        <span class="export-loading-spinner" aria-hidden="true"></span>
        <span class="export-loading-text">파일을 만드는 중…</span>
      </div>
    </div>
  `;

  const formBump = (e) => {
    const t = e.target;
    if (t?.matches?.('[data-f="lineAmount"]') && !t.dataset.progSync) {
      const row = t.closest('[data-line-row]');
      if (row) {
        const qty = row.querySelector('[data-f="qty"]')?.value ?? '';
        const vatPct = supplierVatPercentFromUi(root);
        const derived = deriveUnitPriceFromAmount(qty, vatPct, t.value);
        const unitInp = row.querySelector('[data-f="unitPrice"]');
        if (derived != null && unitInp) {
          unitInp.dataset.progSync = '1';
          unitInp.value = String(derived);
          delete unitInp.dataset.progSync;
        }
      }
    }
    updateComputedCells(root);
    onChange(e);
  };
  root.addEventListener('input', formBump);
  root.addEventListener('change', formBump);

  if (!root._lineRemoveClickBound) {
    root._lineRemoveClickBound = true;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-remove-line');
      if (!btn || !root.contains(btn)) return;
      const tbody = root.querySelector('#lines-body');
      if (!tbody?.contains(btn)) return;
      const tr = btn.closest('[data-line-row]');
      if (!tr) return;
      const rows = tbody.querySelectorAll('[data-line-row]');
      if (rows.length <= 1) return;
      tr.remove();
      syncLineRemoveButtons(root);
      onChange();
    });
  }

  root.querySelector('#btn-supplier-settings').addEventListener('click', () => openSupplierModal(root));

  root.querySelector('#btn-dispatch-new')?.addEventListener('click', async () => {
    try {
      assertCloudApiConfigured();
      const no = await fetchNextDispatchNo();
      const inp = root.querySelector('[data-field="dispatchNo"]');
      if (inp) {
        inp.value = no;
        onChange();
        persistDraftFromDom();
      }
    } catch (err) {
      alert(err.message || String(err));
    }
  });

  root.querySelector('#supplier-save').addEventListener('click', () => {
    syncSupplierSignatureToHidden(root);
    const modal = root.querySelector('#supplier-modal');
    const collected = collectSupplierFromModal(modal);
    saveSupplierDefaults(collected);
    root._embeddedSupplier = { ...defaultSupplier(), ...collected };
    updateSupplierStrip(root);
    const bnInp = root.querySelector('[data-field="bankName"]');
    const baInp = root.querySelector('[data-field="bankAccountNo"]');
    if (bnInp) bnInp.value = collected.bankName ?? '';
    if (baInp) baInp.value = collected.bankAccountNo ?? '';
    const disp = root.querySelector('#bank-account-display');
    if (disp)
      disp.textContent =
        formatBankAccountLine(collected.bankName, collected.bankAccountNo) || '';
    closeSupplierModal(root);
    onChange();
    alert('공급자 정보를 저장했습니다.');
  });

  ['#supplier-close', '#supplier-modal-x'].forEach((sel) => {
    root.querySelector(sel)?.addEventListener('click', () => closeSupplierModal(root));
  });

  bindSupplierSignaturePad(root);

  root.querySelector('#save-quote-modal-x')?.addEventListener('click', () => closeSaveQuoteModal(root));
  root.querySelector('#save-quote-cancel')?.addEventListener('click', () => closeSaveQuoteModal(root));
  root.querySelector('#save-quote-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'save-quote-modal') closeSaveQuoteModal(root);
  });

  ['#new-quote-confirm-x', '#new-quote-confirm-cancel'].forEach((sel) => {
    root.querySelector(sel)?.addEventListener('click', () => closeNewQuoteConfirmModal(root));
  });
  root.querySelector('#new-quote-confirm-ok')?.addEventListener('click', () => {
    closeNewQuoteConfirmModal(root);
    persistDraftFromDom();
    mountApp(root, defaultState(), null);
    switchMainTab('write');
  });

  const dismissSaveSuccess = () => goDashboardAfterSaveFromModal(root);
  root.querySelector('#save-success-ok')?.addEventListener('click', dismissSaveSuccess);
  root.querySelector('#save-success-x')?.addEventListener('click', dismissSaveSuccess);

  root.querySelector('#btn-compose-new-quote')?.addEventListener('click', () => {
    if (isQuoteDraftDirty(root)) {
      openNewQuoteConfirmModal(root);
      return;
    }
    persistDraftFromDom();
    mountApp(root, defaultState(), null);
    switchMainTab('write');
  });

  root.querySelector('#btn-add-line').addEventListener('click', () => {
    const tbody = root.querySelector('#lines-body');
    const tr = document.createElement('tr');
    tr.setAttribute('data-line-row', '');
    tr.innerHTML = `
      <td><input type="text" data-f="name" data-preview-col="col-name" placeholder="품명" /></td>
      <td class="num"><input type="text" inputmode="decimal" data-f="qty" data-preview-col="col-qty" placeholder="0" /></td>
      <td class="num"><input type="text" inputmode="decimal" data-f="unitPrice" data-preview-col="col-price" placeholder="0" /></td>
      <td class="num computed" data-c="supply"></td>
      <td class="num line-vat-pack">
        <span class="vat-money-val" data-c="vat"></span>
      </td>
      <td class="num"><input type="text" inputmode="decimal" data-f="lineAmount" data-preview-col="col-amt" placeholder="0" value="" /></td>
      <td class="line-remove-cell"></td>`;
    tbody.appendChild(tr);
    syncLineRemoveButtons(root);
    onChange();
  });

  syncLineRemoveButtons(root);

  root.querySelector('#btn-save').addEventListener('click', () => {
    try {
      assertCloudApiConfigured();
    } catch (err) {
      alert(err.message || String(err));
      return;
    }
    openSaveQuoteModal(root);
  });

  root.querySelector('#save-quote-confirm')?.addEventListener('click', async () => {
    const loadingEl = () => document.getElementById('export-loading');
    const inp = root.querySelector('#save-quote-modal-input');
    const hid = root.querySelector('[data-field="quoteSaveName"]');
    const raw = inp?.value?.trim() ?? '';
    const displayName = quoteDisplayNameFromModalInput(raw);
    if (!displayName) {
      alert('저장 이름을 입력해 주세요.');
      return;
    }
    hid.value = displayName;
    closeSaveQuoteModal(root);
    loadingEl()?.classList.add('active');
    try {
      const s = collectStateFromDom(root);
      const fileName = fileNameFromSaveModalInput(raw, root._cloudQuoteFileName || suggestedQuoteFileName(s));
      const payload = cloudPayloadFromState(s);
      await putCloudQuote(fileName, payload);
      saveState(s);
      markDashboardQuotesStale();
      root._cloudQuoteFileName = fileName;
      markDashboardJustSaved(fileName);
      captureQuoteDirtyBaseline(root);
      updateSaveButtonEnabled(root);
      const stLabel = payload.quoteStatusLabel || (payload.quoteComplete ? '완료' : '미작성');
      openSaveSuccessModal(root, `저장했습니다. [${stLabel}]\n${fileName}`);
    } catch (e) {
      alert(`저장에 실패했습니다.\n${e.message || e}`);
    } finally {
      loadingEl()?.classList.remove('active');
    }
  });

  root.querySelector('#btn-pdf').addEventListener('click', () => exportPdf(root));
  root.querySelector('#btn-png').addEventListener('click', () => exportPng(root));
}

function updateComputedCells(root) {
  const tbody = root.querySelector('#lines-body');
  if (!tbody) return;
  const vatPct = supplierVatPercentFromUi(root);
  tbody.querySelectorAll('[data-line-row]').forEach((row) => {
    const qty = row.querySelector('[data-f="qty"]')?.value ?? '';
    const unit = row.querySelector('[data-f="unitPrice"]')?.value ?? '';
    const { supply, vat, amount } = lineComputed(qty, unit, vatPct);
    const sEl = row.querySelector('[data-c="supply"]');
    const vEl = row.querySelector('[data-c="vat"]');
    const amtInp = row.querySelector('[data-f="lineAmount"]');
    const hasNums = supply !== 0 || parseNum(qty) !== 0 || parseNum(unit) !== 0;
    if (hasNums) {
      sEl.textContent = fmtMoney(supply);
      vEl.textContent = fmtMoney(vat);
    } else {
      sEl.textContent = '';
      vEl.textContent = '';
    }
    if (amtInp) {
      const next = hasNums ? String(amount) : '';
      if (amtInp.value !== next) {
        amtInp.dataset.progSync = '1';
        amtInp.value = next;
        delete amtInp.dataset.progSync;
      }
    }
  });
}

async function exportPdf(root) {
  const JsPDF = getJsPDF();
  if (!window.html2canvas || !JsPDF) {
    alert('PDF 기능을 불러오지 못했습니다. 인터넷에 연결된 뒤 다시 시도해 주세요.');
    return;
  }
  clearPreviewFocus(root);
  clearPreviewItemZoom(root);
  const node = root.querySelector('#quote-print-root');
  const loading = root.querySelector('#export-loading');
  const restoreFit = unwrapQuoteFitForCapture(root);
  loading.classList.add('active');
  try {
    const canvas = await window.html2canvas(node, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;
    const imgH = (canvas.height * imgW) / canvas.width;
    let heightLeft = imgH;
    let position = 0;
    pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      position = heightLeft - imgH;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
      heightLeft -= pageH;
    }
    const dispatch = collectStateFromDom(root).dispatchNo || '견적서';
    pdf.save(`${dispatch.replace(/[^\w가-힣0-9_-]/g, '_') || '견적서'}.pdf`);
  } finally {
    restoreFit();
    loading.classList.remove('active');
  }
}

async function exportPng(root) {
  if (!window.html2canvas) {
    alert('이미지 기능을 불러오지 못했습니다. 인터넷에 연결된 뒤 다시 시도해 주세요.');
    return;
  }
  clearPreviewFocus(root);
  clearPreviewItemZoom(root);
  const node = root.querySelector('#quote-print-root');
  const loading = root.querySelector('#export-loading');
  const restoreFit = unwrapQuoteFitForCapture(root);
  loading.classList.add('active');
  try {
    const canvas = await window.html2canvas(node, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });
    const a = document.createElement('a');
    const dispatch = collectStateFromDom(root).dispatchNo || '견적서';
    a.download = `${dispatch.replace(/[^\w가-힣0-9_-]/g, '_') || '견적서'}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  } finally {
    restoreFit();
    loading.classList.remove('active');
  }
}

function scheduleMaybeAssignDispatchNo(mountEl, refresh) {
  if (mountEl._cloudQuoteFileName) return Promise.resolve();
  const inp = mountEl.querySelector('[data-field="dispatchNo"]');
  if (!inp || String(inp.value || '').trim() !== '') return Promise.resolve();
  if (!CLOUD_API_BASE) return Promise.resolve();
  return fetchNextDispatchNo()
    .then((no) => {
      const el = mountEl.querySelector('[data-field="dispatchNo"]');
      if (!el || mountEl._cloudQuoteFileName) return;
      if (String(el.value || '').trim() !== '') return;
      el.value = no;
      refresh();
      persistDraftFromDom();
    })
    .catch(() => {});
}

/**
 * @param {object|null|undefined} sessionMeta — null/undefined 이면 서버 파일 연결 해제
 * @param {{ cloudFileName?: string|null }} [sessionMeta]
 */
function mountApp(mountEl, initialState, sessionMeta) {
  if (mountEl._supplierEsc) {
    document.removeEventListener('keydown', mountEl._supplierEsc);
    mountEl._supplierEsc = null;
  }
  if (mountEl._quoteFitRo) {
    mountEl._quoteFitRo.disconnect();
    mountEl._quoteFitRo = null;
  }
  if (mountEl._quoteFitOnResize) {
    window.removeEventListener('resize', mountEl._quoteFitOnResize);
    mountEl._quoteFitOnResize = null;
  }
  clearTimeout(mountEl._fitPreviewDebounce);
  mountEl._fitPreviewDebounce = null;

  if (sessionMeta === undefined || sessionMeta === null) {
    mountEl._cloudQuoteFileName = null;
  } else {
    mountEl._cloudQuoteFileName =
      sessionMeta.cloudFileName !== undefined ? sessionMeta.cloudFileName : null;
  }

  const baseDraft = initialState || loadState();
  mountEl._embeddedSupplier = supplierEmbeddingFromPayload(baseDraft);
  const state = mergeSupplierIntoState({ ...defaultState(), ...baseDraft }, mountEl);

  const refresh = () => {
    const s = collectStateFromDom(mountEl);
    const bankDisp = mountEl.querySelector('#bank-account-display');
    if (bankDisp) bankDisp.textContent = bankAccountDisplayFromState(s);
    const typingLine = isTypingPreviewLineItem(mountEl);
    renderQuotePreview(mountEl.querySelector('#quote-print-root'), s);
    /* 품목 입력 중에는 줌을 지우지 않음 → 확대 유지. 다른 칸이면 strip 후 sync에서 다시 잡음 */
    if (!typingLine) stripPreviewZoomTransform(mountEl);
    updateComputedCells(mountEl);
    updateSupplierStrip(mountEl);
    updateComposeSectionStatus(mountEl);
    updateSaveButtonEnabled(mountEl);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ae = document.activeElement;
        if (ae && mountEl.contains(ae)) syncPreviewFocus(mountEl, ae);
      });
    });
    scheduleFitQuotePreview(mountEl);
  };

  mountEl._quoteDirtyBaselineJson = null;
  renderForm(mountEl, state, refresh);
  refresh();
  fitQuotePreview(mountEl);
  Promise.resolve(scheduleMaybeAssignDispatchNo(mountEl, refresh)).finally(() => {
    captureQuoteDirtyBaseline(mountEl);
    updateSaveButtonEnabled(mountEl);
  });

  const stage = mountEl.querySelector('#quote-fit-stage');
  const quoteScroll = mountEl.querySelector('.quote-scroll');
  const refitPreview = () => {
    scheduleFitQuotePreview(mountEl);
  };
  if (typeof ResizeObserver !== 'undefined') {
    mountEl._quoteFitRo = new ResizeObserver(refitPreview);
    if (stage) mountEl._quoteFitRo.observe(stage);
    if (quoteScroll) mountEl._quoteFitRo.observe(quoteScroll);
  }
  mountEl._quoteFitOnResize = refitPreview;
  window.addEventListener('resize', mountEl._quoteFitOnResize);

  mountEl._supplierEsc = (ev) => {
    if (ev.key !== 'Escape') return;
    const succMo = mountEl.querySelector('#save-success-modal');
    if (succMo && !succMo.classList.contains('is-hidden')) {
      goDashboardAfterSaveFromModal(mountEl);
      return;
    }
    const nqMo = mountEl.querySelector('#new-quote-confirm-modal');
    if (nqMo && !nqMo.classList.contains('is-hidden')) {
      closeNewQuoteConfirmModal(mountEl);
      return;
    }
    const saveMo = mountEl.querySelector('#save-quote-modal');
    if (saveMo && !saveMo.classList.contains('is-hidden')) {
      closeSaveQuoteModal(mountEl);
      return;
    }
    const modal = mountEl.querySelector('#supplier-modal');
    if (!modal || modal.classList.contains('is-hidden')) return;
    closeSupplierModal(mountEl);
  };
  document.addEventListener('keydown', mountEl._supplierEsc);
}

/** 대시보드용 — 견적서와 동일 열 구성(품명·수량·단가·공급가액·부가세·금액) */
function buildDashboardLinesTableHtml(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    return '<p class="dashboard-lines-empty">등록된 품목이 없습니다.</p>';
  }
  const body = lines
    .map((l) => {
      const name = String(l.name || '').trim();
      const qty = String(l.qty || '').trim();
      const unit = String(l.unitPrice || '').trim();
      const { supply, vat, amount } = lineComputed(l.qty, l.unitPrice, l.vatPercent ?? '10');
      const hasContent =
        name !== '' ||
        supply !== 0 ||
        parseNum(l.qty) !== 0 ||
        parseNum(l.unitPrice) !== 0;
      if (!hasContent) return '';
      const showAmt = supply !== 0 || parseNum(l.qty) !== 0 || parseNum(l.unitPrice) !== 0;
      return `<tr>
          <td>${escapeHtml(name || '—')}</td>
          <td class="num">${escapeHtml(qty || '—')}</td>
          <td class="num">${escapeHtml(unit || '—')}</td>
          <td class="num">${showAmt ? escapeHtml(fmtMoney(supply)) : '—'}</td>
          <td class="num">${showAmt ? escapeHtml(fmtMoney(vat)) : '—'}</td>
          <td class="num">${showAmt ? escapeHtml(fmtMoney(amount)) : '—'}</td>
        </tr>`;
    })
    .filter(Boolean)
    .join('');
  if (!body) {
    return '<p class="dashboard-lines-empty">등록된 품목이 없습니다.</p>';
  }
  return `<table class="dashboard-lines-sheet"><thead><tr>
      <th>품명</th>
      <th class="num">수량</th>
      <th class="num">단가 <span class="dashboard-lines-th-sub">(VAT별도)</span></th>
      <th class="num">공급가액</th>
      <th class="num">부가세 ${vatColumnTitleSuffixHtml(lines, 'dashboard-lines-th-sub')}</th>
      <th class="num">금액</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

function sortDashboardMetasByIssue(metas, ascending) {
  return [...metas].sort((a, b) => {
    const ai = String(a.issue || '').trim();
    const bi = String(b.issue || '').trim();
    if (!ai && !bi) {
      return String(b.savedAt).localeCompare(String(a.savedAt));
    }
    if (!ai) return 1;
    if (!bi) return -1;
    let c = ai.localeCompare(bi);
    if (c !== 0) return ascending ? c : -c;
    return String(b.savedAt).localeCompare(String(a.savedAt));
  });
}

function sortDashboardMetasBySaved(metas, ascending) {
  return [...metas].sort((a, b) => {
    const as = String(a.savedAt || '').trim();
    const bs = String(b.savedAt || '').trim();
    if (!as && !bs) {
      return String(b.issue || '').localeCompare(String(a.issue || ''));
    }
    if (!as) return 1;
    if (!bs) return -1;
    let c = as.localeCompare(bs);
    if (c !== 0) return ascending ? c : -c;
    return String(b.issue || '').localeCompare(String(a.issue || ''));
  });
}

function sortDashboardMetas(metas, order) {
  switch (order) {
    case 'issue-asc':
      return sortDashboardMetasByIssue(metas, true);
    case 'saved-desc':
      return sortDashboardMetasBySaved(metas, false);
    case 'saved-asc':
      return sortDashboardMetasBySaved(metas, true);
    case 'issue-desc':
    default:
      return sortDashboardMetasByIssue(metas, false);
  }
}

function renderDashboardQuotesTable(wrap, metas) {
  const status = document.getElementById('dashboard-status');
  if (!metas.length) {
    wrap.innerHTML = '<p class="dashboard-empty">저장된 견적이 없습니다.</p>';
    if (status) status.textContent = '';
    return;
  }

  const q = dashboardDispatchFilterRaw.trim().toLowerCase();
  const filtered =
    q === ''
      ? metas
      : metas.filter((m) => {
          const disp = String(m.dispatch || '').trim().toLowerCase();
          const save = String(m.quoteSaveName || '').trim().toLowerCase();
          return disp.includes(q) || save.includes(q);
        });

  if (!filtered.length) {
    wrap.innerHTML =
      '<p class="dashboard-empty">검색에 맞는 견적이 없습니다.</p>';
    if (status) status.textContent = '';
    return;
  }

  const sorted = sortDashboardMetas(filtered, dashboardSortOrder);

  const rows = sorted
    .map((m) => {
      const dispatchStr = String(m.dispatch || '').trim();
      const saveStr = String(m.quoteSaveName || '').trim();
      const fileStem = String(m.name || '')
        .replace(/\.json$/i, '')
        .trim();
      const titleLarge = saveStr || fileStem || '저장 이름 없음';
      const dispatchSub = dispatchStr
        ? `발송번호 ${dispatchStr}`
        : '발송번호 미입력';
      const enc = encodeURIComponent(m.name);
      let stClass = 'dashboard-status-pill is-complete';
      if (m.statusLabel === '미작성') stClass = 'dashboard-status-pill is-incomplete';
      else if (m.statusLabel === '—' || m.err) stClass = 'dashboard-status-pill is-unknown';
      const errNote = m.err
        ? '<p class="dashboard-quote-warn" role="status">본문을 불러오지 못했습니다.</p>'
        : '';
      const bottomFloor = m.err
        ? ''
        : `<details class="dashboard-lines-details">
              <summary class="dashboard-lines-summary"><span class="dashboard-lines-summary-text">품목 표 펼치기</span></summary>
              <div class="dashboard-floor-bottom">
                <div class="dashboard-lines-embed">${m.linesTableHtml}</div>
              </div>
            </details>`;
      return `<tr class="dashboard-row-quote">
            <td colspan="5" class="dashboard-cell-card">
              <div class="dashboard-quote-card">
                <div class="dashboard-floor-top">
                  <div class="dashboard-floor-summary">
                    <div class="dashboard-quote-header">
                      <span class="dashboard-quote-kicker">견적서</span>
                      <span class="dashboard-quote-title-wrap">
                        <span class="dashboard-quote-title">${escapeHtml(titleLarge)}</span>${dashNewBadgeHtml(m.name)}
                      </span>
                      <span class="dashboard-quote-dispatch-sub">${escapeHtml(dispatchSub)}</span>
                    </div>
                    ${errNote}
                  </div>
                  <div class="dashboard-floor-status"><span class="${stClass}">${escapeHtml(m.statusLabel)}</span></div>
                  <div class="dashboard-floor-dates">
                    <span class="dashboard-date-line"><span class="dashboard-date-lbl">발행</span>${escapeHtml(fmtIssueDateKo(m.issue))}</span>
                    <span class="dashboard-date-line muted"><span class="dashboard-date-lbl">저장</span>${escapeHtml(fmtSavedAtKo(m.savedAt))}</span>
                  </div>
                  <div class="dashboard-floor-actions">
                    <button type="button" class="dashboard-icon-btn dashboard-edit-cloud" data-quote-file="${enc}" title="수정" aria-label="견적 수정">${DASH_EDIT_SVG}</button>
                    <button type="button" class="dashboard-icon-btn dashboard-delete-cloud" data-quote-file="${enc}" title="삭제" aria-label="견적 삭제">${LINE_REMOVE_TRASH_SVG}</button>
                  </div>
                </div>
                ${bottomFloor}
              </div>
            </td>
          </tr>`;
    })
    .join('');

  wrap.innerHTML = `
        <table class="dashboard-table dashboard-table-pro" aria-label="저장된 견적 목록">
          <thead>
            <tr>
              <th scope="col" colspan="5" class="dashboard-th-span">저장된 견적</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  if (status) status.textContent = '';
}

async function fetchDashboardServerRows({ force = false } = {}) {
  const wrap = document.getElementById('server-table-wrap');
  const status = document.getElementById('dashboard-status');
  if (!wrap) return;

  const hasStable = dashboardWrapHasStableListUi(wrap);
  if (!force && !dashboardQuotesInvalidateNext && hasStable) {
    return;
  }

  if (!CLOUD_API_BASE) {
    wrap.innerHTML =
      '<p class="dashboard-empty">Worker 주소가 비어 있습니다. HTML에서 window.__EOULRIM_UPLOAD_API__를 설정해 주세요.</p>';
    if (status) status.textContent = '';
    dashboardQuotesInvalidateNext = false;
    dashboardQuotesMetasCache = null;
    return;
  }

  dashboardQuotesInvalidateNext = false;
  const gen = ++dashboardFetchGen;

  wrap.innerHTML = '<p class="dashboard-muted">목록 불러오는 중…</p>';
  try {
    const items = await listCloudQuotes();
    if (gen !== dashboardFetchGen) return;
    if (!items.length) {
      dashboardQuotesMetasCache = [];
      wrap.innerHTML =
        '<p class="dashboard-empty">서버에 저장된 견적이 없습니다. 작성 탭에서 「저장」을 사용해 보세요.</p>';
      if (status) status.textContent = '';
      return;
    }

    const metas = await mapPool(items, 6, async (it) => {
      try {
        const data = await getCloudQuote(it.name);
        const savedAt = data.savedAt || data.serverSavedDate || '';
        const issue = data.issueDate || '';
        const dispatch = data.dispatchNo || '';
        const statusLabel = quoteStatusLabelFromPayload(data);
        const linesTableHtml = buildDashboardLinesTableHtml(data.lines || []);
        return {
          name: it.name,
          savedAt,
          issue,
          dispatch,
          quoteSaveName: String(data.quoteSaveName ?? '').trim(),
          statusLabel,
          linesTableHtml,
          companyName: String(data.companyName ?? '').trim(),
        };
      } catch {
        return {
          name: it.name,
          savedAt: '',
          issue: '',
          dispatch: '',
          quoteSaveName: '',
          statusLabel: '—',
          linesTableHtml: '',
          companyName: '',
          err: true,
        };
      }
    });

    if (gen !== dashboardFetchGen) return;

    dashboardQuotesMetasCache = metas;
    renderDashboardQuotesTable(wrap, metas);
  } catch (e) {
    dashboardQuotesMetasCache = null;
    wrap.innerHTML = '<p class="dashboard-empty">서버 목록을 불러오지 못했습니다.</p>';
    if (status) status.textContent = e.message || String(e);
    markDashboardQuotesStale();
  }
}

function switchMainTab(which) {
  const writeBtn = document.getElementById('tab-write-btn');
  const dashBtn = document.getElementById('tab-dash-btn');
  const panelWrite = document.getElementById('panel-write');
  const panelDash = document.getElementById('panel-dashboard');
  if (!writeBtn || !dashBtn || !panelWrite || !panelDash) return;

  const isWrite = which === 'write';

  if (!isWrite) {
    persistDraftFromDom();
  }

  panelWrite.classList.toggle('tab-panel-active', isWrite);
  panelWrite.classList.toggle('tab-panel-hidden', !isWrite);
  panelDash.classList.toggle('tab-panel-active', !isWrite);
  panelDash.classList.toggle('tab-panel-hidden', isWrite);
  panelDash.setAttribute('aria-hidden', isWrite ? 'true' : 'false');
  writeBtn.setAttribute('aria-selected', String(isWrite));
  dashBtn.setAttribute('aria-selected', String(!isWrite));

  if (!isWrite) {
    fetchDashboardServerRows();
  } else {
    const mountEl = document.getElementById('app');
    if (mountEl && mountEl.querySelector('#quote-fit-stage')) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => fitQuotePreview(mountEl));
      });
    }
  }
}

function initMainTabs() {
  const dashPanel = document.getElementById('panel-dashboard');
  document.getElementById('tab-write-btn')?.addEventListener('click', () => switchMainTab('write'));
  document.getElementById('tab-dash-btn')?.addEventListener('click', () => switchMainTab('dashboard'));
  document.getElementById('btn-refresh-server')?.addEventListener('click', () => {
    fetchDashboardServerRows({ force: true });
  });

  document.getElementById('dashboard-dispatch-filter')?.addEventListener('input', (e) => {
    dashboardDispatchFilterRaw = e.target?.value || '';
    const wrap = document.getElementById('server-table-wrap');
    if (wrap && dashboardQuotesMetasCache) renderDashboardQuotesTable(wrap, dashboardQuotesMetasCache);
  });

  const sortEl = document.getElementById('dashboard-quote-sort');
  if (sortEl) {
    sortEl.value = dashboardSortOrder;
    sortEl.addEventListener('change', () => {
      const v = sortEl.value;
      dashboardSortOrder =
        v === 'issue-asc' || v === 'saved-desc' || v === 'saved-asc' ? v : 'issue-desc';
      sortEl.value = dashboardSortOrder;
      const wrap = document.getElementById('server-table-wrap');
      if (wrap && dashboardQuotesMetasCache) renderDashboardQuotesTable(wrap, dashboardQuotesMetasCache);
    });
  }

  if (!window.__eoulrimDraftPersistBound) {
    window.__eoulrimDraftPersistBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistDraftFromDom();
    });
    window.addEventListener('pagehide', () => persistDraftFromDom());
  }
  document.getElementById('btn-new-quote')?.addEventListener('click', () => {
    persistDraftFromDom();
    mountApp(document.getElementById('app'), defaultState(), null);
    switchMainTab('write');
  });

  dashPanel?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.dashboard-edit-cloud');
    if (editBtn) {
      const enc = editBtn.getAttribute('data-quote-file');
      const fileName = enc ? decodeURIComponent(enc) : '';
      if (!fileName) return;
      if (!CLOUD_API_BASE) {
        alert('Worker 주소를 설정해 주세요.');
        return;
      }
      getCloudQuote(fileName)
        .then((data) => {
          persistDraftFromDom();
          mountApp(document.getElementById('app'), stateFromCloudPayload(data), {
            cloudFileName: fileName,
          });
          switchMainTab('write');
        })
        .catch((err) => alert(err.message || String(err)));
      return;
    }

    const delBtn = e.target.closest('.dashboard-delete-cloud');
    if (delBtn) {
      const enc = delBtn.getAttribute('data-quote-file');
      const fileName = enc ? decodeURIComponent(enc) : '';
      if (!fileName) return;
      if (!CLOUD_API_BASE) {
        alert('Worker 주소를 설정해 주세요.');
        return;
      }
      if (
        !confirm(
          `이 견적을 서버에서 삭제할까요?\n${fileName}\n삭제 후에는 복구할 수 없습니다.`,
        )
      ) {
        return;
      }
      deleteCloudQuote(fileName)
        .then(() => {
          markDashboardQuotesStale();
          return fetchDashboardServerRows({ force: true });
        })
        .catch((err) => alert(err.message || String(err)));
    }
  });
}

async function bootQuoteEditor() {
  initMainTabs();

  const mountEl = document.getElementById('app');
  const params = new URLSearchParams(window.location.search);
  const cloud = params.get('cloud');
  if (cloud) {
    if (!CLOUD_API_BASE) {
      alert('Worker 주소(window.__EOULRIM_UPLOAD_API__)를 설정한 뒤 다시 열어 주세요.');
      mountApp(mountEl);
      switchMainTab(window.location.hash === '#dashboard' ? 'dashboard' : 'write');
      return;
    }
    try {
      const data = await getCloudQuote(cloud);
      history.replaceState({}, '', window.location.pathname + window.location.hash);
      persistDraftFromDom();
      mountApp(mountEl, stateFromCloudPayload(data), { cloudFileName: cloud });
    } catch (e) {
      alert(`저장된 견적을 불러오지 못했습니다.\n${e.message || e}`);
      persistDraftFromDom();
      mountApp(mountEl);
    }
    switchMainTab('write');
    return;
  }

  mountApp(mountEl);
  switchMainTab(window.location.hash === '#dashboard' ? 'dashboard' : 'write');
}

bootQuoteEditor();
