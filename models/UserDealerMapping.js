const mongoose = require('mongoose');

const userDealerMappingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    dealerId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true
    },
    auditId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  {
    collection: 'user_dealer_mapping',
    timestamps: true
  }
);

userDealerMappingSchema.index({ userId: 1, dealerId: 1, auditId: 1 }, { unique: true });

module.exports = mongoose.model('UserDealerMapping', userDealerMappingSchema);
