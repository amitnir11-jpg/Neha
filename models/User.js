const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true
    },
    passwordHash: {
      type: String,
      default: ''
    },
    password: {
      type: String,
      default: ''
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      sparse: true
    },
    pinHash: {
      type: String,
      default: ''
    },
    pin: {
      type: String,
      default: ''
    },
    role: {
      type: String,
      enum: ['admin', 'supervisor', 'scanner', 'outward_counter', 'staff', 'mobile_user'],
      default: 'staff'
    },
    name: {
      type: String,
      trim: true,
      default: 'Staff'
    },
    mobileNumber: {
      type: String,
      trim: true,
      default: ''
    },
    responsibility: {
      type: String,
      trim: true,
      default: ''
    },
    dealerAccess: {
      type: [String],
      default: []
    },
    permissions: {
      canScanInward: { type: Boolean, default: true },
      canScanOutward: { type: Boolean, default: true },
      canScanFitted: { type: Boolean, default: true },
      canScanDamage: { type: Boolean, default: true },
      canVerifyParts: { type: Boolean, default: true },
      canViewReports: { type: Boolean, default: true },
      canDeleteScanData: { type: Boolean, default: false },
      canExportExcel: { type: Boolean, default: false },
      canManageUsers: { type: Boolean, default: false }
    },
    active: {
      type: Boolean,
      default: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    approved: {
      type: Boolean,
      default: false
    },
    approvedBy: {
      type: String,
      trim: true,
      default: ''
    },
    approvedAt: {
      type: Date
    },
    resetTokenHash: {
      type: String,
      default: ''
    },
    resetOtpHash: {
      type: String,
      default: ''
    },
    resetExpiresAt: {
      type: Date
    },
    resetRequestedAt: {
      type: Date
    },
    forcePasswordChange: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

userSchema.pre('save', function syncActiveAliases(next) {
  if (this.isModified('isActive')) this.active = this.isActive;
  if (this.isModified('active')) this.isActive = this.active;
  if (this.isModified('password') && !this.isModified('passwordHash')) this.passwordHash = this.password;
  if (this.isModified('passwordHash') && !this.isModified('password')) this.password = this.passwordHash;
  if (this.isModified('pin') && !this.isModified('pinHash')) this.pinHash = this.pin;
  if (this.isModified('pinHash') && !this.isModified('pin')) this.pin = this.pinHash;
  next();
});

module.exports = mongoose.model('User', userSchema);
