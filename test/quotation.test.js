const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuotation } = require('../routes/quotations');
const { normalizeQuotationCompanyProfile } = require('../routes/settings');

test('quotation totals are calculated server-side from validated line items', () => {
  const quotation = normalizeQuotation({
    dealerCode: 'd001', customerName: 'Asha Motors', quotationNumber: 'q-101',
    issueDate: '2026-10-21', additionalDiscount: 10,
    items: [{ partNumber: 'ab-1', description: 'Brake pad', quantity: 2, unitPrice: 100, discountRate: 10, taxRate: 18 }]
  });
  assert.equal(quotation.dealerCode, 'D001');
  assert.equal(quotation.quotationNumber, 'Q-101');
  assert.equal(quotation.subtotal, 200);
  assert.equal(quotation.discountAmount, 30);
  assert.equal(quotation.taxableAmount, 170);
  assert.equal(quotation.taxAmount, 30.6);
  assert.equal(quotation.totalAmount, 200.6);
});

test('quotation validation rejects unsafe totals and invalid commercial inputs', () => {
  assert.throws(() => normalizeQuotation({ dealerCode: 'D1', customerName: '', items: [] }), /at least one/);
  assert.throws(() => normalizeQuotation({ dealerCode: 'D1', customerName: 'A', items: [{ description: 'Part', quantity: 0, unitPrice: 1 }] }), /quantity/);
  assert.throws(() => normalizeQuotation({ dealerCode: 'D1', customerName: 'A', issueDate: '2026-10-21', validUntil: '2026-10-20', items: [{ description: 'Part', quantity: 1, unitPrice: 1 }] }), /Valid until/);
});

test('quotation keeps its issuer snapshot and uses it in quotation email content', () => {
  const profile = normalizeQuotationCompanyProfile({
    companyName: 'DAKSH INVENTORY SOLUTION V2',
    addressLine1: 'S-2/63, Deep Nagar, Benad Road,',
    addressLine2: 'Jhotwara, Jaipur, Rajasthan - 302012',
    authorizedSignatory: 'Bineet'
  });
  const quotation = normalizeQuotation({ dealerCode: '10003', customerName: 'Dealer 10003', items: [{ description: 'Audit service', quantity: 1, unitPrice: 100 }] }, { companyProfile: profile });
  assert.deepEqual(quotation.companyProfile, profile);
  const revised = normalizeQuotation({ status: 'SENT' }, { existing: quotation, companyProfile: { companyName: 'Changed company' } });
  assert.deepEqual(revised.companyProfile, profile);
  const { buildQuotationEmail } = require('../routes/quotations');
  assert.match(buildQuotationEmail(quotation).text, /S-2\/63, Deep Nagar/);
  assert.match(buildQuotationEmail(quotation).text, /Bineet/);
});
