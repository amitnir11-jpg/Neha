(function () {
  async function choose(bins, partNumber = '') {
    const options = (bins || []).filter(bin => bin.binLocation && Number(bin.availableQty) > 0);
    if (!options.length) return null;
    const dialog = document.createElement('dialog');
    dialog.className = 'sku-bin-dialog';
    const title = document.createElement('h3');
    title.textContent = `Select source bin${partNumber ? ` for ${partNumber}` : ''}`;
    const message = document.createElement('p');
    message.textContent = 'This barcode identifies the part, not an individual piece. Choose the bin you are taking it from.';
    const form = document.createElement('form');
    form.method = 'dialog';
    const label = document.createElement('label');
    label.textContent = 'Source bin';
    const select = document.createElement('select');
    for (const bin of options) {
      const option = document.createElement('option');
      option.value = bin.binLocation;
      option.textContent = `${bin.binLocation} — ${bin.availableQty} available`;
      select.appendChild(option);
    }
    label.appendChild(select);
    const confirm = document.createElement('button');
    confirm.type = 'submit'; confirm.value = 'confirm'; confirm.textContent = 'Use selected bin'; confirm.className = 'btn btn-primary';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.className = 'btn btn-secondary';
    cancel.addEventListener('click', () => dialog.close('cancel'));
    form.append(label, confirm, cancel);
    dialog.append(title, message, form);
    document.body.appendChild(dialog);
    const result = new Promise(resolve => dialog.addEventListener('close', () => {
      const selected = dialog.returnValue === 'confirm' ? select.value : null;
      dialog.remove(); resolve(selected);
    }, { once: true }));
    dialog.showModal();
    return result;
  }
  window.DakshSkuBinPicker = { choose };
})();
