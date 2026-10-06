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
  if (pathname === '/config.js') { res.setHeader('Content-Type','text/javascript'); res.end('window.DAKSH_CONFIG={appVersion:"2.0.45"};'); return; }
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
      const saves = []; const requests = []; const errors = []; const usedUpi = new Set();
      const user = { id: 'USER-FIXTURE', username: 'fixture', name: 'Test Operator', role, permissions: { canViewReports: true } };
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
        else if (url.pathname==='/api/qr/bins' || url.pathname==='/api/master/bins') data={success:true,bins:[{binCode:'A-01',binLocation:'A-01',dealerCode:'11646'},{binCode:'B-02',binLocation:'B-02',dealerCode:'11646'}]};
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
      assert.equal(await page.locator('#barcodeEntry').getAttribute('class'),'subview active','Scan must open directly on Barcode/Web Scan');
      assert.ok(requests.filter(request=>request.path==='/api/scans/history').every(request=>new URLSearchParams(request.query).get('limit')==='10'));
      await page.locator('[data-subview="barcodeEntry"]').click();
      await page.waitForFunction(()=>document.querySelectorAll('#scanHistoryRows tr').length===10);
      await page.locator('#barcodeScanForm [name="dealerCode"]').selectOption('11646');await page.waitForTimeout(150);assert.equal(await page.locator('#scan .subtab').count(),4);
      assert.equal(await page.locator('#focusScanner').count(),0);
      assert.equal(await page.locator('#barcodePartNumber').isDisabled(),true);
      const raw=page.locator('#barcodeRaw'); const bin=page.locator('#barcodeBinLocation');
      await raw.fill('53155AAW000S');await raw.press('Enter');await page.waitForTimeout(100);assert.equal(saves.length,0);
      await raw.fill('BIN:A-01');await raw.press('Enter');await page.waitForFunction(()=>document.querySelector('#barcodeCurrentBin').textContent==='A-01');
      await bin.fill('B-02');await bin.press('Enter');assert.equal(await page.locator('#barcodeCurrentBin').textContent(),'B-02');await raw.fill('BIN:A-01');await raw.press('Enter');await page.waitForFunction(()=>document.querySelector('#barcodeCurrentBin').textContent==='A-01');const beforeHistory=requests.filter(req=>req.path==='/api/scans/history').length;
      await raw.fill('53155AAW000S');await raw.press('Enter');await page.waitForFunction(()=>document.querySelector('#barcodeReadyStatus').textContent.includes('Saved'));
      assert.equal(saves.length,1);assert.equal(await bin.inputValue(),'A-01');assert.equal(await raw.inputValue(),'');
      assert.equal(await page.locator('#scanHistoryRows tr').count(),10);assert.ok((await page.locator('#scanHistoryRows tr').first().textContent()).includes('53155AAW000S'));
      assert.equal(requests.filter(req=>req.path==='/api/scans/history').length,beforeHistory,'save must not reload history');
      assert.equal(await page.locator('#barcodeScanForm [data-fill="mrp"]').inputValue(),'15');
      for(const type of ['OUTWARD','FITTED','DAMAGE']) {
        await page.locator('#barcodeScanForm [name="type"]').selectOption(type);assert.equal(await bin.inputValue(),'A-01');
        if(type==='FITTED'){await page.locator('#barcodeScanForm [name="regdNo"]').fill('RJ17FS655');await page.locator('#barcodeScanForm [name="jobCardNo"]').fill('JC1234');}
        const count=saves.length;await raw.fill(`PART=14610AAT001S|UPI=${type}001|QTY=1`);await raw.press('Enter');await page.waitForFunction(count=>document.querySelector('#barcodeReadyStatus').textContent.includes('Saved'),count);
        await page.waitForTimeout(220);assert.equal(saves.length,count+1);assert.equal(saves.at(-1).scanType,type);assert.equal(await bin.inputValue(),'A-01');
      }
      await page.locator('#barcodeScanForm [name="type"]').selectOption('INWARD');
      await page.locator('#barcodePartNumber').fill('957010805000S');await page.waitForTimeout(500);assert.equal(await page.locator('#barcodeScanForm [data-fill="partName"]').inputValue(),'BOLT 8X50');await page.locator('#barcodeScanForm [name="qty"]').fill('3');
      const manualCount=saves.length;await page.locator('#saveBarcodeManualScan').click();await page.waitForFunction(()=>document.querySelector('#saveBarcodeManualScan').disabled===false);assert.equal(saves.length,manualCount+1);assert.equal(saves.at(-1).source,'manual');assert.equal(saves.at(-1).qty,3);assert.equal(await bin.inputValue(),'A-01');
      await page.locator('#barcodeBeep').uncheck();const tones=await page.evaluate(()=>window.fixtureToneCount);
      const rapidCount=saves.length;for(const part of ['PART=19510KTP900S|UPI=RAPID1','PART=957010805000S|UPI=RAPID2','PART=14610AAT001S|UPI=RAPID3']){await raw.fill(part);await raw.press('Enter');await page.waitForTimeout(35);}await page.waitForTimeout(750);assert.equal(saves.length,rapidCount+3);assert.equal(await page.evaluate(()=>window.fixtureToneCount),tones);assert.equal(await page.locator('#barcodeScanForm [data-fill="partName"]').inputValue(),'CAM SHAFT');assert.equal(await page.locator('#barcodeScanForm [data-fill="mrp"]').inputValue(),'25');assert.equal(await page.locator('#barcodeScanForm [data-fill="category"]').inputValue(),'ENGINE');
      const invalidCount=saves.length;await raw.fill('!!!');await raw.press('Enter');await page.waitForTimeout(150);assert.equal(saves.length,invalidCount);
      await raw.fill('UNKNOWN123');await raw.press('Enter');await page.waitForTimeout(500);assert.equal(saves.at(-1).partNumber,'UNKNOWN123');
      const dupCount=saves.length;await raw.fill('PART=14610AAT001S|UPI=DUP1');await raw.press('Enter');await page.waitForTimeout(300);await raw.fill('PART=14610AAT001S|UPI=DUP1');await raw.press('Enter');await page.waitForTimeout(200);assert.equal(saves.length,dupCount+1);
      await page.locator('#scanHistoryFilters [name="part"]').fill('53155');await page.locator('#scanHistorySearchBtn').click();await page.waitForTimeout(180);assert.ok(requests.at(-1).query.includes('part=53155'));assert.ok((await page.locator('#scanHistoryRows tr').allTextContents()).every(text=>text.includes('53155AAW000S')));
      await page.locator('#scanHistoryClearBtn').click();await page.waitForTimeout(180);assert.equal(await page.locator('#scanHistoryFilters [name="part"]').inputValue(),'');
      await page.locator('#scanHistoryFilters [name="bin"]').fill('B-0');await page.locator('#scanHistoryFilters [name="type"]').selectOption('OUTWARD');await page.locator('#scanHistorySearchBtn').click();await page.waitForTimeout(200);assert.ok((await page.locator('#scanHistoryRows tr').allTextContents()).every(text=>text.includes('B-02')&&text.includes('OUTWARD')));
      await page.locator('#scanHistoryClearBtn').click();await page.waitForTimeout(180);
      if(role==='admin'){assert.equal(await page.locator('#scanHistoryDeleteSelectedBtn').isVisible(),true);await page.locator('#scanHistoryFilters [name="dealerCode"]').selectOption('11646');await page.waitForTimeout(180);assert.equal(await page.locator('#barcodeScanForm [name="dealerCode"]').inputValue(),'11646');}
      else {assert.equal(await page.locator('#scanHistoryDeleteSelectedBtn').isVisible(),false);assert.equal(await page.locator('#scanHistoryRows option[value="delete"]').count(),0);}
      await raw.fill('BIN:A-01');await raw.press('Enter');await page.waitForTimeout(80);
      await page.evaluate(()=>window.fixtureSocket.handlers['scan:saved']({scanId:'LIVE-FIXTURE',partNumber:'53155AAW000S',partDescription:'LIVE SOCKET PART',scanType:'INWARD',type:'INWARD',qty:1,remainingQty:1,dealerCode:'11646',binLocation:'A-01',bin:'A-01',timestamp:new Date().toISOString(),deviceId:'WEB-FIXTURE'}));
      assert.ok((await page.locator('#scanHistoryRows tr').first().textContent()).includes('LIVE SOCKET PART'));
      await page.locator('#barcodeBeep').check();await page.locator('#clearBarcodeScan').click();await page.waitForTimeout(4500);if(role==='admin')for(const size of [{width:1366,height:768},{width:1440,height:900},{width:1920,height:1080}]){await page.setViewportSize(size);await page.screenshot({path:`.codex-artifacts/barcode-workspace-${size.width}.png`});const fourth=await page.locator('#scanHistoryRows tr').nth(3).boundingBox();results.push({viewport:size,firstFourRowsVisible:fourth.y+fourth.height<=size.height});assert.ok(fourth.y+fourth.height<=size.height,JSON.stringify({fourth,size}));}
      await page.locator('[data-subview="manualEntry"]').click();await page.waitForTimeout(150);assert.equal(await page.locator('.scan-history-table th').count(),18);await page.locator('#scanHistorySelectAll').check();assert.equal(await page.locator('.scan-history-checkbox:checked').count(),await page.locator('.scan-history-checkbox').count());await page.locator('.side-link[data-view="dashboard"]').click();await page.locator('.side-link[data-view="scan"]').click();await page.waitForTimeout(150);assert.equal(await page.locator('#barcodeEntry').getAttribute('class'),'subview active');assert.equal(await page.locator('.scan-history-table th').count(),14);await page.locator('#scanHistorySelectAll').check();assert.equal(await page.locator('.scan-history-checkbox:checked').count(),10);assert.equal(await bin.inputValue(),'A-01');results.push({role,saves:saves.length,consoleErrors:errors,passed:true});assert.deepEqual(errors,[]);
      await context.close();
    }
    fs.writeFileSync('.codex-artifacts/barcode-workspace-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
