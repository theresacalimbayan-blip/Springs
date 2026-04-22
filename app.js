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
  showLockPanel(localStorage.getItem(PASS_KEY) ? 'lock-login' : 'lock-setup');
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (!document.getElementById('lock-login').classList.contains('hidden')) verifyPassword();
  if (!document.getElementById('lock-setup').classList.contains('hidden')) setupPassword();
});

// ========== DATA ==========
let db = { contractors: [], transactions: [], refunds: [], weekendContracts: [] };

function loadDB() {
  const saved = localStorage.getItem('springs-payroll');
  if (!saved) return;
  const p = JSON.parse(saved);
  db = {
    contractors: p.contractors || [],
    transactions: p.transactions || p.payments || [],
    refunds: p.refunds || [],
    weekendContracts: p.weekendContracts || []
  };
}
function saveDB() { localStorage.setItem('springs-payroll', JSON.stringify(db)); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ========== BACKUP EXPORT / IMPORT ==========
function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `springs-payroll-backup-${new Date().toISOString().slice(0,10)}.json`;
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
      if (!imported.contractors) { alert('Invalid backup file.'); return; }
      if (confirm(`Replace all data with backup from ${file.name}?`)) {
        db = { contractors: imported.contractors || [], transactions: imported.transactions || imported.payments || [], refunds: imported.refunds || [], weekendContracts: imported.weekendContracts || [] };
        saveDB(); renderContractors(); renderEntry();
        alert('Data imported successfully!');
      }
    } catch { alert('Could not read the file.'); }
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ========== HELPERS ==========
function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}
function parseDate(str) {
  if (!str) return null;
  const d = new Date(str + (str.includes('T') ? '' : 'T00:00:00'));
  return isNaN(d) ? null : d;
}
function toISODate(str) {
  if (!str) return '';
  const d = new Date(str);
  return isNaN(d) ? str : d.toISOString().slice(0, 10);
}
function findContractorByName(name) {
  if (!name || ['n/a', 'na', ''].includes(name.toLowerCase().trim())) return null;
  const lower = name.toLowerCase().trim();
  return db.contractors.find(c => c.name.toLowerCase().trim() === lower)
    || db.contractors.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()))
    || null;
}
function getRefundStatus(refund) {
  if (refund.transactionDate && refund.transactionDate.trim()) return 'processed';
  if (!refund.refundTypeCategory || refund.refundTypeCategory.toLowerCase().trim() === 'unknown') return 'ticket';
  return 'approved';
}
function isWeekendContract(masterContract) {
  return db.weekendContracts.some(w => w.masterContractId.toLowerCase().trim() === (masterContract || '').toLowerCase().trim());
}
function getTransactionsForMonth(month, year) {
  return db.transactions.filter(t => {
    const d = parseDate(t.transactionDate);
    return d && d.getMonth() + 1 === month && d.getFullYear() === year;
  }).sort((a, b) => (a.transactionDate || '').localeCompare(b.transactionDate || ''));
}
function getWeekOfMonth(dateStr) {
  const d = parseDate(dateStr);
  return d ? Math.min(Math.ceil(d.getDate() / 7), 4) : 1;
}

// ========== CALCULATIONS ==========
function calcCommission(contractor, month, year) {
  const all = getTransactionsForMonth(month, year);

  if (contractor.type === 'closer') {
    const mine = all.filter(t => t.closerId === contractor.id);
    const totalCash = mine.reduce((s, t) => s + (t.amountPaid || 0), 0);
    const qualifiedCash = mine.filter(t => (t.depositThreshold || '').toLowerCase() === 'yes')
      .reduce((s, t) => s + (t.commissionableAmount || t.amountPaid || 0), 0);
    const base = qualifiedCash * 0.10;
    const bumpEligible = totalCash >= 150000;
    const bump = bumpEligible ? totalCash * 0.025 : 0;
    return { type: 'closer', base, bump, bumpEligible, total: base + bump, totalCash, qualifiedCash, towardsThreshold: Math.max(0, 150000 - totalCash) };
  } else {
    const mine = all.filter(t => t.setterId === contractor.id);
    const qualified = mine.filter(t => (t.depositThreshold || '').toLowerCase() === 'yes');
    const regularCash = qualified.filter(t => !isWeekendContract(t.masterContract)).reduce((s, t) => s + (t.commissionableAmount || t.amountPaid || 0), 0);
    const weekendCash = qualified.filter(t => isWeekendContract(t.masterContract)).reduce((s, t) => s + (t.commissionableAmount || t.amountPaid || 0), 0);
    const totalCash = mine.reduce((s, t) => s + (t.amountPaid || 0), 0);
    return { type: 'setter', regularCash, weekendCash, totalCash, regularComm: regularCash * 0.022, weekendComm: weekendCash * 0.03, total: regularCash * 0.022 + weekendCash * 0.03 };
  }
}

function getRefundDeductionsForMonth(contractor, month, year) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const nextDay5 = new Date(year, month, 5);
  const entries = [];

  const mine = db.refunds.filter(r => r.closerId === contractor.id || r.setterId === contractor.id);

  for (const r of mine) {
    const status = getRefundStatus(r);
    const approveDate = parseDate(r.approveDate);
    const transDate = parseDate(r.transactionDate);
    const weekend = isWeekendContract(r.masterContract);
    const rate = contractor.type === 'closer' ? 0.10 : (weekend ? 0.03 : 0.022);
    const commission = (r.amount || 0) * rate;
    const desc = r.clientName || r.masterContract || 'Refund';

    if (status === 'ticket' && approveDate) {
      const inMonth = approveDate >= monthStart && approveDate <= monthEnd;
      const first5Next = approveDate > monthEnd && approveDate <= nextDay5;
      if (inMonth || first5Next) entries.push({ label: `Refund Ticket: ${desc}`, amount: -commission, type: 'ticket' });
    } else if (status === 'approved' && approveDate && approveDate >= monthStart && approveDate <= monthEnd) {
      entries.push({ label: `Approved Refund: ${desc}`, amount: -commission, type: 'approved' });
    } else if (status === 'processed' && transDate && transDate >= monthStart && transDate <= monthEnd) {
      entries.push({ label: `Processed Refund: ${desc}`, amount: -commission, type: 'processed-neg' });
      entries.push({ label: `Refund Offset: ${desc}`, amount: commission, type: 'processed-pos' });
    }
  }
  return entries;
}

function calcBonuses(contractor, month, year) {
  const all = getTransactionsForMonth(month, year);
  const mine = all.filter(t => contractor.type === 'closer' ? t.closerId === contractor.id : t.setterId === contractor.id);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const nextDay5 = new Date(year, month, 5);

  // Pre-treatment refunds (all statuses) for bonus deduction
  const myRefunds = db.refunds.filter(r => (r.closerId === contractor.id || r.setterId === contractor.id) && (r.refundTypeCategory || '').toLowerCase().includes('pre'));

  const byWeek = { 1: [], 2: [], 3: [], 4: [] };
  mine.forEach(t => { const w = getWeekOfMonth(t.transactionDate); byWeek[w].push(t); });

  const refundsByWeek = { 1: 0, 2: 0, 3: 0, 4: 0 };
  myRefunds.forEach(r => {
    const d = parseDate(r.approveDate);
    if (!d) return;
    if (d > monthEnd && d <= nextDay5) refundsByWeek[4] += (r.amount || 0);
    else if (d >= monthStart && d <= monthEnd) { const w = Math.min(Math.ceil(d.getDate() / 7), 4); refundsByWeek[w] += (r.amount || 0); }
  });

  let totalWeeklyBonus = 0;
  const weeklyBreakdown = [];
  for (let w = 1; w <= 4; w++) {
    const gross = byWeek[w].reduce((s, t) => s + (t.amountPaid || 0), 0);
    const refundAmt = refundsByWeek[w];
    const net = gross - refundAmt;
    const qualifies = net >= 40000;
    const bonus = qualifies ? (contractor.type === 'closer' ? 1000 : 500) : 0;
    totalWeeklyBonus += bonus;
    weeklyBreakdown.push({ week: w, gross, refundAmt, net, qualifies, bonus });
  }

  let monthlyBonus = 0;
  if (contractor.type === 'setter') {
    const totalCash = mine.reduce((s, t) => s + (t.amountPaid || 0), 0);
    if (totalCash >= 100000) monthlyBonus = 1000;
    return { weeklyBreakdown, totalWeeklyBonus, monthlyBonus, totalCash };
  }
  return { weeklyBreakdown, totalWeeklyBonus, monthlyBonus };
}

// ========== CSV PARSER ==========
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
    headers.forEach((h, j) => row[h.trim()] = (cols[j] || '').trim());
    rows.push(row);
  }
  return { headers, rows };
}
function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function col(row, ...names) {
  for (const n of names) { if (row[n] !== undefined && row[n] !== '') return row[n]; }
  return '';
}

// ========== IMPORT: MAIN SPREADSHEET ==========
function downloadMainTemplate() {
  const h = 'Transaction Date,Processor,Offering,Master Email,Master Contract,Contract Sale Date,Amount Paid,Commissionable Amount,Refund Status Approximation,Closer,Setter,Deposit Threshold';
  const r = '4/1/2026,EPD FL,Hair,hkhan7187@gmail.com,anasran46101MSC IAns Rana,3/20/2026,$8500.00,$8500.00,,Alyssa Stilwell,N/A,Yes';
  downloadCSV(`${h}\n${r}\n`, 'springs-main-template.csv');
}
function importMainSpreadsheet(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const { rows } = parseCSV(e.target.result);
    if (!rows.length) { alert('No data found.'); return; }
    let imported = 0; const errors = [];
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const dateRaw = col(row, 'Transaction Date', 'transaction date');
      const masterContract = col(row, 'Master Contract', 'master contract');
      const amountRaw = col(row, 'Amount Paid', 'amount paid').replace(/[$,]/g, '');
      const commRaw = col(row, 'Commissionable Amount', 'commissionable amount').replace(/[$,]/g, '');
      const closerName = col(row, 'Closer', 'closer');
      const setterName = col(row, 'Setter', 'setter', 'Name', 'name');
      const depositThreshold = col(row, 'Deposit Threshold', 'deposit threshold');
      if (!dateRaw) { errors.push(`Row ${rowNum}: missing Transaction Date`); return; }
      const transactionDate = toISODate(dateRaw);
      const amountPaid = parseFloat(amountRaw) || 0;
      const commissionableAmount = parseFloat(commRaw) || Math.abs(amountPaid);
      const closer = findContractorByName(closerName);
      const setter = findContractorByName(setterName);
      if (closerName && !closer) errors.push(`Row ${rowNum}: closer "${closerName}" not found in Contractors`);
      if (setterName && setterName.toLowerCase() !== 'n/a' && !setter) errors.push(`Row ${rowNum}: setter "${setterName}" not found in Contractors`);
      db.transactions.push({
        id: genId(), transactionDate,
        processor: col(row, 'Processor', 'processor'),
        offering: col(row, 'Offering', 'offering'),
        clientEmail: col(row, 'Master Email', 'master email'),
        masterContract,
        contractSaleDate: toISODate(col(row, 'Contract Sale Date', 'contract sale date')),
        amountPaid, commissionableAmount,
        refundStatusApproximation: col(row, 'Refund Status Approximation', 'refund status approximation'),
        closerName, settterName: setterName,
        closerId: closer?.id || null,
        setterId: setter?.id || null,
        depositThreshold: depositThreshold || 'Yes'
      });
      imported++;
    });
    saveDB(); renderEntry();
    alert(`Imported ${imported} transaction(s).${errors.length ? '\n\nNotes:\n' + errors.join('\n') : ''}`);
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ========== IMPORT: WEEKEND SETS ==========
function downloadWeekendTemplate() {
  downloadCSV('Master Contract,Type,Offering\ntmarti346112Stem Tony Martinez,Set on Weekend (3%),Hair\n', 'springs-weekend-sets-template.csv');
}
function importWeekendSets(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const { rows } = parseCSV(e.target.result);
    if (!rows.length) { alert('No data found.'); return; }
    let added = 0;
    rows.forEach(row => {
      const masterContractId = col(row, 'Master Contract', 'master contract', 'Master Contract ID') || Object.values(row)[0] || '';
      if (!masterContractId) return;
      const already = db.weekendContracts.some(w => w.masterContractId.toLowerCase() === masterContractId.toLowerCase());
      if (!already) { db.weekendContracts.push({ masterContractId, offering: col(row, 'Offering', 'offering') }); added++; }
    });
    saveDB();
    alert(`Added ${added} weekend contract(s). Total: ${db.weekendContracts.length}.`);
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ========== IMPORT: REFUNDS ==========
function downloadRefundTemplate() {
  const h = 'Refund Approve,Client Name,Email,Master Contract,Offer,Refund Reason,Processor,Refund Type,Amount,Notes,Closer,Setter,Refund Type,Transaction Date';
  const r = '9/2/2024,Craig Patrick,craigpatrick86@gmail.com,craigpa45531Ere ED,ED,Cancellation,EPD,Pre - Patient Fin,$500.00,Needs to refund,Isaiah Moore,Camden Kross,Pre Treatment,';
  downloadCSV(`${h}\n${r}\n`, 'springs-refunds-template.csv');
}
function importRefunds(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const { rows } = parseCSV(e.target.result);
    if (!rows.length) { alert('No data found.'); return; }
    let imported = 0; const errors = [];
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const masterContract = col(row, 'Master Contract', 'master contract');
      const amountRaw = col(row, 'Amount', 'amount').replace(/[$,]/g, '');
      const amount = Math.abs(parseFloat(amountRaw) || 0);
      if (!masterContract || amount <= 0) { errors.push(`Row ${rowNum}: missing Master Contract or Amount`); return; }
      const closerName = col(row, 'Closer', 'closer');
      const setterName = col(row, 'Setter', 'setter');
      const closer = findContractorByName(closerName);
      const setter = findContractorByName(setterName);
      // Determine status: check second Refund Type column (category)
      const headers = Object.keys(row);
      const refundTypeKeys = headers.filter(h => h.toLowerCase().includes('refund type'));
      const refundTypeSpecific = refundTypeKeys[0] ? row[refundTypeKeys[0]] : '';
      const refundTypeCategory = refundTypeKeys[1] ? row[refundTypeKeys[1]] : '';
      const approveDate = toISODate(col(row, 'Refund Approve', 'refund approve'));
      const transactionDate = toISODate(col(row, 'Transaction Date', 'transaction date'));
      db.refunds.push({
        id: genId(),
        approveDate, clientName: col(row, 'Client Name', 'client name'),
        clientEmail: col(row, 'Email', 'email'),
        masterContract, offering: col(row, 'Offer', 'offer', 'Offering'),
        refundReason: col(row, 'Refund Reason', 'refund reason'),
        processor: col(row, 'Processor', 'processor'),
        refundTypeSpecific, amount,
        notes: col(row, 'Notes', 'notes'),
        closerName, setterName,
        closerId: closer?.id || null,
        setterId: setter?.id || null,
        refundTypeCategory, transactionDate
      });
      imported++;
    });
    saveDB(); renderEntry();
    alert(`Imported ${imported} refund(s).${errors.length ? '\n\nNotes:\n' + errors.join('\n') : ''}`);
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ========== RENDER CONTRACTORS ==========
function renderContractors() {
  const tbody = document.getElementById('contractors-tbody');
  if (!db.contractors.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="padding:20px;text-align:center;color:#9ca3af">No contractors yet. Click "+ Add Contractor" to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = db.contractors.map(c => `
    <tr>
      <td>${c.name}</td>
      <td><span class="badge ${c.type}">${c.type}</span></td>
      <td><button class="btn-sm btn-danger" onclick="deleteContractor('${c.id}')">Delete</button></td>
    </tr>`).join('');
}

// ========== RENDER ENTRY ==========
function renderEntry() {
  const month = parseInt(document.getElementById('entry-month').value);
  const year = parseInt(document.getElementById('entry-year').value);
  const body = document.getElementById('entry-body');

  const importBar = `
    <div class="global-import-bar">
      <div class="import-group">
        <span class="import-label">Main Spreadsheet</span>
        <button class="btn-sm" onclick="downloadMainTemplate()">Template</button>
        <label class="btn-sm btn-primary" style="cursor:pointer">Import
          <input type="file" accept=".csv" style="display:none" onchange="importMainSpreadsheet(event)">
        </label>
      </div>
      <div class="import-group">
        <span class="import-label">Weekend Sets (3%)</span>
        <button class="btn-sm" onclick="downloadWeekendTemplate()">Template</button>
        <label class="btn-sm btn-primary" style="cursor:pointer">Import
          <input type="file" accept=".csv" style="display:none" onchange="importWeekendSets(event)">
        </label>
      </div>
      <div class="import-group">
        <span class="import-label">Refunds</span>
        <button class="btn-sm" onclick="downloadRefundTemplate()">Template</button>
        <label class="btn-sm btn-primary" style="cursor:pointer">Import
          <input type="file" accept=".csv" style="display:none" onchange="importRefunds(event)">
        </label>
      </div>
    </div>`;

  body.innerHTML = importBar + renderTransactionsSection(month, year) + renderRefundsSection();
}

function renderTransactionsSection(month, year) {
  const transactions = getTransactionsForMonth(month, year);
  const today = new Date().toISOString().slice(0, 10);
  const nr = 'nr-txn';

  const rows = transactions.map(t => `
    <tr>
      <td><input class="ss-input" type="date" value="${t.transactionDate||''}" onchange="updateTransaction('${t.id}','transactionDate',this.value)"></td>
      <td><input class="ss-input" type="text" value="${t.processor||''}" onchange="updateTransaction('${t.id}','processor',this.value)" placeholder="—"></td>
      <td><input class="ss-input" type="text" value="${t.offering||''}" onchange="updateTransaction('${t.id}','offering',this.value)" placeholder="—"></td>
      <td><input class="ss-input" type="text" value="${t.clientEmail||''}" onchange="updateTransaction('${t.id}','clientEmail',this.value)" placeholder="—"></td>
      <td><input class="ss-input" type="text" value="${t.masterContract||''}" onchange="updateTransaction('${t.id}','masterContract',this.value)" placeholder="—"></td>
      <td><input class="ss-input" type="date" value="${t.contractSaleDate||''}" onchange="updateTransaction('${t.id}','contractSaleDate',this.value)"></td>
      <td><input class="ss-input" type="number" value="${t.amountPaid||''}" step="0.01" onchange="updateTransaction('${t.id}','amountPaid',parseFloat(this.value)||0)"></td>
      <td><input class="ss-input" type="number" value="${t.commissionableAmount||''}" step="0.01" onchange="updateTransaction('${t.id}','commissionableAmount',parseFloat(this.value)||0)"></td>
      <td><input class="ss-input" type="text" value="${t.refundStatusApproximation||''}" onchange="updateTransaction('${t.id}','refundStatusApproximation',this.value)" placeholder="—"></td>
      <td><input class="ss-input" type="text" value="${t.closerName||''}" onchange="updateTransactionPerson('${t.id}','closer',this.value)" placeholder="—"></td>
      <td><input class="ss-input" type="text" value="${t.settterName||t.setterName||''}" onchange="updateTransactionPerson('${t.id}','setter',this.value)" placeholder="N/A"></td>
      <td>
        <select onchange="updateTransaction('${t.id}','depositThreshold',this.value)">
          <option ${(t.depositThreshold||'').toLowerCase()==='yes'?'selected':''}>Yes</option>
          <option ${(t.depositThreshold||'').toLowerCase()!=='yes'?'selected':''}>No</option>
        </select>
      </td>
      <td><button class="btn-sm btn-danger" onclick="deleteTransaction('${t.id}')">Del</button></td>
    </tr>`).join('');

  const newRow = `
    <tr class="new-row">
      <td><input class="ss-input" type="date" id="${nr}-date" value="${today}"></td>
      <td><input class="ss-input" type="text" id="${nr}-processor" placeholder="Processor"></td>
      <td><input class="ss-input" type="text" id="${nr}-offering" placeholder="Offering"></td>
      <td><input class="ss-input" type="text" id="${nr}-email" placeholder="Master Email"></td>
      <td><input class="ss-input" type="text" id="${nr}-contract" placeholder="Master Contract"></td>
      <td><input class="ss-input" type="date" id="${nr}-saledate"></td>
      <td><input class="ss-input" type="number" id="${nr}-amount" step="0.01" placeholder="Amount Paid"></td>
      <td><input class="ss-input" type="number" id="${nr}-commissionable" step="0.01" placeholder="Commissionable"></td>
      <td><input class="ss-input" type="text" id="${nr}-refundstatus" placeholder="—"></td>
      <td><input class="ss-input" type="text" id="${nr}-closer" placeholder="Closer name"></td>
      <td><input class="ss-input" type="text" id="${nr}-setter" placeholder="Setter / N/A"></td>
      <td><select id="${nr}-threshold"><option>Yes</option><option>No</option></select></td>
      <td><button class="btn-sm btn-primary" onclick="saveNewTransaction()">+ Add</button></td>
    </tr>`;

  return `
    <div class="contractor-card">
      <div class="card-header">
        <h3>Transactions — ${MONTHS[month-1]} ${year}</h3>
        <span style="font-size:12px;color:#6b7280">${transactions.length} record(s)</span>
      </div>
      <div class="card-section">
        <table class="data-table spreadsheet">
          <thead>
            <tr>
              <th>Transaction Date</th><th>Processor</th><th>Offering</th>
              <th>Master Email</th><th>Master Contract</th><th>Contract Sale Date</th>
              <th>Amount Paid</th><th>Commissionable Amount</th>
              <th>Refund Status Approx.</th><th>Closer</th><th>Setter</th>
              <th>Deposit Threshold</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}${newRow}</tbody>
        </table>
      </div>
    </div>`;
}

function renderRefundsSection() {
  const refunds = db.refunds;
  const statusLabel = { ticket: 'Refund Ticket', approved: 'Approved', processed: 'Processed' };
  const statusClass = { ticket: 'badge-ticket', approved: 'badge-approved', processed: 'badge-processed' };

  const rows = refunds.map(r => {
    const status = getRefundStatus(r);
    return `
      <tr class="${status === 'ticket' ? '' : status === 'approved' ? 'approved-row' : 'processed-row'}">
        <td>${r.approveDate || '—'}</td>
        <td>${r.clientName || '—'}</td>
        <td>${r.clientEmail || '—'}</td>
        <td>${r.masterContract || '—'}</td>
        <td>${r.offering || '—'}</td>
        <td>${r.refundReason || '—'}</td>
        <td>${r.processor || '—'}</td>
        <td>${r.refundTypeSpecific || '—'}</td>
        <td class="text-red">${fmt(-(r.amount || 0))}</td>
        <td>${r.notes || '—'}</td>
        <td>${r.closerName || '—'}</td>
        <td>${r.setterName || '—'}</td>
        <td>${r.refundTypeCategory || '—'}</td>
        <td>${r.transactionDate || '—'}</td>
        <td><span class="status-badge ${statusClass[status]}">${statusLabel[status]}</span></td>
        <td><button class="btn-sm btn-danger" onclick="deleteRefund('${r.id}')">Del</button></td>
      </tr>`;
  }).join('');

  const empty = refunds.length === 0 ? '<tr><td colspan="16" style="padding:16px;text-align:center;color:#9ca3af">No refunds imported yet.</td></tr>' : '';

  return `
    <div class="contractor-card" style="margin-top:16px">
      <div class="card-header">
        <h3>Refunds</h3>
        <span style="font-size:12px;color:#6b7280">${refunds.length} record(s)</span>
      </div>
      <div class="card-section">
        <table class="data-table spreadsheet">
          <thead>
            <tr>
              <th>Approve Date</th><th>Client Name</th><th>Email</th>
              <th>Master Contract</th><th>Offering</th><th>Reason</th>
              <th>Processor</th><th>Refund Type</th><th>Amount</th>
              <th>Notes</th><th>Closer</th><th>Setter</th>
              <th>Category</th><th>Processed Date</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}${empty}</tbody>
        </table>
      </div>
    </div>`;
}

// ========== RENDER SUMMARY ==========
function renderSummary() {
  const month = parseInt(document.getElementById('summary-month').value);
  const year = parseInt(document.getElementById('summary-year').value);
  const body = document.getElementById('summary-body');

  if (!db.contractors.length) { body.innerHTML = '<p class="empty-msg">No contractors found.</p>'; return; }

  body.innerHTML = db.contractors.map(c => {
    const comm = calcCommission(c, month, year);
    const refundEntries = getRefundDeductionsForMonth(c, month, year);
    const bonuses = calcBonuses(c, month, year);
    const totalRefund = refundEntries.reduce((s, e) => s + e.amount, 0);
    const totalBonuses = bonuses.totalWeeklyBonus + bonuses.monthlyBonus;
    const totalPay = comm.total + totalRefund + totalBonuses;

    return `
      <div class="summary-card">
        <div class="card-header">
          <div style="display:flex;align-items:center;gap:8px">
            <h3>${c.name}</h3><span class="badge ${c.type}">${c.type}</span>
          </div>
          <div>
            <div style="font-size:11px;color:#6b7280;text-align:right">${MONTHS[month-1]} ${year}</div>
            <div class="total-pay">${fmt(totalPay)}</div>
          </div>
        </div>
        <div class="summary-grid">
          <div class="summary-section">
            <h4>Commission</h4>
            ${c.type === 'closer' ? `
              <div class="line-item"><span>Qualified Cash</span><span>${fmt(comm.qualifiedCash)}</span></div>
              <div class="line-item"><span>Base (10%)</span><span>${fmt(comm.base)}</span></div>
              <div class="line-item ${comm.bumpEligible?'':'text-muted'}">
                <span>2.5% Bump ${comm.bumpEligible?`(Total: ${fmt(comm.totalCash)})`:`(Need ${fmt(comm.towardsThreshold)} more)`}</span>
                <span>${comm.bumpEligible?fmt(comm.bump):'—'}</span>
              </div>
            ` : `
              <div class="line-item"><span>Regular Sets (2.20%)</span><span>${fmt(comm.regularComm)}</span></div>
              <div class="line-item"><span>Weekend Sets (3%)</span><span>${fmt(comm.weekendComm)}</span></div>
            `}
            <div class="line-item total"><span>Total Commission</span><span>${fmt(comm.total)}</span></div>
          </div>
          <div class="summary-section">
            <h4>Refund Deductions</h4>
            ${refundEntries.length === 0
              ? '<p class="empty-msg">No refund activity this month.</p>'
              : refundEntries.map(e => `
                  <div class="line-item ${e.amount < 0 ? 'text-red' : 'text-green'}">
                    <span>${e.label}</span><span>${fmt(e.amount)}</span>
                  </div>`).join('') + `
                <div class="line-item total"><span>Net Refund Impact</span><span>${fmt(totalRefund)}</span></div>`}
          </div>
          <div class="summary-section">
            <h4>Weekly Bonuses (≥$40,000 net)</h4>
            ${bonuses.weeklyBreakdown.map(w => `
              <div class="line-item ${w.qualifies?'':'text-muted'}">
                <span>Week ${w.week}: ${fmt(w.gross)}${w.refundAmt>0?` − ${fmt(w.refundAmt)} refunds`:''} = ${fmt(w.net)} ${w.qualifies?'✓':''}</span>
                <span>${w.bonus>0?fmt(w.bonus):'—'}</span>
              </div>`).join('')}
            ${c.type==='setter'?`
              <div class="line-item ${bonuses.monthlyBonus>0?'':'text-muted'}" style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb">
                <span>Monthly Bonus (${fmt(bonuses.totalCash)} collected${bonuses.monthlyBonus===0?`, need ${fmt(100000-bonuses.totalCash)} more`:''})</span>
                <span>${bonuses.monthlyBonus>0?fmt(bonuses.monthlyBonus):'—'}</span>
              </div>`:''}
            <div class="line-item total"><span>Total Bonuses</span><span>${fmt(totalBonuses)}</span></div>
          </div>
        </div>
        <div class="pay-breakdown">
          <div class="line-item"><span>Commission</span><span>${fmt(comm.total)}</span></div>
          <div class="line-item text-red"><span>Refund Deductions</span><span>${fmt(totalRefund)}</span></div>
          <div class="line-item"><span>Bonuses</span><span>${fmt(totalBonuses)}</span></div>
          <div class="line-item total"><span>TOTAL PAY</span><span>${fmt(totalPay)}</span></div>
        </div>
      </div>`;
  }).join('');
}

// ========== CRUD ==========
function updateTransaction(id, field, value) {
  const t = db.transactions.find(t => t.id === id);
  if (t) { t[field] = value; saveDB(); }
}
function updateTransactionPerson(id, role, name) {
  const t = db.transactions.find(t => t.id === id);
  if (!t) return;
  const contractor = findContractorByName(name);
  if (role === 'closer') { t.closerName = name; t.closerId = contractor?.id || null; }
  else { t.settterName = name; t.setterId = contractor?.id || null; }
  saveDB();
}
function deleteTransaction(id) {
  if (!confirm('Delete this transaction?')) return;
  db.transactions = db.transactions.filter(t => t.id !== id);
  saveDB(); renderEntry();
}
function saveNewTransaction() {
  const p = 'nr-txn';
  const transactionDate = document.getElementById(`${p}-date`)?.value;
  const amountPaid = parseFloat(document.getElementById(`${p}-amount`)?.value) || 0;
  if (!transactionDate || amountPaid === 0) { alert('Please enter a Transaction Date and Amount Paid.'); return; }
  const closerName = document.getElementById(`${p}-closer`)?.value || '';
  const setterName = document.getElementById(`${p}-setter`)?.value || '';
  db.transactions.push({
    id: genId(), transactionDate,
    processor: document.getElementById(`${p}-processor`)?.value || '',
    offering: document.getElementById(`${p}-offering`)?.value || '',
    clientEmail: document.getElementById(`${p}-email`)?.value || '',
    masterContract: document.getElementById(`${p}-contract`)?.value || '',
    contractSaleDate: document.getElementById(`${p}-saledate`)?.value || '',
    amountPaid,
    commissionableAmount: parseFloat(document.getElementById(`${p}-commissionable`)?.value) || amountPaid,
    refundStatusApproximation: document.getElementById(`${p}-refundstatus`)?.value || '',
    closerName, closerId: findContractorByName(closerName)?.id || null,
    settterName: setterName, setterId: findContractorByName(setterName)?.id || null,
    depositThreshold: document.getElementById(`${p}-threshold`)?.value || 'Yes'
  });
  saveDB(); renderEntry();
}
function deleteRefund(id) {
  if (!confirm('Delete this refund?')) return;
  db.refunds = db.refunds.filter(r => r.id !== id);
  saveDB(); renderEntry();
}

// ========== CONTRACTORS CRUD ==========
function showModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
function showModal_addContractor() {
  showModal(`
    <h3>Add Contractor</h3>
    <form id="form-add-contractor">
      <div class="form-group"><label>Full Name</label><input type="text" id="new-name" required placeholder="e.g. John Smith"></div>
      <div class="form-group"><label>Type</label><select id="new-type"><option value="closer">Closer</option><option value="setter">Setter</option></select></div>
      <div class="form-actions">
        <button type="button" class="btn-sm" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Add Contractor</button>
      </div>
    </form>`);
  document.getElementById('form-add-contractor').addEventListener('submit', addContractor);
}
function addContractor(e) {
  e.preventDefault();
  db.contractors.push({ id: genId(), name: document.getElementById('new-name').value.trim(), type: document.getElementById('new-type').value });
  saveDB(); closeModal(); renderContractors();
}
function deleteContractor(id) {
  if (!confirm('Delete this contractor and all their data?')) return;
  db.contractors = db.contractors.filter(c => c.id !== id);
  db.transactions = db.transactions.map(t => {
    if (t.closerId === id) { t.closerId = null; }
    if (t.setterId === id) { t.setterId = null; }
    return t;
  });
  db.refunds = db.refunds.map(r => {
    if (r.closerId === id) r.closerId = null;
    if (r.setterId === id) r.setterId = null;
    return r;
  });
  saveDB(); renderContractors();
}

// ========== INIT ==========
function initMonthSelectors() {
  const now = new Date();
  ['entry', 'summary'].forEach(prefix => {
    const mSel = document.getElementById(`${prefix}-month`);
    const ySel = document.getElementById(`${prefix}-year`);
    MONTHS.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = i + 1; opt.textContent = m;
      if (i + 1 === now.getMonth() + 1) opt.selected = true;
      mSel.appendChild(opt);
    });
    for (let y = 2024; y <= 2030; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
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
  loadDB(); initMonthSelectors(); initTabs(); renderContractors(); checkAuth();
  document.getElementById('btn-add-contractor').addEventListener('click', showModal_addContractor);
  document.getElementById('btn-calculate').addEventListener('click', renderSummary);
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  ['entry-month','entry-year'].forEach(id => document.getElementById(id).addEventListener('change', renderEntry));
  document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
});
