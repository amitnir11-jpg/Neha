# Daksh Inventory v2

Node.js, Express, Prisma, Railway PostgreSQL, Socket.IO, HTML/CSS/JavaScript, ExcelJS, jsPDF, and Nodemailer inventory audit software.

## Railway Project Layout

Create one Railway project with three services:

- `daksh-postgres`: Railway PostgreSQL database
- `daksh-api`: backend API service from this repo
- `daksh-web`: static web app service from this repo

Use the same GitHub repo for `daksh-api` and `daksh-web`.

## Railway Variables

API service:

```text
DAKSH_SERVICE_ROLE=api
DAKSH_DEPLOY_TARGET=railway
NODE_ENV=production
DATABASE_URL=${{daksh-postgres.DATABASE_URL}}
PUBLIC_BASE_URL=https://your-web-service.up.railway.app
JWT_SECRET=<long-random-secret>
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=<strong-password>
```

If the Railway PostgreSQL service exposes a differently named URL, the API also accepts:

```text
DATABASE_PRIVATE_URL
DATABASE_PUBLIC_URL
POSTGRES_URL
POSTGRES_PRIVATE_URL
POSTGRES_PUBLIC_URL
POSTGRES_DATABASE_URL
POSTGRES_PRISMA_URL
POSTGRES_URL_NON_POOLING
PGDATABASE_URL
PG_URL
PGURL
RAILWAY_DATABASE_URL
PGHOST + PGPORT + PGUSER + PGPASSWORD + PGDATABASE
```

Web service:

```text
DAKSH_SERVICE_ROLE=web
DAKSH_DEPLOY_TARGET=railway
NODE_ENV=production
PUBLIC_API_BASE_URL=https://your-api-service.up.railway.app
PUBLIC_BASE_URL=https://your-web-service.up.railway.app
```

Both services can use:

```text
npm run build
npm start
```

`npm start` uses `DAKSH_SERVICE_ROLE` to boot either the API or web service. For deployed API services it runs `prisma migrate deploy` before opening the server. If PostgreSQL is missing or migrations fail, startup exits and Railway will not mark the service ready.

## Database

The backend connects only through Railway PostgreSQL `DATABASE_URL`.

```bash
npm run prisma:generate
npm run prisma:migrate
```

Prisma schema and indexes live in `prisma/schema.prisma` and `prisma/migrations/`. Railway health checks use `/api/ready`, so the API service will not be marked ready while PostgreSQL is disconnected.

## Local Development

```bash
npm install
cp .env.example .env
npm run prisma:migrate
npm start
```

For a split local setup:

```bash
DAKSH_SERVICE_ROLE=api npm start
DAKSH_SERVICE_ROLE=web PUBLIC_API_BASE_URL=http://localhost:3000 npm start
```

On Windows PowerShell:

```powershell
$env:DAKSH_SERVICE_ROLE='api'; npm start
```

## Data Migration Safety

Use the migration tooling only after both database URLs are available. Always run verification before deleting any old source data.

Required order:

1. Export source data.
2. Import into Railway PostgreSQL.
3. Verify counts and sampled records for users, dealers, catalogue, scan history, reports, bin locations, uploaded files, and settings.
4. Save the migration logs and verification summary.
5. Delete old source data only after manual confirmation from the owner.

## Key URLs

- Web app: `https://your-web-service.up.railway.app`
- API health: `https://your-api-service.up.railway.app/api/health`
- API readiness: `https://your-api-service.up.railway.app/api/ready`
- Mobile scanner: `https://your-web-service.up.railway.app/scan`

## Default Login

```text
Username: admin
Password: value of DEFAULT_ADMIN_PASSWORD
```

Change the admin password after first login.
