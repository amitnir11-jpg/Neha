const rules = require('../config/productGroupRules.json');
const { cleanText } = require('./normalize');

function classifyProductGroup(description = '', category = '') {
  const text = `${cleanText(description)} ${cleanText(category)}`.toUpperCase();
  for (const [productGroup, subGroups] of Object.entries(rules)) {
    for (const [partSubGroup, keywords] of Object.entries(subGroups || {})) {
      if ((keywords || []).some((keyword) => text.includes(cleanText(keyword).toUpperCase()))) {
        return { productGroup, partSubGroup };
      }
    }
  }
  return { productGroup: 'OTHERS', partSubGroup: 'GENERAL' };
}

function applyProductGroup(record = {}, { force = false } = {}) {
  const manualGroup = cleanText(record.productGroup).toUpperCase();
  const manualSubGroup = cleanText(record.partSubGroup || record.productSubGroup).toUpperCase();
  if (!force && manualGroup && manualSubGroup) {
    return { productGroup: manualGroup, partSubGroup: manualSubGroup };
  }
  const classified = classifyProductGroup(record.partDescription || record.partName || '', record.productCategory || record.category || '');
  return {
    productGroup: !force && manualGroup ? manualGroup : classified.productGroup,
    partSubGroup: !force && manualSubGroup ? manualSubGroup : classified.partSubGroup
  };
}

module.exports = {
  classifyProductGroup,
  applyProductGroup
};
