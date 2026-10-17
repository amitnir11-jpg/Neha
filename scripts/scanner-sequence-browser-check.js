const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
fs.mkdirSync('.codex-artifacts', { recursive: true });
const fixtureDealer = { dealerCode: '11646', dealerName: 'SURYA', auditStatus: 'ACTIVE', status: 'ACTIVE' };
const fixtureAudit = { success: true, dealerCode: '11646', auditId: 'AUD-FIXTURE', status: 'ACTIVE' };
const parts = {
  '53155AAW000S': { partNumber: '53155AAW000S', partDescription: 'END STEERING HANDLE', category: 'SHEET METAL', mrp: 15, dlc: 12.38 },
  '14610AAT001S': { partNumber: '14610AAT001S', partDescription: 'CAM SHAFT', category: 'ENGINE', mrp: 25, dlc: 22.5 },
  '957010805000S': { partNumber: '957010805000S', partDescription: 'BOLT 8X50', category: 'FASTENER', mrp: 11, dlc: 9.5 },
  '19510KTP900S': { partNumber: '19510KTP900S', partDescription: 'RADIATOR CAP', category: 'ENGINE', mrp: 120, dlc: 98 }
};
const initialRows = Array.from({ length: 22 }, (_, index) => {
  const part = Object.values(parts)[index % 4];
  return { ...part, _id: `ROW${index}`, uniqueScanId: `ROW${index}`, scanId: `ROW${index}`, qty: index ? 1 : 10, remainingQty: index ? 1 : 10, scanType: ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE'][index % 4], type: ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE'][index % 4], dealerCode: '11646', auditId: fixtureAudit.auditId, dealerName: 'SURYA', binLocation: index % 2 ? 'B-02' : 'A-01', bin: index % 2 ? 'B-02' : 'A-01', deviceId: 'WEB-FIXTURE', timestamp: new Date(Date.now() - (index + 1) * 60000).toISOString(), syncStatus: 'synced', regdNo: index === 2 ? 'RJ17FS655' : '', jobCardNo: index === 2 ? 'JC5678' : '' };
});
const socketScript = `window.fixtureSocket={connected:true,handlers:{},on(event,fn){this.handlers[event]=fn;return this},emit(){},disconnect(){}};window.io=()=>window.fixtureSocket;`;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/socket.io/socket.io.js') { res.setHeader('Content-Type','text/javascript'); res.end(socketScript); return; }
  if (pathname === '/config.js') { res.setHeader('Content-Type','text/javascript'); res.end('window.DAKSH_CONFIG={appVersion:"2.0.47"};'); return; }
  const file = path.resolve('public', pathname === '/dashboard' ? 'Daksh.html' : `.${pathname}`);
  if (!file.startsWith(path.resolve('public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', ({'.css':'text/css','.js':'text/javascript','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'})[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
  const results = [];
  try {
    for (const role of ['admin', 'audit_user']) {
      let rows = initialRows.map(row => ({ ...row }));
      const saves = []; const localSaves = []; const requests = []; const errors = []; const usedUpi = new Set();
      const user = { id: `${role}-USER-FIXTURE`, username: `${role}-fixture`, name: 'Test Operator', role, permissions: { canViewReports: true } };
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(({ user, dealer }) => {
        localStorage.setItem('dakshToken','fixture-token'); localStorage.setItem('dakshUser',JSON.stringify(user));
        localStorage.setItem('dakshAssignedDealers',JSON.stringify([dealer])); localStorage.setItem('dakshActiveDealerId','11646');
        window.fixtureToneCount=0;
        window.AudioContext=class {currentTime=0;destination={};createOscillator(){return {frequency:{setValueAtTime(){}},connect(){},start(){window.fixtureToneCount++},stop(){}}}createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}}};
      }, { user, dealer: fixtureDealer });
      await context.route('**/api/**', async route => {
        const req=route.request(); const url=new URL(req.url()); requests.push({path:url.pathname,query:url.search,method:req.method()});
        let status=200; let data={success:true};
        if (url.pathname==='/api/auth/me') data={success:true,user,assignedDealers:[fixtureDealer],activeDealerId:'11646'};
        else if (url.pathname==='/api/master/dealers') data={success:true,dealers:[fixtureDealer]};
        else if (url.pathname==='/api/audit/active') data=fixtureAudit;
        else if (url.pathname==='/api/scans/dashboard') data={success:true,dealerCode:'11646',activeAudit:fixtureAudit,stats:{dealerCode:'11646',partsScanned:22,totalScans:22},recent:rows.slice(0,10)};
        else if (url.pathname==='/api/scans/live') data={success:true,scans:rows.slice(0,10),bins:[]};
        else if (url.pathname==='/api/health') data={success:true,status:'OK',ready:true,server:'online',databaseStatus:'connected'};
        else if (url.pathname==='/api/sync/status') data={success:true,server:'online',db:'connected',connectedDevices:0,pending:0,failed:0,totalSynced:22};
        else if (url.pathname==='/api/settings/smart-bin-suggestion') data={success:true,settings:{enabled:false}};
        else if (url.pathname==='/api/local-parts' && req.method()==='POST') {
          const payload=req.postDataJSON();localSaves.push(payload);
          data={success:true,message:'Local Part saved successfully',entry:{...payload,id:`LOCAL${localSaves.length}`}};
        }
        else if (url.pathname==='/api/local-parts' && req.method()==='GET') data={success:true,entries:localSaves.map((entry,index)=>({...entry,id:`LOCAL${index+1}`,status:'ACTIVE',referenceAuditId:fixtureAudit.auditId,totalMrpValue:Number(entry.quantity)*Number(entry.mrp),totalDlcValue:Number(entry.quantity)*Number(entry.dlc)})),pagination:{page:1,totalPages:1},summary:{grandTotalQuantity:localSaves.reduce((sum,entry)=>sum+Number(entry.quantity),0),grandTotalMrpValue:localSaves.reduce((sum,entry)=>sum+Number(entry.quantity)*Number(entry.mrp),0),grandTotalDlcValue:localSaves.reduce((sum,entry)=>sum+Number(entry.quantity)*Number(entry.dlc),0)}};
        else if (url.pathname==='/api/qr/bins' || url.pathname==='/api/master/bins') data={success:true,bins:[{binCode:'A-01',binLocation:'A-01',dealerCode:'11646'},{binCode:'B-02',binLocation:'B-02',dealerCode:'11646'}]};
        else if (url.pathname==='/api/scans/validate-bin') data={success:true,valid:['A-01','B-02'].includes(url.searchParams.get('binLocation'))};
        else if (url.pathname==='/api/scans/set-bin' && req.method()==='POST') data={success:true,valid:true,binLocation:req.postDataJSON().binLocation};
        else if (url.pathname==='/api/scans/resolve-code') {
          if (url.searchParams.get('entryMode') !== 'manual' && !require('../utils/scanParser').validateScannerSequence(url.searchParams.get('rawValue')).valid) {
            status=422; data={success:false,code:'INVALID_SCANNER_SEQUENCE',message:require('../utils/scanParser').invalidScannerSequenceMessage};
          } else data={success:true,binOptions:[{binLocation:'A-01',availableQty:100},{binLocation:'B-02',availableQty:100}]};
        }
        else if (url.pathname==='/api/scans/part-summary') {
          const partNumber=url.searchParams.get('partNumber');const partRows=rows.filter(row=>row.partNumber===partNumber);
          const quantity=type=>partRows.filter(row=>(row.scanType||row.type)===type).reduce((sum,row)=>sum+Number(row.qty||row.quantity||0),0);
          const inwardQty=quantity('INWARD'),outwardQty=quantity('OUTWARD'),fittedQty=quantity('FITTED'),damageQty=quantity('DAMAGE');
          data={success:true,partNumber,inwardQty,outwardQty,fittedQty,damageQty,availableQty:inwardQty-outwardQty-damageQty};
        }
        else if (url.pathname==='/api/mobile/validate-part') {const part=parts[url.searchParams.get('partNumber')];data={success:true,found:!!part,...part};}
        else if (url.pathname==='/api/master/parts/suggest') data={success:true,suggestions:Object.values(parts).filter(part=>part.partNumber.includes((url.searchParams.get('q')||'').toUpperCase()))};
        else if (url.pathname==='/api/scans/history') {
          let filtered=rows.filter(row=>(!url.searchParams.get('part') || row.partNumber.toUpperCase().includes(url.searchParams.get('part').toUpperCase())) && (!url.searchParams.get('bin') || row.binLocation.includes(url.searchParams.get('bin').toUpperCase())) && (!url.searchParams.get('type') || row.scanType===url.searchParams.get('type')) && (!url.searchParams.get('dealerCode') || row.dealerCode===url.searchParams.get('dealerCode')));
          const limit=Number(url.searchParams.get('limit')||100),page=Number(url.searchParams.get('page')||1);
          data={success:true,records:filtered.slice((page-1)*limit,page*limit),pagination:{page,limit,totalRows:filtered.length,totalPages:Math.ceil(filtered.length/limit)},summary:{netAvailableQuantity:13}};
        } else if (url.pathname==='/api/scans/process') {
          const payload=req.postDataJSON(); saves.push(payload);
          await new Promise(resolve=>setTimeout(resolve,180));
          if (!parts[payload.partNumber]) {status=422;data={success:false,message:'Part not found in Part Master'};}
          else if (payload.upiId && usedUpi.has(payload.upiId)) {status=409;data={success:false,duplicate:true,message:'Duplicate UPI'};}
          else {if(payload.upiId)usedUpi.add(payload.upiId);const part=parts[payload.partNumber];const scan={...payload,...part,_id:`SAVE${saves.length}`,scanType:payload.type,type:payload.type,binLocation:payload.binLocation,bin:payload.binLocation,syncStatus:'synced',timestamp:new Date().toISOString(),remainingQty:payload.qty};rows.unshift(scan);data={success:true,status:'synced',scan};}
        }
        await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error' && !message.text().includes('Failed to load resource'))errors.push(message.text());});page.on('dialog',dialog=>dialog.accept());
      await page.goto(origin+'/dashboard?view=scan');
      await page.waitForFunction(()=>window.__DAKSH_DASHBOARD_BOOT__?.markers.some(marker=>marker.label==='DOMContentLoaded startup complete'));

      await page.locator('#barcodeScanForm [name="dealerCode"]').selectOption('11646', {force:true});
      const raw = page.locator('#barcodeRaw');
      const bin = page.locator('#barcodeBinLocation');
      await bin.fill('A-01'); await bin.press('Enter');
      await page.waitForFunction(()=>!document.querySelector('#barcodeRaw').disabled);
      const originalRows = rows.length;
      for (const type of ['INWARD', 'OUTWARD', 'DAMAGE', 'FITTED']) {
        await page.locator('#barcodeScanForm [name="type"]').selectOption(type, {force:true});
        if (await raw.isDisabled()) {
          await bin.fill('A-01'); await bin.press('Enter');
          await page.waitForFunction(()=>!document.querySelector('#barcodeRaw').disabled);
        }
        for (const value of ['20K211S', '20K411S', '41241AAN410S', 'D/TEST/UPI/PART/BAD/PRICE/A/1/G/000/00']) {
          await raw.fill(value); await raw.press('Enter');
          await page.waitForFunction(()=>document.querySelector('#barcodeRaw').value==='');
          assert.equal(saves.length, 0, type+': invalid input must not send a save');
          assert.equal(rows.length, originalRows, 'History is unchanged');
          assert.ok((await page.locator('body').innerText()).includes('Invalid Barcode / QR Sequence'));
        }
      }
      await page.locator('#barcodeScanForm [name="type"]').selectOption('INWARD', {force:true});
      await bin.fill('A-01'); await bin.press('Enter');
      await page.waitForFunction(()=>!document.querySelector('#barcodeRaw').disabled);
      await raw.fill('53155AAW000S/G3223000065001'); await raw.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#barcodeReadyStatus').textContent.includes('Saved'));
      assert.equal(saves.length, 1);
      assert.equal(saves[0].partNumber, '53155AAW000S');
      assert.equal(Number(saves[0].quantity ?? saves[0].qty), 1);
      await raw.fill('D/TEST0000000002/TESTUPI00002/14610AAT001S     /000004/0000010.00/AAA/1/G/000/00');
      await raw.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#barcodeReadyStatus').textContent.includes('Saved') && document.querySelector('#barcodeRaw').value==='');
      await page.waitForTimeout(300);
      assert.equal(saves.length, 2);
      assert.equal(Number(saves[1].quantity ?? saves[1].qty), 4);
      const manualCount = saves.length;
      await page.locator('#barcodePartNumber').fill('53155AAW000S');
      await page.locator('[form="barcodeScanForm"][name="qty"]').fill('2');
      await page.locator('#saveBarcodeManualScan').click();
      await page.waitForTimeout(650);
      assert.equal(saves.length, manualCount + 1, 'Manual Entry continues to accept a part number');
      assert.equal(saves.at(-1).source, 'manual');
      assert.equal(saves.at(-1).rawScan || '', '');
      assert.deepEqual(errors, []);
      await page.screenshot({path:'.codex-artifacts/scanner-validation-desktop-'+role+'.png'});
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:'.codex-artifacts/scanner-validation-mobile-'+role+'.png'});
      results.push({role,invalidSaveRequests:0,valid1DQuantity:1,validQRQuantity:4,manualEntry:true,passed:true});
      await context.close();
    }
    fs.writeFileSync('.codex-artifacts/scanner-browser-results.json',JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); server.close(); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
