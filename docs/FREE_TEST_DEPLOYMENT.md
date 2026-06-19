# Free Testing Deployment

Recommended free testing setup:

- App hosting: Railway or Render Web Service
- Database: Railway PostgreSQL or another managed PostgreSQL database

This application is PostgreSQL-only. It does not start MongoDB and it does not run with an offline database fallback.

## PostgreSQL Setup

1. Create a managed PostgreSQL database.
2. Copy its connection string.
3. Set it as `DATABASE_URL` in the web service environment.
4. Keep the URL private; do not commit it to GitHub.

For Railway, the API service can usually use:

```text
DATABASE_URL=${{daksh-postgres.DATABASE_URL}}
```

## App Setup

Set the required service variables:

```text
DAKSH_SERVICE_ROLE=api
NODE_ENV=production
DATABASE_URL=<your PostgreSQL connection string>
JWT_SECRET=<long-random-secret>
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=<strong-password>
PUBLIC_BASE_URL=<your public app URL>
```

On startup, the API service runs:

```text
prisma migrate deploy
```

If `DATABASE_URL` is missing, PostgreSQL cannot connect, or migrations fail, startup exits and the service is not marked ready.

## First Login

After deployment is ready:

```text
Username: admin
Password: value of DEFAULT_ADMIN_PASSWORD
```

Change the admin password after first login.
