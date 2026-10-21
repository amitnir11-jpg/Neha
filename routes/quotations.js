const express = require('express');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const Quotation = require('../models/Quotation');
const auth = require('./auth');
const { readQuotationCompanyProfile, normalizeQuotationCompanyProfile } = require('./settings');

const router = express.Router();
const autoTable = autoTableModule.default || autoTableModule;
const STATUSES = new Set(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED']);
const MAX_ITEMS = 100;

function text(value, limit = 500) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function upper(value) {
  return text(value, 80).toUpperCase();
}

function amount(value, fallback = 0) {
  const parsed = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) {
  return Math.round((amount(value) + Number.EPSILON) * 100) / 100;
}

function date(value, field) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${field} must be a valid date`), { status: 400 });
  return parsed;
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) fail('Add at least one quotation line item');
  if (items.length > MAX_ITEMS) fail(`A quotation can contain at most ${MAX_ITEMS} line items`);
  return items.map((raw, index) => {
    const description = text(raw && (raw.description || raw.partDescription || raw.partNumber), 500);
    if (!description) fail(`Line ${index + 1}: description is required`);
    const quantity = amount(raw && raw.quantity, NaN);
    const unitPrice = amount(raw && (raw.unitPrice ?? raw.price), NaN);
    const taxRate = amount(raw && raw.taxRate, 0);
    const discountRate = amount(raw && raw.discountRate, 0);
    if (!Number.isFinite(quantity) || quantity <= 0) fail(`Line ${index + 1}: quantity must be greater than zero`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) fail(`Line ${index + 1}: unit price cannot be negative`);
    if (taxRate < 0 || taxRate > 100 || discountRate < 0 || discountRate > 100) fail(`Line ${index + 1}: tax and discount must be between 0 and 100`);
    const lineSubtotal = money(quantity * unitPrice);
    const lineDiscount = money(lineSubtotal * discountRate / 100);
    const taxableAmount = money(lineSubtotal - lineDiscount);
    const taxAmount = money(taxableAmount * taxRate / 100);
    return {
      partNumber: upper(raw && raw.partNumber),
      description,
      quantity: money(quantity),
      unit: text(raw && raw.unit, 32) || 'Nos',
      unitPrice: money(unitPrice),
      discountRate: money(discountRate),
      taxRate: money(taxRate),
      lineSubtotal,
      lineDiscount,
      taxableAmount,
      taxAmount,
      lineTotal: money(taxableAmount + taxAmount)
    };
  });
}

function calculate(items, discountAmount = 0) {
  const subtotal = money(items.reduce((sum, item) => sum + item.lineSubtotal, 0));
  const lineDiscount = money(items.reduce((sum, item) => sum + item.lineDiscount, 0));
  const additionalDiscount = money(discountAmount);
  if (additionalDiscount < 0 || additionalDiscount > subtotal - lineDiscount) fail('Discount cannot exceed the item subtotal');
  const beforeAdditionalDiscount = money(subtotal - lineDiscount);
  const ratio = beforeAdditionalDiscount ? (beforeAdditionalDiscount - additionalDiscount) / beforeAdditionalDiscount : 0;
  const taxAmount = money(items.reduce((sum, item) => sum + item.taxAmount * ratio, 0));
  const taxableAmount = money(beforeAdditionalDiscount - additionalDiscount);
  return { subtotal, discountAmount: money(lineDiscount + additionalDiscount), taxableAmount, taxAmount, totalAmount: money(taxableAmount + taxAmount) };
}

function quotationNumber(value) {
  const supplied = upper(value).replace(/[^A-Z0-9/_-]/g, '');
  return supplied || `QT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function normalizeQuotation(input = {}, { existing = null, user = {}, companyProfile = null } = {}) {
  const items = normalizeItems(input.items === undefined && existing ? existing.items : input.items);
  const status = upper(input.status === undefined && existing ? existing.status : input.status) || 'DRAFT';
  if (!STATUSES.has(status)) fail('Invalid quotation status');
  const customerName = text(input.customerName === undefined && existing ? existing.customerName : input.customerName, 200);
  if (!customerName) fail('Customer name is required');
  const issueDate = date(input.issueDate === undefined && existing ? existing.issueDate : input.issueDate, 'Issue date') || new Date();
  const validUntil = date(input.validUntil === undefined && existing ? existing.validUntil : input.validUntil, 'Valid until');
  if (validUntil && validUntil < issueDate) fail('Valid until date cannot be before issue date');
  const extraDiscount = input.additionalDiscount === undefined
    ? Math.max(0, amount(existing && existing.additionalDiscount, 0))
    : amount(input.additionalDiscount, 0);
  const totals = calculate(items, extraDiscount);
  return {
    dealerCode: upper(input.dealerCode === undefined && existing ? existing.dealerCode : input.dealerCode),
    quotationNumber: quotationNumber(input.quotationNumber === undefined && existing ? existing.quotationNumber : input.quotationNumber),
    customerName,
    customerPhone: text(input.customerPhone === undefined && existing ? existing.customerPhone : input.customerPhone, 50),
    customerEmail: text(input.customerEmail === undefined && existing ? existing.customerEmail : input.customerEmail, 200),
    customerAddress: text(input.customerAddress === undefined && existing ? existing.customerAddress : input.customerAddress, 1000),
    status,
    currency: upper(input.currency === undefined && existing ? existing.currency : input.currency) || 'INR',
    issueDate,
    validUntil,
    items,
    additionalDiscount: money(extraDiscount),
    notes: text(input.notes === undefined && existing ? existing.notes : input.notes, 3000),
    terms: text(input.terms === undefined && existing ? existing.terms : input.terms, 3000),
    // Issuer data is a snapshot: editing company settings must never rewrite an
    // already-issued document's legal/branding details.
    companyProfile: existing && existing.companyProfile
      ? normalizeQuotationCompanyProfile(existing.companyProfile)
      : normalizeQuotationCompanyProfile(companyProfile || {}),
    ...totals,
    createdBy: existing ? existing.createdBy : text(user.username || user.name || user.id, 200),
    updatedBy: text(user.username || user.name || user.id, 200)
  };
}

async function assertDealerAccess(req, dealerCode) {
  const access = await auth.validateUserDealerAccess(req.user, dealerCode);
  if (!access.allowed) fail('Unauthorized dealer access', 403);
  return access.requestedDealer;
}

function publicQuotation(row) {
  if (!row) return row;
  const { data = {}, ...columns } = row;
  return { ...data, ...columns, id: row.id || row._id };
}

function emitUpdate(req, action, quotation) {
  const io = req.io || req.app?.get('io');
  if (io) io.emit('quotations:update', { action, id: quotation.id || quotation._id, dealerCode: quotation.dealerCode, status: quotation.status });
}

router.get('/', auth.requireAuth, async (req, res, next) => {
  try {
    const dealerCode = await assertDealerAccess(req, req.query.dealerCode);
    const status = upper(req.query.status);
    const search = text(req.query.search, 200);
    const filter = { dealerCode };
    if (status && status !== 'ALL') filter.status = status;
    if (search) filter.$or = [{ quotationNumber: { $regex: search, $options: 'i' } }, { customerName: { $regex: search, $options: 'i' } }];
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const [rows, totalRows] = await Promise.all([
      Quotation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Quotation.countDocuments(filter)
    ]);
    return res.json({ success: true, quotations: rows.map(publicQuotation), totalRows, pagination: { page, limit, totalPages: Math.max(1, Math.ceil(totalRows / limit)) } });
  } catch (error) { return next(error); }
});

router.post('/', auth.requireAuth, async (req, res, next) => {
  try {
    const dealerCode = await assertDealerAccess(req, req.body && req.body.dealerCode);
    const companyProfile = await readQuotationCompanyProfile();
    const payload = normalizeQuotation({ ...req.body, dealerCode }, { user: req.user, companyProfile });
    const existing = await Quotation.findOne({ dealerCode, quotationNumber: payload.quotationNumber }).lean();
    if (existing) fail('A quotation with this number already exists for this dealer', 409);
    const quotation = publicQuotation(await Quotation.create(payload));
    emitUpdate(req, 'created', quotation);
    return res.status(201).json({ success: true, quotation });
  } catch (error) { return next(error); }
});

router.get('/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const quotation = publicQuotation(await Quotation.findOne({ _id: req.params.id }).lean());
    if (!quotation) fail('Quotation not found', 404);
    await assertDealerAccess(req, quotation.dealerCode);
    return res.json({ success: true, quotation });
  } catch (error) { return next(error); }
});

router.put('/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const current = publicQuotation(await Quotation.findOne({ _id: req.params.id }).lean());
    if (!current) fail('Quotation not found', 404);
    const dealerCode = await assertDealerAccess(req, current.dealerCode);
    const quotation = normalizeQuotation({ ...req.body, dealerCode }, { existing: current, user: req.user });
    if (quotation.quotationNumber !== current.quotationNumber) {
      const duplicate = await Quotation.findOne({ dealerCode, quotationNumber: quotation.quotationNumber }).lean();
      if (duplicate && String(duplicate._id) !== String(current.id)) fail('A quotation with this number already exists for this dealer', 409);
    }
    const saved = publicQuotation(await Quotation.findOneAndUpdate({ _id: req.params.id }, quotation, { new: true }));
    emitUpdate(req, 'updated', saved);
    return res.json({ success: true, quotation: saved });
  } catch (error) { return next(error); }
});

router.delete('/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const quotation = publicQuotation(await Quotation.findOne({ _id: req.params.id }).lean());
    if (!quotation) fail('Quotation not found', 404);
    await assertDealerAccess(req, quotation.dealerCode);
    if (quotation.status === 'ACCEPTED' && !auth.isAdminRole(req.user.role)) fail('Only an administrator may delete an accepted quotation', 403);
    await Quotation.deleteOne({ _id: req.params.id });
    emitUpdate(req, 'deleted', quotation);
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

router.get('/:id/pdf', auth.requireAuth, async (req, res, next) => {
  try {
    const quotation = publicQuotation(await Quotation.findOne({ _id: req.params.id }).lean());
    if (!quotation) fail('Quotation not found', 404);
    await assertDealerAccess(req, quotation.dealerCode);
    const company = quotation.companyProfile
      ? normalizeQuotationCompanyProfile(quotation.companyProfile)
      : await readQuotationCompanyProfile();
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const moneyText = value => `${quotation.currency || 'INR'} ${money(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    doc.setTextColor(18, 52, 91); doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.text(company.companyName, 14, 17);
    doc.setTextColor(65, 65, 65); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text([company.addressLine1, company.addressLine2].filter(Boolean), 14, 23);
    doc.setTextColor(18, 52, 91); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(company.quotationTitle, 196, 17, { align: 'right' });
    doc.setTextColor(65, 65, 65); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(company.quotationSubtitle, 196, 23, { align: 'right', maxWidth: 80 });
    doc.setDrawColor(18, 52, 91); doc.line(14, 36, 196, 36);
    doc.setTextColor(0, 0, 0); doc.setFontSize(9); doc.text(`Quotation No: ${quotation.quotationNumber}`, 14, 44);
    doc.text(`Issue Date: ${new Date(quotation.issueDate).toLocaleDateString('en-IN')}`, 14, 50);
    if (quotation.validUntil) doc.text(`Valid Until: ${new Date(quotation.validUntil).toLocaleDateString('en-IN')}`, 14, 56);
    doc.text(`Status: ${quotation.status}`, 196, 44, { align: 'right' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Bill To', 14, 66); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text([quotation.customerName, quotation.customerPhone, quotation.customerEmail, quotation.customerAddress].filter(Boolean), 14, 72);
    autoTable(doc, { startY: 94, head: [['#', 'Description', 'Qty', 'Rate', 'Tax', 'Amount']], body: quotation.items.map((item, index) => [index + 1, item.description, `${item.quantity} ${item.unit}`, moneyText(item.unitPrice), `${item.taxRate}%`, moneyText(item.lineTotal)]), styles: { fontSize: 8 }, headStyles: { fillColor: [18, 52, 91] }, columnStyles: { 1: { cellWidth: 70 }, 5: { halign: 'right' } } });
    let y = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 150) + 9;
    if (y > 210) { doc.addPage(); y = 25; }
    doc.text(`Subtotal: ${moneyText(quotation.subtotal)}`, 135, y);
    doc.text(`Discount: ${moneyText(quotation.discountAmount)}`, 135, y + 6);
    doc.text(`Tax: ${moneyText(quotation.taxAmount)}`, 135, y + 12);
    doc.setFontSize(12); doc.text(`Total: ${moneyText(quotation.totalAmount)}`, 135, y + 20);
    doc.setFontSize(9); if (quotation.notes) doc.text(`Notes: ${quotation.notes}`, 14, y + 34, { maxWidth: 100 });
    if (quotation.terms) doc.text(`Terms: ${quotation.terms}`, 14, y + 46, { maxWidth: 100 });
    const signatureY = Math.max(y + 42, 245);
    const stampWords = String(company.stampLabel || company.companyName).trim().split(/\s+/).filter(Boolean);
    const stampLines = [stampWords.slice(0, 1).join(' '), stampWords.slice(1, -1).join(' '), stampWords.slice(-1).join(' ')].filter(Boolean);
    doc.setDrawColor(18, 52, 91); doc.setLineWidth(0.6); doc.circle(136, signatureY - 7, 13);
    doc.setFontSize(6); doc.setTextColor(18, 52, 91); stampLines.forEach((line, index) => doc.text(line, 136, signatureY - 10 + (index * 4), { align: 'center' }));
    doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(`For ${company.companyName}`, 196, signatureY + 11, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.text(company.authorizedSignatory, 196, signatureY + 17, { align: 'right' }); doc.text(company.signatoryTitle, 196, signatureY + 22, { align: 'right' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${quotation.quotationNumber}.pdf"`);
    return res.send(Buffer.from(doc.output('arraybuffer')));
  } catch (error) { return next(error); }
});

module.exports = router;
module.exports.normalizeQuotation = normalizeQuotation;
module.exports.calculate = calculate;
module.exports.buildQuotationEmail = function buildQuotationEmail(quotation = {}) {
  const company = normalizeQuotationCompanyProfile(quotation.companyProfile || {});
  return {
    subject: `${company.quotationTitle} ${quotation.quotationNumber || ''}`.trim(),
    text: `${company.companyName}\n${[company.addressLine1, company.addressLine2].filter(Boolean).join('\n')}\n\n${company.quotationTitle}\n${company.quotationSubtitle}\n\nDear ${quotation.customerName || 'Customer'},\nPlease find quotation ${quotation.quotationNumber || ''} attached.\n\nFor ${company.companyName}\n${company.authorizedSignatory}\n${company.signatoryTitle}`
  };
};
