'use strict';

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

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
  if (!payment.contractValue || payment.contractValue <= 0) return false;
  return (payment.depositAmount / payment.contractValue) >= 0.25;
}

function getDepositPct(payment) {
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
    const qualifiedCash = qualifiedPayments.reduce((s, p) => s + (p.cashCollected || 0), 0);
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
    const regularCash = qualifiedRegular.reduce((s, p) => s + (p.cashCollected || 0), 0);
    const weekendCash = qualifiedWeekend.reduce((s, p) => s + (p.cashCollected || 0), 0);
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

  body.innerHTML = db.contractors.map(c => `
    <div class="contractor-card">
      <div class="card-header">
        <h3>${c.name}</h3>
        <span class="badge ${c.type}">${c.type}</span>
      </div>

      <div class="card-section">
        <div class="section-toolbar">
          <strong>Payments — ${MONTHS[month - 1]} ${year}</strong>
          <button class="btn-sm btn-primary" onclick="showAddPayment('${c.id}')">+ Add Payment</button>
        </div>
        ${renderPaymentsTable(c, month, year)}
      </div>

      <div class="card-section">
        <div class="section-toolbar">
          <strong>Refunds (All)</strong>
          <button class="btn-sm btn-primary" onclick="showAddRefund('${c.id}')">+ Add Refund</button>
        </div>
        ${renderRefundsTable(c)}
      </div>
    </div>
  `).join('');
}

function renderPaymentsTable(contractor, month, year) {
  const payments = getPaymentsForMonth(contractor.id, month, year);
  if (payments.length === 0) return '<p class="empty-msg">No payments this month.</p>';

  const isSetter = contractor.type === 'setter';

  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Contract Value</th>
          <th>Deposit</th>
          <th>Dep %</th>
          <th>Qualified</th>
          <th>Cash Collected</th>
          <th>Financing Fee</th>
          ${isSetter ? '<th>Weekend?</th>' : ''}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${payments.map(p => {
          const depPct = getDepositPct(p).toFixed(1);
          const qualified = isQualified(p);
          return `
            <tr>
              <td>${p.date}</td>
              <td>${fmt(p.contractValue)}</td>
              <td>${fmt(p.depositAmount)}</td>
              <td>${depPct}%</td>
              <td class="${qualified ? 'text-green' : 'text-red'}">${qualified ? '✓ Yes' : '✗ No'}</td>
              <td>${fmt(p.cashCollected)}</td>
              <td>${fmt(p.financingFee)}</td>
              ${isSetter ? `<td>${p.isWeekendSet ? 'Yes' : 'No'}</td>` : ''}
              <td><button class="btn-sm btn-danger" onclick="deletePayment('${p.id}')">Del</button></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderRefundsTable(contractor) {
  const refunds = db.refunds.filter(r => r.contractorId === contractor.id);
  if (refunds.length === 0) return '<p class="empty-msg">No refunds.</p>';

  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>Sale Amount</th>
          <th>Rate</th>
          <th>Commission Withheld</th>
          <th>Status</th>
          <th>Submitted</th>
          <th>Approved</th>
          <th>Processed</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${refunds.map(r => `
          <tr>
            <td>${r.description}</td>
            <td>${fmt(r.saleAmount)}</td>
            <td>${r.rate}%</td>
            <td class="text-red">${fmt(r.saleAmount * r.rate / 100)}</td>
            <td>
              <select onchange="updateRefundStatus('${r.id}', this.value)">
                <option value="ticket" ${r.status === 'ticket' ? 'selected' : ''}>Refund Ticket</option>
                <option value="approved" ${r.status === 'approved' ? 'selected' : ''}>Approved Refund</option>
                <option value="processed" ${r.status === 'processed' ? 'selected' : ''}>Processed</option>
              </select>
            </td>
            <td>${r.submittedDate}</td>
            <td>${r.approvedDate || '—'}</td>
            <td>${r.processedDate || '—'}</td>
            <td><button class="btn-sm btn-danger" onclick="deleteRefund('${r.id}')">Del</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
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
