# Free Testing Deployment

Recommended free testing setup:

- App hosting: Render Free Web Service
- Database: MongoDB Atlas M0 Free Cluster

## Why This Setup

Render Free Web Service can run this Node.js app from GitHub with `npm start`.
MongoDB Atlas M0 is a free cloud MongoDB cluster for small testing/proof-of-concept use.

This setup is for testing only. Render Free services can sleep when idle, have monthly usage limits, and do not provide persistent local disk storage.

## MongoDB Atlas Setup

1. Create or sign in to MongoDB Atlas.
2. Create a new project, for example `Daksh Inventory`.
3. Create a free `M0` cluster.
4. Create a database user with username/password authentication.
5. Give the user `readWrite` permission.
6. In Network Access, allow the Render server IP. For first testing only, you can allow `0.0.0.0/0`.
7. Copy the connection string and replace username/password/database:

```text
mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/daksh_inventory_v2?retryWrites=true&w=majority
```

## Render Setup

1. Create or sign in to Render.
2. Connect your GitHub account.
3. Select repository:

```text
amitnir11-jpg/daksh-inventory-v2
```

4. Create a new Blueprint or Web Service from this repository.
5. Use the free instance type.
6. Set environment variables:

```text
MONGO_URI=<your MongoDB Atlas connection string>
PUBLIC_BASE_URL=<your Render app URL after first deploy>
```

The `render.yaml` file already sets the Node.js build command, start command, health check, JWT secret generation, and MongoDB timeout settings.

## First Login

After deployment opens successfully:

```text
Username: admin
Password: admin
```

Change the admin password immediately from Admin Settings.

## Important Notes

- Do not put real MongoDB passwords in GitHub.
- Keep `MONGO_URI` only in Render environment variables.
- Render Free may sleep after idle time, so the first page load can take around a minute.
- Gmail SMTP on common SMTP ports may not work from Render Free. Admin login and normal app testing still work.
- Bluetooth barcode scanner input works from the browser/computer where the web app is opened. The cloud server cannot directly control a user's PC Bluetooth hardware.
