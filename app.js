/* 전역: html2canvas, window.jspdf.jsPDF (UMD) — quotes-shared.js 를 먼저 로드 */

const SUPPLIER_KEY = 'eoulrim-supplier-defaults-v1';
const TABLE_BODY_ROWS = 14;

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
    parsed.phone;
  const existing = loadSupplierDefaults();
  const supplierEmpty = !Object.values(existing).some((v) => String(v || '').trim());
  if (hasOld && supplierEmpty) {
    saveSupplierDefaults({
      bizNo: parsed.bizNo ?? '',
      companyName: parsed.companyName ?? '',
      ceo: parsed.ceo ?? '',
      address: parsed.address ?? '',
      bizType: parsed.bizType ?? '',
      bizItem: parsed.bizItem ?? '',
      contact: parsed.contact ?? '',
      phone: parsed.phone ?? '',
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

function lineComputed(qtyRaw, unitRaw) {
  const qty = parseNum(qtyRaw);
  const unit = parseNum(unitRaw);
  const supply = qty * unit;
  const vat = Math.round(supply * 0.1);
  const amount = supply + vat;
  return { supply, vat, amount };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    migrateDraftSupplierIfNeeded(parsed);
    const base = defaultState();
    return {
      ...base,
      dispatchNo: parsed.dispatchNo ?? '',
      issueDate: parsed.issueDate ?? base.issueDate,
      validityDays: parsed.validityDays ?? '',
      bankAccount: parsed.bankAccount ?? '',
      notes: parsed.notes ?? '',
      lines:
        Array.isArray(parsed.lines) && parsed.lines.length
          ? parsed.lines.map((l) => ({
              name: l.name ?? '',
              qty: l.qty ?? '',
              unitPrice: l.unitPrice ?? '',
            }))
          : base.lines,
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  const slim = {
    dispatchNo: state.dispatchNo,
    issueDate: state.issueDate,
    validityDays: state.validityDays,
    bankAccount: state.bankAccount,
    notes: state.notes,
    lines: state.lines,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
}

function mergeSupplierIntoState(base, root) {
  const embed = root && root._embeddedSupplier;
  const s = embed ? { ...defaultSupplier(), ...embed } : loadSupplierDefaults();
  return {
    ...base,
    bizNo: s.bizNo,
    companyName: s.companyName,
    ceo: s.ceo,
    address: s.address,
    bizType: s.bizType,
    bizItem: s.bizItem,
    contact: s.contact,
    phone: s.phone,
  };
}

function collectStateFromDom(root) {
  const q = (sel) => root.querySelector(sel);
  const lines = [];
  root.querySelectorAll('[data-line-row]').forEach((row) => {
    lines.push({
      name: row.querySelector('[data-f="name"]')?.value ?? '',
      qty: row.querySelector('[data-f="qty"]')?.value ?? '',
      unitPrice: row.querySelector('[data-f="unitPrice"]')?.value ?? '',
    });
  });
  const quote = {
    dispatchNo: q('[data-field="dispatchNo"]')?.value ?? '',
    issueDate: q('[data-field="issueDate"]')?.value ?? '',
    validityDays: q('[data-field="validityDays"]')?.value ?? '',
    bankAccount: q('[data-field="bankAccount"]')?.value ?? '',
    notes: q('[data-field="notes"]')?.value ?? '',
    lines,
  };
  return mergeSupplierIntoState(quote, root);
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
  }, 140);
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
}

/** 미리보기 내용만 갱신될 때 확대 행렬만 제거(같은 칸 입력 시 깜빡임 방지용 키는 유지) */
function stripPreviewZoomTransform(root) {
  const doc = root.querySelector('#quote-print-root');
  if (!doc) return;
  doc.classList.remove('is-preview-item-zoom');
  doc.classList.remove('preview-zoom-instant');
  doc.style.transform = '';
  doc.style.transformOrigin = '';
}

/** 품목 입력 중 미리보기 확대 — 세로는 해당 칸, 가로는 슬롯(미리보기) 중앙에 맞춤 */
function applyPreviewItemZoom(root, tdEl, rowIdx, colKey) {
  const doc = root.querySelector('#quote-print-root');
  const slot = root.querySelector('#quote-fit-slot');
  if (!doc || !tdEl || !slot) return;

  const zoomKey = `${rowIdx}:${colKey}`;
  const instant = root._previewZoomKey === zoomKey;
  root._previewZoomKey = zoomKey;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      doc.style.transform = 'none';
      doc.style.transformOrigin = '';
      void doc.offsetHeight;

      const dr = doc.getBoundingClientRect();
      const cr = tdEl.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      if (dr.width < 4 || dr.height < 4) return;

      const s = 1.32;
      const slotCx = sr.left + sr.width / 2;
      const cellCx = cr.left + cr.width / 2;
      const shiftX = slotCx - cellCx;
      const oy = ((cr.top + cr.height / 2 - dr.top) / dr.height) * 100;

      doc.style.transformOrigin = `50% ${Math.max(4, Math.min(96, oy))}%`;
      if (instant) doc.classList.add('preview-zoom-instant');
      doc.style.transform = `translate(${shiftX}px, 0) scale(${s})`;
      doc.classList.add('is-preview-item-zoom');
      if (instant) {
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
    const { supply, vat, amount } = lineComputed(ln.qty, ln.unitPrice);
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
      const supplyDisp = r.hasContent && r.supply !== 0 ? fmtMoney(r.supply) : '';
      const vatDisp = r.hasContent && r.vat !== 0 ? fmtMoney(r.vat) : '';
      const amtDisp = r.hasContent && r.amount !== 0 ? fmtMoney(r.amount) : '';
      return `<tr data-preview-row="${idx}">
        <td class="col-name">${name}</td>
        <td class="col-qty">${qtyShow ? escapeHtml(qtyShow) : ''}</td>
        <td class="col-price">${supplyDisp}</td>
        <td class="col-vat">${vatDisp}</td>
        <td class="col-amt">${amtDisp}</td>
      </tr>`;
    })
    .join('');

  const validity = escapeHtml(state.validityDays || '');
  const bank = escapeHtml(state.bankAccount || '');
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
          <div class="sg-label">담 당 자</div><div>${escapeHtml(state.contact || '')}</div>
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
            <th class="col-vat">부가세</th>
            <th class="col-amt">금액</th>
          </tr>
        </thead>
        <tbody>
          ${tbody}
          <tr class="summary-row" data-preview-region="preview-summary">
            <td class="sum-label" colspan="2">합계금액</td>
            <td class="col-price">${fmtMoney(sumSupply)}</td>
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
        <p class="modal-desc">여기서 저장하면 이 브라우저에서 견적서마다 기본 공급자로 불러옵니다.</p>
        <div class="grid-form modal-grid">
          <div class="field"><label for="modal-bizNo">사업자번호</label><input id="modal-bizNo" data-supplier-f="bizNo" type="text" value="${escapeHtml(s.bizNo)}" /></div>
          <div class="field"><label for="modal-companyName">상호</label><input id="modal-companyName" data-supplier-f="companyName" type="text" value="${escapeHtml(s.companyName)}" /></div>
          <div class="field"><label for="modal-ceo">대표자</label><input id="modal-ceo" data-supplier-f="ceo" type="text" value="${escapeHtml(s.ceo)}" /></div>
          <div class="field"><label for="modal-contact">담당자</label><input id="modal-contact" data-supplier-f="contact" type="text" value="${escapeHtml(s.contact)}" /></div>
          <div class="field"><label for="modal-phone">전화번호</label><input id="modal-phone" data-supplier-f="phone" type="text" value="${escapeHtml(s.phone)}" /></div>
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

function supplierForUi(root) {
  if (root && root._embeddedSupplier != null) {
    return { ...defaultSupplier(), ...root._embeddedSupplier };
  }
  return loadSupplierDefaults();
}

function updateSupplierStrip(root) {
  const el = root.querySelector('#supplier-strip-summary');
  if (!el) return;
  const s = supplierForUi(root);
  const name = (s.companyName || '').trim();
  el.textContent = name || '미설정 · 설정에서 입력';
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

  const linesHtml = state.lines
    .map(
      (_, i) => `
    <tr data-line-row>
      <td><input type="text" data-f="name" data-preview-col="col-name" placeholder="품명" value="${escapeHtml(state.lines[i].name)}" /></td>
      <td class="num"><input type="text" inputmode="decimal" data-f="qty" data-preview-col="col-qty" placeholder="0" value="${escapeHtml(state.lines[i].qty)}" /></td>
      <td class="num"><input type="text" inputmode="decimal" data-f="unitPrice" data-preview-col="col-price" placeholder="0" value="${escapeHtml(state.lines[i].unitPrice)}" /></td>
      <td class="num computed" data-c="supply"></td>
      <td class="num computed" data-c="vat"></td>
      <td class="num computed" data-c="amt"></td>
      <td><button type="button" class="btn btn-ghost btn-remove-line" ${state.lines.length <= 1 ? 'disabled' : ''}>삭제</button></td>
    </tr>`
    )
    .join('');

  root.innerHTML = `
    <div class="page-wrap">
      <h1 class="app-title">견적서 작성</h1>
      <p class="lead">입력하면 오른쪽 미리보기에 바로 반영됩니다. <strong>저장</strong>은 항상 서버로 올라가며, 필수 항목이 비어 있으면 목록에 <strong>미작성</strong>으로 표시됩니다. 공급자는 ⚙에서 저장해 두면 기본으로 적용됩니다.</p>

      <div class="workspace">
        <div class="workspace-main">
          <div class="panel panel-basic">
            <div class="panel-heading-row">
              <h2>기본 정보</h2>
              <button type="button" class="btn btn-gear btn-gear-inline" id="btn-supplier-settings" title="공급자 정보 설정" aria-label="공급자 정보 설정"><span class="gear-icon" aria-hidden="true">⚙</span></button>
            </div>
            <div class="basic-supplier-line">
              <span class="basic-supplier-label">공급자</span>
              <span class="basic-supplier-name" id="supplier-strip-summary">${escapeHtml(supplierSummary)}</span>
            </div>
            <div class="grid-form">
              <div class="field"><label for="dispatchNo">발송번호</label><input id="dispatchNo" data-field="dispatchNo" data-sync-highlight="preview-header-left" type="text" value="${escapeHtml(state.dispatchNo)}" /></div>
              <div class="field"><label for="issueDate">발행일</label><input id="issueDate" data-field="issueDate" data-sync-highlight="preview-header-left" type="date" value="${escapeHtml(state.issueDate)}" /></div>
            </div>
          </div>

          <div class="panel">
            <h2>품목</h2>
            <div class="items-editor">
              <table>
                <thead>
                  <tr>
                    <th>품명</th>
                    <th class="num">수량</th>
                    <th class="num">단가(공급가·VAT별도)</th>
                    <th class="num">공급가액</th>
                    <th class="num">부가세</th>
                    <th class="num">금액</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="lines-body">${linesHtml}</tbody>
              </table>
            </div>
            <div class="row-actions">
              <button type="button" class="btn btn-secondary" id="btn-add-line">행 추가</button>
            </div>
          </div>

          <div class="panel">
            <h2>비고</h2>
            <div class="grid-form">
              <div class="field"><label for="validityDays">유효기간(일)</label><input id="validityDays" data-field="validityDays" data-sync-highlight="preview-footer" type="text" placeholder="예: 30" value="${escapeHtml(state.validityDays)}" /></div>
              <div class="field field-full"><label for="bankAccount">송금계좌</label><input id="bankAccount" data-field="bankAccount" data-sync-highlight="preview-footer" type="text" placeholder="은행명 / 계좌번호" value="${escapeHtml(state.bankAccount)}" /></div>
              <div class="field field-full"><label for="notes">기타</label><textarea id="notes" data-field="notes" data-sync-highlight="preview-footer" placeholder="예: 운반비 별도">${escapeHtml(state.notes)}</textarea></div>
            </div>
          </div>
        </div>

        <aside class="workspace-preview">
          <div class="preview-toolbar panel">
            <button type="button" class="btn btn-primary" id="btn-save">저장</button>
            <button type="button" class="btn btn-primary" id="btn-pdf">PDF</button>
            <button type="button" class="btn btn-secondary" id="btn-png">PNG</button>
            <button type="button" class="btn btn-ghost" id="btn-print">인쇄</button>
            <p class="toolbar-note">
              <strong>저장</strong>은 항상 서버(GitHub <code class="inline-code">quotes/</code>)에 올립니다.
              발송번호·공급자 상호·품목이 채워지면 <strong>완료</strong>, 아니면 <strong>미작성</strong>으로 표시됩니다.
              대시보드에서 연 파일은 같은 이름으로 덮어씁니다.
            </p>
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
    <div class="export-loading" id="export-loading">파일을 만드는 중…</div>
  `;

  root.addEventListener('input', onChange);
  root.addEventListener('change', onChange);

  root.querySelector('#btn-supplier-settings').addEventListener('click', () => openSupplierModal(root));

  root.querySelector('#supplier-save').addEventListener('click', () => {
    const modal = root.querySelector('#supplier-modal');
    const collected = collectSupplierFromModal(modal);
    saveSupplierDefaults(collected);
    root._embeddedSupplier = { ...defaultSupplier(), ...collected };
    updateSupplierStrip(root);
    closeSupplierModal(root);
    onChange();
    alert('공급자 정보를 저장했습니다.');
  });

  ['#supplier-close', '#supplier-modal-x'].forEach((sel) => {
    root.querySelector(sel)?.addEventListener('click', () => closeSupplierModal(root));
  });

  root.querySelector('#supplier-modal').addEventListener('click', (e) => {
    if (e.target.id === 'supplier-modal') closeSupplierModal(root);
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
      <td class="num computed" data-c="vat"></td>
      <td class="num computed" data-c="amt"></td>
      <td><button type="button" class="btn btn-ghost btn-remove-line">삭제</button></td>`;
    tbody.appendChild(tr);
    tr.querySelector('.btn-remove-line').addEventListener('click', () => {
      const rows = tbody.querySelectorAll('[data-line-row]');
      if (rows.length <= 1) return;
      tr.remove();
      onChange();
    });
    onChange();
  });

  root.querySelectorAll('.btn-remove-line').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      const tbody = root.querySelector('#lines-body');
      const rows = tbody.querySelectorAll('[data-line-row]');
      if (rows.length <= 1) return;
      tr.remove();
      onChange();
    });
  });

  root.querySelector('#btn-save').addEventListener('click', async () => {
    const loadingEl = () => document.getElementById('export-loading');
    try {
      assertCloudApiConfigured();
    } catch (err) {
      alert(err.message || String(err));
      return;
    }
    loadingEl()?.classList.add('active');
    try {
      const s = collectStateFromDom(root);
      const fileName = root._cloudQuoteFileName || suggestedQuoteFileName(s);
      const payload = cloudPayloadFromState(s);
      await putCloudQuote(fileName, payload);
      saveState(s);
      if (!root._cloudQuoteFileName) root._cloudQuoteFileName = fileName;
      const stLabel = payload.quoteStatusLabel || (payload.quoteComplete ? '완료' : '미작성');
      alert(`저장했습니다. [${stLabel}]\n${fileName}`);
    } catch (e) {
      alert(`저장에 실패했습니다.\n${e.message || e}`);
    } finally {
      loadingEl()?.classList.remove('active');
    }
  });

  root.querySelector('#btn-print').addEventListener('click', () => {
    window.print();
  });

  root.querySelector('#btn-pdf').addEventListener('click', () => exportPdf(root));
  root.querySelector('#btn-png').addEventListener('click', () => exportPng(root));
}

function updateComputedCells(root) {
  const tbody = root.querySelector('#lines-body');
  if (!tbody) return;
  tbody.querySelectorAll('[data-line-row]').forEach((row) => {
    const qty = row.querySelector('[data-f="qty"]')?.value ?? '';
    const unit = row.querySelector('[data-f="unitPrice"]')?.value ?? '';
    const { supply, vat, amount } = lineComputed(qty, unit);
    const sEl = row.querySelector('[data-c="supply"]');
    const vEl = row.querySelector('[data-c="vat"]');
    const aEl = row.querySelector('[data-c="amt"]');
    if (supply || parseNum(qty) || parseNum(unit)) {
      sEl.textContent = fmtMoney(supply);
      vEl.textContent = fmtMoney(vat);
      aEl.textContent = fmtMoney(amount);
    } else {
      sEl.textContent = '';
      vEl.textContent = '';
      aEl.textContent = '';
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

  const mergedInitial = initialState || loadState();
  mountEl._embeddedSupplier = supplierEmbeddingFromPayload(mergedInitial);

  const state = mergedInitial;

  const refresh = () => {
    const s = collectStateFromDom(mountEl);
    const preserveLineZoom = isTypingPreviewLineItem(mountEl);
    renderQuotePreview(mountEl.querySelector('#quote-print-root'), s);
    if (!preserveLineZoom) stripPreviewZoomTransform(mountEl);
    updateComputedCells(mountEl);
    updateSupplierStrip(mountEl);
    if (!preserveLineZoom) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const ae = document.activeElement;
          if (ae && mountEl.contains(ae)) syncPreviewFocus(mountEl, ae);
        });
      });
    }
    scheduleFitQuotePreview(mountEl);
  };

  renderForm(mountEl, state, refresh);
  refresh();
  fitQuotePreview(mountEl);

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
    const modal = mountEl.querySelector('#supplier-modal');
    if (!modal || modal.classList.contains('is-hidden')) return;
    if (ev.key === 'Escape') closeSupplierModal(mountEl);
  };
  document.addEventListener('keydown', mountEl._supplierEsc);
}

async function fetchDashboardServerRows() {
  const wrap = document.getElementById('server-table-wrap');
  const status = document.getElementById('dashboard-status');
  if (!wrap) return;

  if (!CLOUD_API_BASE) {
    wrap.innerHTML =
      '<p class="dashboard-empty">Worker 주소가 비어 있습니다. HTML에서 window.__EOULRIM_UPLOAD_API__를 설정해 주세요.</p>';
    if (status) status.textContent = '';
    return;
  }

  wrap.innerHTML = '<p class="dashboard-muted">목록 불러오는 중…</p>';
  try {
    const items = await listCloudQuotes();
    if (!items.length) {
      wrap.innerHTML =
        '<p class="dashboard-empty">서버에 저장된 견적이 없습니다. 작성 탭에서 「서버 저장」을 사용해 보세요.</p>';
      if (status) status.textContent = '';
      return;
    }

    const metas = await Promise.all(
      items.map(async (it) => {
        try {
          const data = await getCloudQuote(it.name);
          const savedAt = data.savedAt || data.serverSavedDate || '';
          const issue = data.issueDate || '';
          const dispatch = data.dispatchNo || '';
          const statusLabel = quoteStatusLabelFromPayload(data);
          return { name: it.name, savedAt, issue, dispatch, statusLabel };
        } catch {
          return {
            name: it.name,
            savedAt: '',
            issue: '',
            dispatch: '',
            statusLabel: '—',
            err: true,
          };
        }
      }),
    );

    metas.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));

    const rows = metas
      .map((m) => {
        const title = m.dispatch || m.name.replace(/\.json$/i, '');
        const enc = encodeURIComponent(m.name);
        const stClass =
          m.statusLabel === '미작성'
            ? 'dashboard-status-pill is-incomplete'
            : 'dashboard-status-pill is-complete';
        return `<tr>
            <td><button type="button" class="dashboard-link-btn dashboard-open-cloud" data-quote-file="${enc}">${escapeHtml(title)}</button></td>
            <td class="dashboard-meta"><span class="${stClass}">${escapeHtml(m.statusLabel)}</span></td>
            <td class="dashboard-meta">${escapeHtml(fmtIssueDateKo(m.issue))}</td>
            <td class="dashboard-meta">${escapeHtml(fmtSavedAtKo(m.savedAt))}</td>
            <td class="dashboard-meta muted">${escapeHtml(m.name)}${m.err ? ' (메타 불완전)' : ''}</td>
          </tr>`;
      })
      .join('');

    wrap.innerHTML = `
        <table class="dashboard-table">
          <thead>
            <tr><th>견적</th><th>상태</th><th>발행일</th><th>서버 저장 시각</th><th>파일</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    if (status) status.textContent = '';
  } catch (e) {
    wrap.innerHTML = '<p class="dashboard-empty">서버 목록을 불러오지 못했습니다.</p>';
    if (status) status.textContent = e.message || String(e);
  }
}

function switchMainTab(which) {
  const writeBtn = document.getElementById('tab-write-btn');
  const dashBtn = document.getElementById('tab-dash-btn');
  const panelWrite = document.getElementById('panel-write');
  const panelDash = document.getElementById('panel-dashboard');
  if (!writeBtn || !dashBtn || !panelWrite || !panelDash) return;

  const isWrite = which === 'write';

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
    fetchDashboardServerRows();
  });
  document.getElementById('btn-new-quote')?.addEventListener('click', () => {
    mountApp(document.getElementById('app'), defaultState(), null);
    switchMainTab('write');
  });

  dashPanel?.addEventListener('click', (e) => {
    const openCloud = e.target.closest('.dashboard-open-cloud');
    if (openCloud) {
      const enc = openCloud.getAttribute('data-quote-file');
      const fileName = enc ? decodeURIComponent(enc) : '';
      if (!fileName) return;
      if (!CLOUD_API_BASE) {
        alert('Worker 주소를 설정해 주세요.');
        return;
      }
      getCloudQuote(fileName)
        .then((data) => {
          mountApp(document.getElementById('app'), stateFromCloudPayload(data), {
            cloudFileName: fileName,
          });
          switchMainTab('write');
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
      mountApp(mountEl, stateFromCloudPayload(data), { cloudFileName: cloud });
    } catch (e) {
      alert(`저장된 견적을 불러오지 못했습니다.\n${e.message || e}`);
      mountApp(mountEl);
    }
    switchMainTab('write');
    return;
  }

  mountApp(mountEl);
  switchMainTab(window.location.hash === '#dashboard' ? 'dashboard' : 'write');
}

bootQuoteEditor();
