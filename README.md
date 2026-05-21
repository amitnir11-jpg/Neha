# Daksh Inventory v2

Advanced part inventory audit software built with Node.js, Express, MongoDB, Socket.IO, HTML, CSS, JavaScript, ExcelJS, jsPDF, and Nodemailer.

## Installation

1. Install Node.js.
2. Install MongoDB Community Server and keep the MongoDB service running.
3. Open a terminal in `daksh-inventory-v2`.
4. Install dependencies:

```bash
npm install
```

## MongoDB Requirement

The app uses MongoDB only. The default connection is:

```text
mongodb://127.0.0.1:27017/daksh_inventory_v2
```

You can change it in `.env`.

For online hosting, use MongoDB Atlas and set these environment variables in the hosting dashboard:

```text
MONGO_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/daksh_inventory_v2
MONGO_DB_NAME=daksh_inventory_v2
MONGO_SERVER_SELECTION_TIMEOUT_MS=15000
MONGO_CONNECT_TIMEOUT_MS=15000
MONGO_SOCKET_TIMEOUT_MS=45000
MONGO_MAX_POOL_SIZE=20
MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1
MOBILE_DISCOVERY_PORT=3001
JWT_SECRET=replace-with-a-long-random-secret
PUBLIC_BASE_URL=https://your-live-app-url
```

In MongoDB Atlas, create a database user with `readWrite` permission, add the hosting server IP in Network Access, and keep the full `MONGO_URI` secret in the hosting environment variables. Do not put real database passwords in GitHub. `MONGO_DNS_SERVERS` is optional and only needed on networks where Node cannot resolve Atlas `mongodb+srv` records through the default DNS resolver.

The mobile scanner app auto-discovers the PC server on the local network using UDP on `MOBILE_DISCOVERY_PORT`. Keep this port aligned with `PORT` unless you intentionally separate discovery from the HTTP API.

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

After login, the merged production UI opens at:

```text
http://localhost:3000/dashboard
```

This page serves `public/Daksh.html` and contains Dashboard, Scan Management, Reports, Reconciliation, Master Data, QR / Barcode Tools, Device Control, and Admin Settings.

If port `3000` is busy, the server automatically tries the next available port and writes it to `server_port.txt`.

## Run With Batch File

Double-click:

```text
start_daksh.bat
```

The batch file checks Node.js, starts MongoDB service if possible, runs `npm install` when `node_modules` is missing, starts the server, reads `server_port.txt`, opens the browser, and prints local network URLs for mobile scanners.

## Login Details

Default admin:

```text
Username: admin
Password: admin
```

Staff login supports 4-digit PIN users stored in the `users` collection with role `staff` and `pinHash`.

New users can request access from the login page. Admin approval is required before they can login. Admins can create users, approve pending users, block/activate users, update a user's email ID, send an OTP password reset link, or reset a password directly from `Admin Settings`.

Password reset uses email + reset link token + 6-digit OTP. The default official OTP mail ID is:

```text
amitsvision4u@gmail.com
```

Admins can update the OTP mail ID from `Admin Settings > OTP Mail Settings`. Live email delivery requires SMTP settings in `.env`:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
REPORT_EMAIL=amitsvision4u@gmail.com
```

If SMTP credentials are not configured, reset OTPs are written to the server console/log for local setup testing.

## Mobile Scanner URL

Use the local network URL shown in the server console or batch window:

```text
http://YOUR_LOCAL_IP:PORT/dashboard
```

Mobile devices can also auto-connect with:

```http
POST /api/devices/connect
```

## Upload Master

Go to `Dashboard > Master Catalog` and upload an Excel sheet with these columns:

```text
Part No, Part Name, Model, Year, Category, MRP, DLC, Bin, Active Status, Opening Stock Qty
```

The scan screen uses this master for part auto-suggestions and validation.

## Scan

Go to `Dashboard > Scan`.

Supported scan sources:

- Barcode machine scan
- Manual part entry
- Mobile scanner API
- UPI / QR raw scan text

Every scan stores dealer code, audit ID, device ID, staff name, raw scan text, timestamp, sync status, part details, values, and warnings.

Validation checks master existence, MRP mismatch, DLC mismatch, inactive parts, duplicate raw scan, and duplicate part plus dealer plus audit plus timestamp. Admin users can override warnings.

## Download Report

Open `Reports` and use:

- Download Full Report
- Export PDF
- Print Report
- Email Report to Dealer

The Excel report contains all 15 required sheets, including Audit Summary, Final Compile Report, Raw UPI Scan Log, and Dealer Backup Data.

## Email Report

Update `.env` with SMTP settings:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
REPORT_EMAIL=
```

Then use `Email Report to Dealer` from the report page.

## Backup

Go to `Dashboard > Backup`.

Available backup options:

- Download full backup JSON
- Dealer-wise backup
- Date-wise backup
- Restore backup JSON

Restore requires admin login.

## API Summary

All APIs are under `/api` and frontend calls use relative URLs:

- `/api/auth/login`
- `/api/auth/staff-login`
- `/api/auth/register`
- `/api/auth/request-password-reset`
- `/api/auth/reset-password`
- `/api/auth/users`
- `/api/auth/settings`
- `/api/scans/manual`
- `/api/scans/sync`
- `/api/scans/history`
- `/api/inventory/scan`
- `/api/inventory/list`
- `/api/inventory/delete-selected`
- `/api/inventory/delete-all`
- `/api/reports/full`
- `/api/reports/pdf`
- `/api/reports/bin-wise`
- `/api/reports/part-wise`
- `/api/reports/dealer-wise`
- `/api/reports/damage`
- `/api/reports/excess`
- `/api/reports/short`
- `/api/reports/raw-upi`
- `/api/reports/email`
- `/api/dealers`
- `/api/devices/connect`
- `/api/devices/list`
- `/api/devices/disconnect`
- `/api/master/upload`
- `/api/master/parts/upload`
- `/api/master/parts`
- `/api/master/parts/suggest`
- `/api/master/dealers`
- `/api/master/bins`
- `/api/master/search`
- `/api/backup/download`
- `/api/backup/restore`
- `/api/reconciliation`
- `/api/qr/bin`
- `/api/qr/part`
- `/api/qr/bulk-pdf`

## Notes

- No React is used.
- No MySQL is used.
- MongoDB is the only database.
- Socket.IO refreshes scans, devices, and reports in real time.
- Synced scan records are insert-only and never overwritten.
