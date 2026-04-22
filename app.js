'use strict';

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

// ========== AUTH ==========
const PASS_KEY = 'springs-pass-hash';

async function hashPassword(password) {
  const buf = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showLockPanel(panel) {
  document.getElementById('lock-setup').classList.add('hidden');
  document.getElementById('lock-login').classList.add('hidden');
  document.getElementById(panel).classList.remove('hidden');
}

function showLockError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function hideLockScreen() {
  document.getElementById('lock-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function lockApp() {
  sessionStorage.removeItem('springs-unlocked');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('lock-screen').classList.remove('hidden');
  document.getElementById('login-password').value = '';
  showLockPanel('lock-login');
}

async function setupPassword() {
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-confirm').value;
  if (password.length < 4) { showLockError('lock-error', 'Password must be at least 4 characters.'); return; }
  if (password !== confirm) { showLockError('lock-error', 'Passwords do not match.'); return; }
  const hash = await hashPassword(password);
  localStorage.setItem(PASS_KEY, hash);
  sessionStorage.setItem('springs-unlocked', '1');
  hideLockScreen();
}

async function verifyPassword() {
  const password = document.getElementById('login-password').value;
  const hash = await hashPassword(password);
  if (hash === localStorage.getItem(PASS_KEY)) {
    sessionStorage.setItem('springs-unlocked', '1');
    hideLockScreen();
  } else {
    showLockError('lock-error-login', 'Incorrect password. Please try again.');
    document.getElementById('login-password').value = '';
  }
}

function checkAuth() {
  if (sessionStorage.getItem('springs-unlocked')) { hideLockScreen(); return; }
  const hasPassword = !!localStorage.getItem(PASS_KEY);
  showLockPanel(hasPassword ? 'lock-login' : 'lock-setup');
}

// Allow Enter key on password fields
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (document.getElementById('lock-login') && !document.getElementById('lock-login').classList.contains('hidden')) verifyPassword();
  if (document.getElementById('lock-setup') && !document.getElementById('lock-setup').classList.contains('hidden')) setupPassword();
});

// ========== EXPORT / IMPORT ==========
function exportData() {
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `springs-payroll-backup-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.contractors || !imported.payments || !imported.refunds) {
        alert('Invalid backup file. Please use a file exported from Springs Payroll.');
        return;
      }
      if (confirm(`This will replace all current data with the backup from ${file.name}. Continue?`)) {
        db = imported;
        saveDB();
        renderContractors();
        renderEntry();
        alert('Data imported successfully!');
      }
    } catch {
      alert('Could not read the file. Make sure it is a valid Springs Payroll backup.');
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ========== DATA LAYER ==========
let db = { contractors: [], payments: [], refunds: [] };

function loadDB() {
  const saved = localStorage.getItem('springs-payroll');
  if (saved) db = JSON.parse(saved);
}

function saveDB() {
  localStorage.setItem('springs-payroll', JSON.stringify(db));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ========== HELPERS ==========
function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}

function isQualified(payment) {
  if ('depositThresholdMet' in payment) return !!payment.depositThresholdMet;
  if (!payment.contractValue || payment.contractValue <= 0) return false;
  return (payment.depositAmount / payment.contractValue) >= 0.25;
}

function getCommissionableAmount(payment) {
  if (payment.commissionableAmount !== undefined) return Math.max(0, payment.commissionableAmount);
  return isQualified(payment) ? (payment.cashCollected || 0) : 0;
}

function getDepositPct(payment) {
  if ('depositThresholdMet' in payment) return payment.depositThresholdMet ? 25 : 0;
  if (!payment.contractValue || payment.contractValue <= 0) return 0;
  return (payment.depositAmount / payment.contractValue) * 100;
}

function getPaymentsForMonth(contractorId, month, year) {
  return db.payments.filter(p => {
    if (p.contractorId !== contractorId) return false;
    const d = new Date(p.date + 'T00:00:00');
    return d.getMonth() + 1 === month && d.getFullYear() === year;
  });
}

function getWeekNumber(dateStr, month, year) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  return Math.min(Math.ceil(day / 7), 4);
}

// ========== CALCULATIONS ==========

function calcCommission(contractor, month, year) {
  const payments = getPaymentsForMonth(contractor.id, month, year);
  const totalCash = payments.reduce((s, p) => s + (p.cashCollected || 0), 0);

  if (contractor.type === 'closer') {
    const qualifiedPayments = payments.filter(isQualified);
    const qualifiedCash = qualifiedPayments.reduce((s, p) => s + getCommissionableAmount(p), 0);
    const base = qualifiedCash * 0.10;
    const bumpEligible = totalCash >= 150000;
    const bump = bumpEligible ? totalCash * 0.025 : 0;
    return {
      type: 'closer', base, bump, bumpEligible,
      total: base + bump,
      totalCash, qualifiedCash,
      towardsThreshold: Math.max(0, 150000 - totalCash),
      payments
    };
  } else {
    const qualifiedRegular = payments.filter(p => isQualified(p) && !p.isWeekendSet);
    const qualifiedWeekend = payments.filter(p => isQualified(p) && p.isWeekendSet);
    const regularCash = qualifiedRegular.reduce((s, p) => s + getCommissionableAmount(p), 0);
    const weekendCash = qualifiedWeekend.reduce((s, p) => s + getCommissionableAmount(p), 0);
    const regularComm = regularCash * 0.022;
    const weekendComm = weekendCash * 0.03;
    return {
      type: 'setter',
      regularComm, weekendComm,
      total: regularComm + weekendComm,
      totalCash, regularCash, weekendCash,
      payments
    };
  }
}

function getRefundEntriesForMonth(contractor, month, year) {
  const contractorRefunds = db.refunds.filter(r => r.contractorId === contractor.id);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const nextMonthDay5 = new Date(year, month, 5);

  const entries = [];

  for (const refund of contractorRefunds) {
    const submitted = new Date(refund.submittedDate + 'T00:00:00');
    const approved = refund.approvedDate ? new Date(refund.approvedDate + 'T00:00:00') : null;
    const processed = refund.processedDate ? new Date(refund.processedDate + 'T00:00:00') : null;

    const submittedThisMonth = submitted >= monthStart && submitted <= monthEnd;
    const submittedFirst5Next = submitted > monthEnd && submitted <= nextMonthDay5;
    const approvedThisMonth = approved && approved >= monthStart && approved <= monthEnd;
    const processedThisMonth = processed && processed >= monthStart && processed <= monthEnd;

    const commissionAmount = (refund.saleAmount || 0) * ((refund.rate || 0) / 100);

    // Ticket submitted this month (or first 5 days of next month)
    if (refund.status === 'ticket' && (submittedThisMonth || submittedFirst5Next)) {
      entries.push({
        label: `Refund Ticket: ${refund.description}`,
        amount: -commissionAmount,
        type: 'ticket',
        id: refund.id
      });
    }

    // Approved refund — status changed to approved this month, was submitted in a prior month
    if (refund.status === 'approved' && approvedThisMonth && !submittedThisMonth && !submittedFirst5Next) {
      entries.push({
        label: `Approved Refund: ${refund.description}`,
        amount: -commissionAmount,
        type: 'approved',
        id: refund.id
      });
    }

    // Still pending as approved from a prior period — show continued withholding
    if (refund.status === 'approved' && !approvedThisMonth && submitted < monthStart) {
      entries.push({
        label: `Approved Refund (continued): ${refund.description}`,
        amount: -commissionAmount,
        type: 'approved',
        id: refund.id
      });
    }

    // Processed this month — show negative + offset
    if (refund.status === 'processed' && processedThisMonth) {
      entries.push({
        label: `Processed Refund: ${refund.description}`,
        amount: -commissionAmount,
        type: 'processed-neg',
        id: refund.id
      });
      entries.push({
        label: `Refund Offset: ${refund.description}`,
        amount: commissionAmount,
        type: 'processed-pos',
        id: refund.id
      });
    }
  }

  return entries;
}

function calcBonuses(contractor, month, year) {
  const payments = getPaymentsForMonth(contractor.id, month, year);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const nextMonthDay5 = new Date(year, month, 5);

  // Pre-treatment refunds for bonus deduction (tickets + approved + processed)
  const pretreatmentRefunds = db.refunds.filter(r => {
    if (r.contractorId !== contractor.id) return false;
    const submitted = new Date(r.submittedDate + 'T00:00:00');
    return submitted >= monthStart && submitted <= nextMonthDay5;
  });

  // Group payments by week
  const byWeek = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of payments) {
    const w = getWeekNumber(p.date, month, year);
    byWeek[w].push(p);
  }

  // Group refunds by week
  const refundsByWeek = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of pretreatmentRefunds) {
    const submitted = new Date(r.submittedDate + 'T00:00:00');
    const day = submitted.getDate();
    // First 5 of next month go to week 4
    if (submitted > monthEnd) {
      refundsByWeek[4] += (r.saleAmount || 0);
    } else {
      const w = Math.min(Math.ceil(day / 7), 4);
      refundsByWeek[w] += (r.saleAmount || 0);
    }
  }

  const weeklyBreakdown = [];
  let totalWeeklyBonus = 0;

  for (let w = 1; w <= 4; w++) {
    const weekPayments = byWeek[w];
    const grossCash = weekPayments.reduce((s, p) => s + (p.cashCollected || 0), 0);
    const financingFees = weekPayments.reduce((s, p) => s + (p.financingFee || 0), 0);
    const refundAmt = refundsByWeek[w];
    const netCash = grossCash - financingFees - refundAmt;
    const qualifies = netCash >= 40000;
    const bonus = qualifies ? (contractor.type === 'closer' ? 1000 : 500) : 0;
    totalWeeklyBonus += bonus;

    weeklyBreakdown.push({
      week: w, grossCash, financingFees, refundAmt,
      netCash, qualifies, bonus
    });
  }

  // Monthly bonus for setters
  let monthlyBonus = 0;
  if (contractor.type === 'setter') {
    const totalCash = payments.reduce((s, p) => s + (p.cashCollected || 0), 0);
    if (totalCash >= 100000) monthlyBonus = 1000;
    return { weeklyBreakdown, totalWeeklyBonus, monthlyBonus, totalCash };
  }

  return { weeklyBreakdown, totalWeeklyBonus, monthlyBonus };
}

// ========== RENDER CONTRACTORS ==========
function renderContractors() {
  const tbody = document.getElementById('contractors-tbody');
  if (db.contractors.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-msg" style="padding:20px;text-align:center">No contractors yet. Click "+ Add Contractor" to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = db.contractors.map(c => `
    <tr>
      <td>${c.name}</td>
      <td><span class="badge ${c.type}">${c.type}</span></td>
      <td><button class="btn-sm btn-danger" onclick="deleteContractor('${c.id}')">Delete</button></td>
    </tr>
  `).join('');
}

// ========== RENDER ENTRY ==========
function renderEntry() {
  const month = parseInt(document.getElementById('entry-month').value);
  const year = parseInt(document.getElementById('entry-year').value);
  const body = document.getElementById('entry-body');

  if (db.contractors.length === 0) {
    body.innerHTML = '<p class="empty-msg">Add contractors first on the Contractors tab.</p>';
    return;
  }

  // Global import banner
  const globalBanner = `
    <div class="global-import-bar">
      <span>Import your full spreadsheet (all setters at once):</span>
      <div class="toolbar-actions">
        <button class="btn-sm" onclick="downloadFullTemplate()">Download Template</button>
        <label class="btn-sm btn-primary" style="cursor:pointer">
          Import Full Spreadsheet
          <input type="file" accept=".csv" style="display:none" onchange="importFullSpreadsheet(event)">
        </label>
      </div>
    </div>`;

  body.innerHTML = globalBanner + db.contractors.map(c => {
    const isSetter = c.type === 'setter';
    return `
    <div class="contractor-card">
      <div class="card-header">
        <h3>${c.name}</h3>
        <span class="badge ${c.type}">${c.type}</span>
      </div>

      <div class="card-section">
        <div class="section-toolbar">
          <strong>Payments — ${MONTHS[month - 1]} ${year}</strong>
          <div class="toolbar-actions">
            <button class="btn-sm" onclick="downloadPaymentTemplate(${isSetter})">Download Template</button>
            <label class="btn-sm btn-primary" style="cursor:pointer">
              Import CSV
              <input type="file" accept=".csv" style="display:none" onchange="importPaymentsCSV('${c.id}', ${isSetter}, event)">
            </label>
          </div>
        </div>
        ${renderPaymentsTable(c, month, year)}
      </div>

      <div class="card-section">
        <div class="section-toolbar">
          <strong>Refunds (All)</strong>
          <div class="toolbar-actions">
            <button class="btn-sm" onclick="downloadRefundTemplate()">Download Template</button>
            <label class="btn-sm btn-primary" style="cursor:pointer">
              Import CSV
              <input type="file" accept=".csv" style="display:none" onchange="importRefundsCSV('${c.id}', event)">
            </label>
          </div>
        </div>
        ${renderRefundsTable(c)}
      </div>
    </div>
  `}).join('');
}

function renderPaymentsTable(contractor, month, year) {
  const payments = getPaymentsForMonth(contractor.id, month, year);
  const isSetter = contractor.type === 'setter';
  const nr = `nr-${contractor.id}`;
  const today = new Date().toISOString().slice(0, 10);

  const existingRows = payments.map(p => {
    const depPct = getDepositPct(p).toFixed(1);
    const q = isQualified(p);
    return `
      <tr>
        <td><input class="ss-input" type="date" value="${p.date}" onchange="updatePayment('${p.id}','date',this.value)"></td>
        <td><input class="ss-input" type="number" value="${p.contractValue}" min="0" step="0.01" onchange="updatePayment('${p.id}','contractValue',this.value)"></td>
        <td><input class="ss-input" type="number" value="${p.depositAmount}" min="0" step="0.01" onchange="updatePayment('${p.id}','depositAmount',this.value)"></td>
        <td id="dep-${p.id}" class="${q ? 'text-green' : 'text-red'}" style="white-space:nowrap">${depPct}% ${q ? '✓' : '✗'}</td>
        <td><input class="ss-input" type="number" value="${p.cashCollected}" min="0" step="0.01" onchange="updatePayment('${p.id}','cashCollected',this.value)"></td>
        <td><input class="ss-input" type="number" value="${p.financingFee}" min="0" step="0.01" onchange="updatePayment('${p.id}','financingFee',this.value)"></td>
        ${isSetter ? `<td style="text-align:center"><input type="checkbox" ${p.isWeekendSet ? 'checked' : ''} onchange="updatePayment('${p.id}','isWeekendSet',this.checked)"></td>` : ''}
        <td><button class="btn-sm btn-danger" onclick="deletePayment('${p.id}')">Del</button></td>
      </tr>`;
  }).join('');

  const newRow = `
    <tr class="new-row">
      <td><input class="ss-input" type="date" id="${nr}-date" value="${today}"></td>
      <td><input class="ss-input" type="number" id="${nr}-contract" min="0" step="0.01" placeholder="0.00" oninput="refreshNewRowDeposit('${contractor.id}')"></td>
      <td><input class="ss-input" type="number" id="${nr}-deposit" min="0" step="0.01" placeholder="0.00" oninput="refreshNewRowDeposit('${contractor.id}')"></td>
      <td id="${nr}-dep" class="text-muted">—</td>
      <td><input class="ss-input" type="number" id="${nr}-cash" min="0" step="0.01" placeholder="0.00"></td>
      <td><input class="ss-input" type="number" id="${nr}-fee" min="0" step="0.01" value="0"></td>
      ${isSetter ? `<td style="text-align:center"><input type="checkbox" id="${nr}-weekend"></td>` : ''}
      <td><button class="btn-sm btn-primary" onclick="saveNewPayment('${contractor.id}',${isSetter})">+ Add</button></td>
    </tr>`;

  return `
    <table class="data-table spreadsheet">
      <thead>
        <tr>
          <th>Date</th><th>Contract Value</th><th>Deposit</th><th>Dep %</th>
          <th>Cash Collected</th><th>Financing Fee</th>
          ${isSetter ? '<th>Weekend?</th>' : ''}<th></th>
        </tr>
      </thead>
      <tbody>${existingRows}${newRow}</tbody>
    </table>`;
}

function renderRefundsTable(contractor) {
  const refunds = db.refunds.filter(r => r.contractorId === contractor.id);
  const rr = `rr-${contractor.id}`;
  const today = new Date().toISOString().slice(0, 10);

  const existingRows = refunds.map(r => `
    <tr>
      <td><input class="ss-input" type="text" value="${r.description}" onchange="updateRefundField('${r.id}','description',this.value)"></td>
      <td><input class="ss-input" type="number" value="${r.saleAmount}" min="0" step="0.01" onchange="updateRefundField('${r.id}','saleAmount',this.value)"></td>
      <td><input class="ss-input" type="number" value="${r.rate}" min="0" step="0.01" onchange="updateRefundField('${r.id}','rate',this.value)" style="width:60px"></td>
      <td class="text-red">${fmt(r.saleAmount * r.rate / 100)}</td>
      <td>
        <select onchange="updateRefundStatus('${r.id}',this.value)">
          <option value="ticket" ${r.status==='ticket'?'selected':''}>Refund Ticket</option>
          <option value="approved" ${r.status==='approved'?'selected':''}>Approved</option>
          <option value="processed" ${r.status==='processed'?'selected':''}>Processed</option>
        </select>
      </td>
      <td>${r.submittedDate}</td>
      <td>${r.approvedDate || '—'}</td>
      <td>${r.processedDate || '—'}</td>
      <td><button class="btn-sm btn-danger" onclick="deleteRefund('${r.id}')">Del</button></td>
    </tr>`).join('');

  const newRow = `
    <tr class="new-row">
      <td><input class="ss-input" type="text" id="${rr}-desc" placeholder="Customer / Job name"></td>
      <td><input class="ss-input" type="number" id="${rr}-amount" min="0" step="0.01" placeholder="0.00"></td>
      <td><input class="ss-input" type="number" id="${rr}-rate" min="0" step="0.01" value="${contractor.type==='closer'?10:2.20}" style="width:60px"></td>
      <td class="text-muted">—</td>
      <td>
        <select id="${rr}-status">
          <option value="ticket">Refund Ticket</option>
          <option value="approved">Approved</option>
          <option value="processed">Processed</option>
        </select>
      </td>
      <td><input class="ss-input" type="date" id="${rr}-submitted" value="${today}"></td>
      <td>—</td><td>—</td>
      <td><button class="btn-sm btn-primary" onclick="saveNewRefundRow('${contractor.id}')">+ Add</button></td>
    </tr>`;

  return `
    <table class="data-table spreadsheet">
      <thead>
        <tr>
          <th>Description</th><th>Sale Amount</th><th>Rate %</th>
          <th>Commission Withheld</th><th>Status</th>
          <th>Submitted</th><th>Approved</th><th>Processed</th><th></th>
        </tr>
      </thead>
      <tbody>${existingRows}${newRow}</tbody>
    </table>`;
}

// ========== SPREADSHEET HELPERS ==========
function updatePayment(id, field, value) {
  const p = db.payments.find(p => p.id === id);
  if (!p) return;
  const numFields = ['contractValue','depositAmount','cashCollected','financingFee'];
  p[field] = numFields.includes(field) ? (parseFloat(value) || 0) : (field === 'isWeekendSet' ? value : value);
  saveDB();
  const depCell = document.getElementById(`dep-${id}`);
  if (depCell) {
    const pct = getDepositPct(p).toFixed(1);
    const q = isQualified(p);
    depCell.className = q ? 'text-green' : 'text-red';
    depCell.textContent = `${pct}% ${q ? '✓' : '✗'}`;
  }
}

function refreshNewRowDeposit(contractorId) {
  const prefix = `nr-${contractorId}`;
  const contract = parseFloat(document.getElementById(`${prefix}-contract`)?.value) || 0;
  const deposit = parseFloat(document.getElementById(`${prefix}-deposit`)?.value) || 0;
  const el = document.getElementById(`${prefix}-dep`);
  if (!el) return;
  if (contract > 0) {
    const pct = ((deposit / contract) * 100).toFixed(1);
    const q = deposit / contract >= 0.25;
    el.className = q ? 'text-green' : 'text-red';
    el.textContent = `${pct}% ${q ? '✓' : '✗'}`;
  } else {
    el.className = 'text-muted';
    el.textContent = '—';
  }
}

function saveNewPayment(contractorId, isSetter) {
  const p = `nr-${contractorId}`;
  const date = document.getElementById(`${p}-date`)?.value;
  const contractValue = parseFloat(document.getElementById(`${p}-contract`)?.value) || 0;
  if (!date || contractValue <= 0) { alert('Please enter at least a date and contract value.'); return; }
  db.payments.push({
    id: genId(), contractorId, date,
    contractValue,
    depositAmount: parseFloat(document.getElementById(`${p}-deposit`)?.value) || 0,
    cashCollected: parseFloat(document.getElementById(`${p}-cash`)?.value) || 0,
    financingFee: parseFloat(document.getElementById(`${p}-fee`)?.value) || 0,
    isWeekendSet: isSetter ? (document.getElementById(`${p}-weekend`)?.checked ?? false) : false
  });
  saveDB();
  renderEntry();
}

function updateRefundField(id, field, value) {
  const r = db.refunds.find(r => r.id === id);
  if (!r) return;
  r[field] = ['saleAmount','rate'].includes(field) ? (parseFloat(value) || 0) : value;
  saveDB();
}

function saveNewRefundRow(contractorId) {
  const p = `rr-${contractorId}`;
  const description = document.getElementById(`${p}-desc`)?.value?.trim();
  const saleAmount = parseFloat(document.getElementById(`${p}-amount`)?.value) || 0;
  const rate = parseFloat(document.getElementById(`${p}-rate`)?.value) || 0;
  const status = document.getElementById(`${p}-status`)?.value || 'ticket';
  const submittedDate = document.getElementById(`${p}-submitted`)?.value;
  if (!description || !submittedDate || saleAmount <= 0) { alert('Please fill in description, sale amount, and submitted date.'); return; }
  const today = new Date().toISOString().slice(0, 10);
  db.refunds.push({
    id: genId(), contractorId, description, saleAmount, rate, status, submittedDate,
    approvedDate: (status === 'approved' || status === 'processed') ? today : null,
    processedDate: status === 'processed' ? today : null
  });
  saveDB();
  renderEntry();
}

// ========== CSV IMPORT / EXPORT ==========
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const parseRow = line => {
    const cols = []; let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };
  const headers = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseRow(lines[i]);
    const row = {};
    headers.forEach((h, j) => row[h] = cols[j] || '');
    rows.push(row);
  }
  return { headers, rows };
}

function downloadFullTemplate() {
  const headers = 'Transaction Date,Processor,Offering,Master Email,Master Contract,Contract Sale Date,Amount Paid,Commissionable Amount,Refund Status Approximation,Setter,Deposit Threshold';
  const ex1 = '4/10/2026,UGA NY,Hair,kemique@yahoo.com,kemique45870Stem Kemique Jacobs,8/1/2025,$124.75,$124.75,,Jonah Shilvock,Yes';
  const ex2 = '4/13/2026,PatientFi,Hair,greg.levi@jll.com,greg.le45812Stem Greg Levi,6/4/2025,-$7500.00,-$7500.00,Pre Treatment,Jonah Shilvock,';
  downloadCSV(`${headers}\n${ex1}\n${ex2}\n`, 'springs-payroll-template.csv');
}

function downloadPaymentTemplate(isSetter) {
  downloadFullTemplate();
}

function importFullSpreadsheet(event) {
  const file = event.target.files[0];
  if (!file) return;
  const month = parseInt(document.getElementById('entry-month').value);
  const year = parseInt(document.getElementById('entry-year').value);
  const reader = new FileReader();
  reader.onload = e => {
    const { rows } = parseCSV(e.target.result);
    if (!rows.length) { alert('No data found in the file.'); return; }
    let imported = 0; let refunds = 0; const errors = [];
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const dateRaw = row['Transaction Date'] || row['Date'] || '';
      const setterName = (row['Setter'] || '').trim();
      const amountRaw = (row['Amount Paid'] || '').replace(/[$,]/g, '');
      const commRaw = (row['Commissionable Amount'] || '').replace(/[$,]/g, '');
      const depositThreshold = (row['Deposit Threshold'] || '').toLowerCase().trim() === 'yes';
      const refundStatus = (row['Refund Status Approximation'] || '').trim();
      if (!dateRaw) { errors.push(`Row ${rowNum}: missing date`); return; }
      if (!setterName) { errors.push(`Row ${rowNum}: missing Setter name`); return; }
      const contractor = db.contractors.find(c =>
        c.name.toLowerCase().trim() === setterName.toLowerCase() ||
        c.name.toLowerCase().includes(setterName.toLowerCase()) ||
        setterName.toLowerCase().includes(c.name.toLowerCase())
      );
      if (!contractor) { errors.push(`Row ${rowNum}: setter "${setterName}" not found — add them to Contractors first`); return; }
      const amountPaid = parseFloat(amountRaw) || 0;
      const commissionableAmount = parseFloat(commRaw) || 0;
      const processor = row['Processor'] || '';
      const offering = row['Offering'] || '';
      const clientEmail = row['Master Email'] || '';
      const masterContract = row['Master Contract'] || '';
      const contractSaleDate = row['Contract Sale Date'] || '';
      // Parse date — handle M/D/YYYY format
      const dateObj = new Date(dateRaw);
      const date = isNaN(dateObj) ? dateRaw : dateObj.toISOString().slice(0, 10);
      if (amountPaid < 0) {
        // Negative = refund entry
        db.refunds.push({
          id: genId(), contractorId: contractor.id,
          description: masterContract || clientEmail || `Refund row ${rowNum}`,
          saleAmount: Math.abs(amountPaid),
          rate: contractor.type === 'closer' ? 10 : 2.20,
          status: 'ticket',
          refundStatusApproximation: refundStatus,
          submittedDate: date, approvedDate: null, processedDate: null
        });
        refunds++;
      } else {
        db.payments.push({
          id: genId(), contractorId: contractor.id, date,
          contractValue: 0, depositAmount: 0,
          cashCollected: amountPaid,
          commissionableAmount: Math.abs(commissionableAmount),
          depositThresholdMet: depositThreshold,
          financingFee: 0,
          isWeekendSet: false,
          processor, offering, clientEmail, masterContract, contractSaleDate
        });
        imported++;
      }
    });
    saveDB(); renderEntry();
    let msg = `Imported ${imported} payment(s) and ${refunds} refund(s).`;
    if (errors.length) msg += `\n\nSkipped ${errors.length} row(s):\n` + errors.join('\n');
    alert(msg);
    event.target.value = '';
  };
  reader.readAsText(file);
}

function importPaymentsCSV(contractorId, isSetter, event) {
  // Delegate to full spreadsheet import
  importFullSpreadsheet(event);
}

function downloadRefundTemplate() {
  downloadCSV(
    'Description,Sale Amount,Commission Rate (%),Status,Submitted Date\nJohn Doe Job #123,5000,10,ticket,2026-04-20\n',
    'refunds-template.csv'
  );
}

function importRefundsCSV(contractorId, event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const { rows } = parseCSV(e.target.result);
    if (!rows.length) { alert('No data found in CSV.'); return; }
    let imported = 0; const errors = [];
    const today = new Date().toISOString().slice(0, 10);
    rows.forEach((row, i) => {
      const description = (row['Description'] || row['description'] || '').trim();
      const saleAmount = parseFloat(row['Sale Amount'] || row['sale amount'] || 0);
      if (!description || saleAmount <= 0) { errors.push(`Row ${i + 2}: missing description or sale amount`); return; }
      const status = ['ticket','approved','processed'].includes((row['Status'] || row['status'] || '').toLowerCase().trim())
        ? (row['Status'] || row['status']).toLowerCase().trim() : 'ticket';
      db.refunds.push({
        id: genId(), contractorId, description, saleAmount,
        rate: parseFloat(row['Commission Rate (%)'] || row['Commission Rate'] || row['rate'] || 0),
        status,
        submittedDate: row['Submitted Date'] || row['submitted date'] || today,
        approvedDate: (status === 'approved' || status === 'processed') ? today : null,
        processedDate: status === 'processed' ? today : null
      });
      imported++;
    });
    saveDB(); renderEntry();
    alert(`Imported ${imported} refund(s).${errors.length ? '\n\nSkipped:\n' + errors.join('\n') : ''}`);
    event.target.value = '';
  };
  reader.readAsText(file);
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ========== RENDER SUMMARY ==========
function renderSummary() {
  const month = parseInt(document.getElementById('summary-month').value);
  const year = parseInt(document.getElementById('summary-year').value);
  const body = document.getElementById('summary-body');

  if (db.contractors.length === 0) {
    body.innerHTML = '<p class="empty-msg">No contractors found. Add them on the Contractors tab.</p>';
    return;
  }

  body.innerHTML = db.contractors.map(c => {
    const comm = calcCommission(c, month, year);
    const refundEntries = getRefundEntriesForMonth(c, month, year);
    const bonuses = calcBonuses(c, month, year);

    const totalRefundImpact = refundEntries.reduce((s, e) => s + e.amount, 0);
    const totalBonuses = bonuses.totalWeeklyBonus + bonuses.monthlyBonus;
    const totalPay = comm.total + totalRefundImpact + totalBonuses;

    return `
      <div class="summary-card">
        <div class="card-header">
          <div style="display:flex;align-items:center;gap:8px">
            <h3>${c.name}</h3>
            <span class="badge ${c.type}">${c.type}</span>
          </div>
          <div>
            <div style="font-size:11px;color:#6b7280;text-align:right">${MONTHS[month-1]} ${year}</div>
            <div class="total-pay">${fmt(totalPay)}</div>
          </div>
        </div>

        <div class="summary-grid">
          <!-- Commission Section -->
          <div class="summary-section">
            <h4>Commission</h4>
            ${c.type === 'closer' ? `
              <div class="line-item">
                <span>Qualified Cash</span>
                <span>${fmt(comm.qualifiedCash)}</span>
              </div>
              <div class="line-item">
                <span>Base (10%)</span>
                <span>${fmt(comm.base)}</span>
              </div>
              <div class="line-item ${comm.bumpEligible ? '' : 'text-muted'}">
                <span>2.5% Bump ${comm.bumpEligible ? `(Total: ${fmt(comm.totalCash)})` : `(Need ${fmt(comm.towardsThreshold)} more)`}</span>
                <span>${comm.bumpEligible ? fmt(comm.bump) : '—'}</span>
              </div>
              <div class="line-item total">
                <span>Total Commission</span>
                <span>${fmt(comm.total)}</span>
              </div>
            ` : `
              <div class="line-item">
                <span>Regular Sets Cash</span>
                <span>${fmt(comm.regularCash)}</span>
              </div>
              <div class="line-item">
                <span>Regular (2.20%)</span>
                <span>${fmt(comm.regularComm)}</span>
              </div>
              <div class="line-item">
                <span>Weekend Sets Cash</span>
                <span>${fmt(comm.weekendCash)}</span>
              </div>
              <div class="line-item">
                <span>Weekend (3%)</span>
                <span>${fmt(comm.weekendComm)}</span>
              </div>
              <div class="line-item total">
                <span>Total Commission</span>
                <span>${fmt(comm.total)}</span>
              </div>
            `}
          </div>

          <!-- Refunds Section -->
          <div class="summary-section">
            <h4>Refund Deductions</h4>
            ${refundEntries.length === 0
              ? '<p class="empty-msg">No refund activity this month.</p>'
              : refundEntries.map(e => `
                  <div class="line-item ${e.amount < 0 ? 'text-red' : 'text-green'}">
                    <span>${e.label}</span>
                    <span>${fmt(e.amount)}</span>
                  </div>
                `).join('') + `
                <div class="line-item total">
                  <span>Net Refund Impact</span>
                  <span>${fmt(totalRefundImpact)}</span>
                </div>
              `
            }
          </div>

          <!-- Bonuses Section -->
          <div class="summary-section">
            <h4>Weekly Bonuses (≥$40,000 net)</h4>
            ${bonuses.weeklyBreakdown.map(w => `
              <div class="line-item ${w.qualifies ? '' : 'text-muted'}">
                <span>
                  Week ${w.week}: ${fmt(w.grossCash)} cash
                  ${w.financingFees > 0 ? `− ${fmt(w.financingFees)} fees` : ''}
                  ${w.refundAmt > 0 ? `− ${fmt(w.refundAmt)} refunds` : ''}
                  = ${fmt(w.netCash)}
                  ${w.qualifies ? '✓' : ''}
                </span>
                <span>${w.bonus > 0 ? fmt(w.bonus) : '—'}</span>
              </div>
            `).join('')}
            ${c.type === 'setter' ? `
              <div class="line-item ${bonuses.monthlyBonus > 0 ? '' : 'text-muted'}" style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb">
                <span>Monthly Bonus (${fmt(bonuses.totalCash)} collected${bonuses.monthlyBonus === 0 ? `, need ${fmt(100000 - bonuses.totalCash)} more` : ''})</span>
                <span>${bonuses.monthlyBonus > 0 ? fmt(bonuses.monthlyBonus) : '—'}</span>
              </div>
            ` : ''}
            <div class="line-item total">
              <span>Total Bonuses</span>
              <span>${fmt(totalBonuses)}</span>
            </div>
          </div>
        </div>

        <!-- Final Pay Breakdown -->
        <div class="pay-breakdown">
          <div class="line-item">
            <span>Commission</span>
            <span>${fmt(comm.total)}</span>
          </div>
          <div class="line-item text-red">
            <span>Refund Deductions</span>
            <span>${fmt(totalRefundImpact)}</span>
          </div>
          <div class="line-item">
            <span>Bonuses</span>
            <span>${fmt(totalBonuses)}</span>
          </div>
          <div class="line-item total">
            <span>TOTAL PAY</span>
            <span>${fmt(totalPay)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ========== MODALS ==========
function showModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

function showModal_addContractor() {
  showModal(`
    <h3>Add Contractor</h3>
    <form id="form-add-contractor">
      <div class="form-group">
        <label>Full Name</label>
        <input type="text" id="new-name" required placeholder="e.g. John Smith">
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="new-type">
          <option value="closer">Closer</option>
          <option value="setter">Setter</option>
        </select>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-sm" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Add Contractor</button>
      </div>
    </form>
  `);
  document.getElementById('form-add-contractor').addEventListener('submit', addContractor);
}

function showAddPayment(contractorId) {
  const c = db.contractors.find(c => c.id === contractorId);
  const isSetter = c.type === 'setter';
  const today = new Date().toISOString().slice(0, 10);

  showModal(`
    <h3>Add Payment — ${c.name}</h3>
    <form id="form-add-payment">
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="pay-date" required value="${today}">
      </div>
      <div class="form-group">
        <label>Contract Value ($)</label>
        <input type="number" id="pay-contract" required min="0" step="0.01" placeholder="0.00" oninput="updateDepositIndicator()">
      </div>
      <div class="form-group">
        <label>Deposit Amount ($)</label>
        <input type="number" id="pay-deposit" required min="0" step="0.01" placeholder="0.00" oninput="updateDepositIndicator()">
        <div id="deposit-indicator" class="deposit-indicator" style="display:none;margin-top:6px"></div>
      </div>
      <div class="form-group">
        <label>Cash Collected ($)</label>
        <input type="number" id="pay-cash" required min="0" step="0.01" placeholder="0.00">
      </div>
      <div class="form-group">
        <label>Financing Fee ($)</label>
        <input type="number" id="pay-fee" required min="0" step="0.01" value="0">
      </div>
      ${isSetter ? `
        <div class="checkbox-row">
          <input type="checkbox" id="pay-weekend">
          <label for="pay-weekend">Weekend Set</label>
        </div>
      ` : ''}
      <div class="form-actions">
        <button type="button" class="btn-sm" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Add Payment</button>
      </div>
    </form>
  `);
  document.getElementById('form-add-payment').addEventListener('submit', (e) => addPayment(e, contractorId, isSetter));
}

function updateDepositIndicator() {
  const contract = parseFloat(document.getElementById('pay-contract')?.value) || 0;
  const deposit = parseFloat(document.getElementById('pay-deposit')?.value) || 0;
  const el = document.getElementById('deposit-indicator');
  if (!el) return;

  if (contract > 0) {
    const pct = ((deposit / contract) * 100).toFixed(1);
    const qualified = deposit / contract >= 0.25;
    el.style.display = 'block';
    el.className = `deposit-indicator ${qualified ? 'qualified' : 'not-qualified'}`;
    el.textContent = `Deposit: ${pct}% — ${qualified ? '✓ Qualifies for commission' : '✗ Below 25% threshold — no commission calculated'}`;
  } else {
    el.style.display = 'none';
  }
}

function showAddRefund(contractorId) {
  const c = db.contractors.find(c => c.id === contractorId);
  const defaultRate = c.type === 'closer' ? 10 : 2.20;
  const today = new Date().toISOString().slice(0, 10);

  showModal(`
    <h3>Add Refund — ${c.name}</h3>
    <form id="form-add-refund">
      <div class="form-group">
        <label>Description (customer/job name)</label>
        <input type="text" id="ref-desc" required placeholder="e.g. John Doe - Job #1234">
      </div>
      <div class="form-group">
        <label>Sale Amount ($) — the amount being refunded</label>
        <input type="number" id="ref-amount" required min="0" step="0.01" placeholder="0.00">
      </div>
      <div class="form-group">
        <label>Commission Rate (%)</label>
        <input type="number" id="ref-rate" required min="0" step="0.01" value="${defaultRate}">
        <div class="form-hint">Commission to withhold = Sale Amount × Rate</div>
      </div>
      <div class="form-group">
        <label>Submitted Date</label>
        <input type="date" id="ref-submitted" required value="${today}">
      </div>
      <div class="form-group">
        <label>Initial Status</label>
        <select id="ref-status">
          <option value="ticket">Refund Ticket</option>
          <option value="approved">Approved Refund</option>
          <option value="processed">Processed</option>
        </select>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-sm" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Add Refund</button>
      </div>
    </form>
  `);
  document.getElementById('form-add-refund').addEventListener('submit', (e) => addRefund(e, contractorId));
}

// ========== ACTIONS ==========
function addContractor(e) {
  e.preventDefault();
  db.contractors.push({
    id: genId(),
    name: document.getElementById('new-name').value.trim(),
    type: document.getElementById('new-type').value
  });
  saveDB();
  closeModal();
  renderContractors();
}

function deleteContractor(id) {
  if (!confirm('Delete this contractor and ALL their payment/refund data?')) return;
  db.contractors = db.contractors.filter(c => c.id !== id);
  db.payments = db.payments.filter(p => p.contractorId !== id);
  db.refunds = db.refunds.filter(r => r.contractorId !== id);
  saveDB();
  renderContractors();
}

function addPayment(e, contractorId, isSetter) {
  e.preventDefault();
  db.payments.push({
    id: genId(),
    contractorId,
    date: document.getElementById('pay-date').value,
    contractValue: parseFloat(document.getElementById('pay-contract').value) || 0,
    depositAmount: parseFloat(document.getElementById('pay-deposit').value) || 0,
    cashCollected: parseFloat(document.getElementById('pay-cash').value) || 0,
    financingFee: parseFloat(document.getElementById('pay-fee').value) || 0,
    isWeekendSet: isSetter ? (document.getElementById('pay-weekend')?.checked ?? false) : false
  });
  saveDB();
  closeModal();
  renderEntry();
}

function deletePayment(id) {
  if (!confirm('Delete this payment?')) return;
  db.payments = db.payments.filter(p => p.id !== id);
  saveDB();
  renderEntry();
}

function addRefund(e, contractorId) {
  e.preventDefault();
  const status = document.getElementById('ref-status').value;
  const today = new Date().toISOString().slice(0, 10);
  db.refunds.push({
    id: genId(),
    contractorId,
    description: document.getElementById('ref-desc').value.trim(),
    saleAmount: parseFloat(document.getElementById('ref-amount').value) || 0,
    rate: parseFloat(document.getElementById('ref-rate').value) || 0,
    status,
    submittedDate: document.getElementById('ref-submitted').value,
    approvedDate: status === 'approved' || status === 'processed' ? today : null,
    processedDate: status === 'processed' ? today : null
  });
  saveDB();
  closeModal();
  renderEntry();
}

function updateRefundStatus(id, newStatus) {
  const refund = db.refunds.find(r => r.id === id);
  if (!refund) return;
  const today = new Date().toISOString().slice(0, 10);
  refund.status = newStatus;
  if ((newStatus === 'approved' || newStatus === 'processed') && !refund.approvedDate) {
    refund.approvedDate = today;
  }
  if (newStatus === 'processed' && !refund.processedDate) {
    refund.processedDate = today;
  }
  saveDB();
}

function deleteRefund(id) {
  if (!confirm('Delete this refund entry?')) return;
  db.refunds = db.refunds.filter(r => r.id !== id);
  saveDB();
  renderEntry();
}

// ========== INIT ==========
function initMonthSelectors() {
  const now = new Date();
  ['entry', 'summary'].forEach(prefix => {
    const mSel = document.getElementById(`${prefix}-month`);
    const ySel = document.getElementById(`${prefix}-year`);

    MONTHS.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = i + 1;
      opt.textContent = m;
      if (i + 1 === now.getMonth() + 1) opt.selected = true;
      mSel.appendChild(opt);
    });

    for (let y = 2024; y <= 2030; y++) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      if (y === now.getFullYear()) opt.selected = true;
      ySel.appendChild(opt);
    }
  });
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'entry') renderEntry();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadDB();
  initMonthSelectors();
  initTabs();
  renderContractors();
  checkAuth();

  document.getElementById('btn-add-contractor').addEventListener('click', showModal_addContractor);
  document.getElementById('btn-calculate').addEventListener('click', renderSummary);
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);

  ['entry-month', 'entry-year'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderEntry);
  });

  document.getElementById('modal').addEventListener('click', e => {
    if (e.target.id === 'modal') closeModal();
  });
});
