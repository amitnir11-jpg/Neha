## Issues & Fixes

### 1. Mobile Scanner Camera UI - Remove Black QR Overlay
**Files:** scan.css, scan.html, scan.js
- Remove `.scan-frame` overlay div from HTML
- Remove scan-frame CSS (black overlay, center box, scanning line)
- Set camera to full white background, no boundaries
- Enable full-area detection

### 2. Mobile Scanner Part Number Parsing
**Files:** scan.js
- Fix `parsePartCandidate()` to use backend-compatible logic (UPI slash format, JSON, key=value)
- Remove direct raw text→partNumber assignment without validation
- Add proper UPI/barcode parsing matching `parseRawScan()` in routes/inventory.js

### 3. Real-time Updates After Mobile Scan
**Files:** scan.js, services/SocketRealtimeService.js, routes/sync.js
- After scan success, emit socket events for dashboard refresh
- Auto-refresh last 10 scans, totals, reports

### 4. Barcode Machine Scan Fixes
**Files:** routes/sync.js (pushHandler), routes/mobile.js
- Fix master catalogue lookup in bulk sync path
- Ensure partDescription, category, productGroup are fetched from master
- Fix sync status SUCCESS display

### 5. Performance - Database Indexes
**Files:** prisma/schema.prisma
- Add indexes on dealerCode, partNumber, upiCode, barcode, binLocation, scanStatus, createdAt, category, productGroup

### 6. Performance - Report Loading
**Files:** routes/report.js, routes/reports.js, public/js/app.js
- Ensure pagination is properly implemented
- Reduce duplicate API calls in dashboard init
- Optimize query sizes

### 7. Unified Scan Processing
**Files:** services/ScanProcessingService.js, routes/inventory.js, routes/mobile.js, routes/sync.js
- Ensure all scan paths call through processScan or the same core logic
- processScan should handle mobile QR, mobile barcode, barcode machine, manual entry
