-- Central license service tables. The service stores only keyed hashes of
-- license keys; customer applications never need to write these tables.
CREATE TABLE "license_records" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "licenseKeyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "features" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "license_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "license_devices" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "deviceFingerprintHash" TEXT NOT NULL,
    "devicePublicKey" TEXT NOT NULL,
    "deviceName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "leaseId" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "license_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "license_devices_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "license_records"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "license_activation_audits" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT,
    "deviceId" TEXT,
    "requestId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "license_activation_audits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "license_admin_audits" (
    "id" TEXT NOT NULL,
    "adminSubject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "licenseId" TEXT,
    "deviceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "license_admin_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "license_records_licenseKeyHash_key" ON "license_records"("licenseKeyHash");
CREATE UNIQUE INDEX "license_devices_licenseId_deviceFingerprintHash_key" ON "license_devices"("licenseId", "deviceFingerprintHash");
CREATE UNIQUE INDEX "license_activation_audits_requestId_key" ON "license_activation_audits"("requestId");
CREATE INDEX "license_records_status_idx" ON "license_records"("status");
CREATE INDEX "license_records_customerId_idx" ON "license_records"("customerId");
CREATE INDEX "license_devices_licenseId_status_idx" ON "license_devices"("licenseId", "status");
CREATE INDEX "license_devices_deviceFingerprintHash_idx" ON "license_devices"("deviceFingerprintHash");
CREATE INDEX "license_activation_audits_licenseId_createdAt_idx" ON "license_activation_audits"("licenseId", "createdAt");
CREATE INDEX "license_activation_audits_deviceId_createdAt_idx" ON "license_activation_audits"("deviceId", "createdAt");
CREATE INDEX "license_activation_audits_eventType_createdAt_idx" ON "license_activation_audits"("eventType", "createdAt");
CREATE INDEX "license_admin_audits_licenseId_createdAt_idx" ON "license_admin_audits"("licenseId", "createdAt");
CREATE INDEX "license_admin_audits_adminSubject_createdAt_idx" ON "license_admin_audits"("adminSubject", "createdAt");
