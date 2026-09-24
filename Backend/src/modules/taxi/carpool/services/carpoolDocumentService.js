import mongoose from 'mongoose';
import { uploadDataUrlToCloudinary, uploadRawFileToCloudinary } from '../../../../utils/cloudinaryUpload.js';
import {
  CARPOOL_DOCUMENT_KINDS,
  CARPOOL_DOCUMENT_STATUS,
  CarpoolDocument,
  EXPIRING_DOCUMENT_KINDS,
  HOST_DOCUMENT_KINDS,
  VEHICLE_DOCUMENT_KINDS,
} from '../models/CarpoolDocument.js';
import { CarpoolVehicle } from '../models/CarpoolVehicle.js';
import { CARPOOL_ERRORS, CARPOOL_VEHICLE_VERIFICATION } from '../constants/index.js';
import { carpoolError, requireOwnedVehicle } from './carpoolVehicleService.js';

/**
 * Host verification for Offer Ride: driver photo and driving licence for the
 * host, RC and insurance for each vehicle. An admin approves or rejects each.
 *
 * A vehicle's verificationStatus is derived from its documents, so search
 * badges, the publish gate and student-ride suggestions all read one field.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
const PDF = /^data:application\/pdf;base64,/i;

const KIND_LABELS = {
  driverPhoto: 'Driver photo',
  drivingLicense: 'Driving licence',
  rc: 'RC',
  insurance: 'Insurance',
};

const startOfToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const isExpired = (doc, at = startOfToday()) =>
  Boolean(doc?.expiryDate) && new Date(doc.expiryDate).getTime() < at.getTime();

const serializeDocument = (doc) => ({
  id: String(doc._id),
  kind: doc.kind,
  label: KIND_LABELS[doc.kind] || doc.kind,
  vehicleId: doc.vehicleId ? String(doc.vehicleId._id || doc.vehicleId) : null,
  url: doc.url,
  documentNumber: doc.documentNumber || '',
  expiryDate: doc.expiryDate || null,
  expired: isExpired(doc),
  status: doc.status,
  rejectionReason: doc.rejectionReason || '',
  reviewedAt: doc.reviewedAt || null,
  uploadedAt: doc.createdAt,
});

const storeFile = async ({ userId, kind, file }) => {
  const dataUrl = String(file || '');
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

  if (!IMAGE.test(dataUrl) && !PDF.test(dataUrl)) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_DOCUMENT, 'file must be a JPEG, PNG, WebP or PDF data URL.');
  }

  if (Math.floor((base64.length * 3) / 4) > MAX_BYTES) {
    throw carpoolError(413, CARPOOL_ERRORS.INVALID_DOCUMENT, 'Documents must be 8 MB or smaller.');
  }

  const upload = PDF.test(dataUrl) ? uploadRawFileToCloudinary : uploadDataUrlToCloudinary;
  const stored = await upload({
    dataUrl,
    folder: 'carpool-documents',
    publicIdPrefix: `carpool-${kind}`,
    publicIdSuffix: String(userId),
  });

  return stored.secureUrl;
};

/**
 * Recompute and store verificationStatus for the given vehicles (default: all
 * of the host's). Called after every upload and every review.
 */
export const refreshVehicleVerification = async (userId, vehicleIds = null) => {
  const vehicles = vehicleIds
    ? await CarpoolVehicle.find({ _id: { $in: vehicleIds }, userId })
    : await CarpoolVehicle.find({ userId, deletedAt: null });

  if (!vehicles.length) {
    return;
  }

  const current = await CarpoolDocument.find({ userId, isCurrent: true }).lean();
  const hostDocs = current.filter((doc) => !doc.vehicleId);

  for (const vehicle of vehicles) {
    const vehicleDocs = current.filter((doc) => String(doc.vehicleId) === String(vehicle._id));
    const needed = [
      ...HOST_DOCUMENT_KINDS.map((kind) => hostDocs.find((doc) => doc.kind === kind)),
      ...VEHICLE_DOCUMENT_KINDS.map((kind) => vehicleDocs.find((doc) => doc.kind === kind)),
    ];

    let status;

    if (needed.some((doc) => doc?.status === CARPOOL_DOCUMENT_STATUS.REJECTED)) {
      status = CARPOOL_VEHICLE_VERIFICATION.REJECTED;
    } else if (needed.every((doc) => doc?.status === CARPOOL_DOCUMENT_STATUS.APPROVED && !isExpired(doc))) {
      status = CARPOOL_VEHICLE_VERIFICATION.VERIFIED;
    } else if (needed.some(Boolean)) {
      status = CARPOOL_VEHICLE_VERIFICATION.PENDING;
    } else {
      status = CARPOOL_VEHICLE_VERIFICATION.UNVERIFIED;
    }

    if (vehicle.verificationStatus !== status) {
      vehicle.verificationStatus = status;
      await vehicle.save();
    }
  }
};

/** Host: upload (or replace) one document. */
export const uploadDocument = async ({ userId, payload }) => {
  const kind = String(payload?.kind || '');

  if (!Object.values(CARPOOL_DOCUMENT_KINDS).includes(kind)) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_DOCUMENT, `kind must be one of ${Object.values(CARPOOL_DOCUMENT_KINDS).join(', ')}.`);
  }

  let vehicleId = null;

  if (VEHICLE_DOCUMENT_KINDS.includes(kind)) {
    const vehicle = await requireOwnedVehicle({ vehicleId: payload?.vehicle_id ?? payload?.vehicleId, userId });
    vehicleId = vehicle._id;
  }

  let expiryDate = null;
  const rawExpiry = payload?.expiry_date ?? payload?.expiryDate;

  if (rawExpiry) {
    expiryDate = new Date(rawExpiry);

    if (Number.isNaN(expiryDate.getTime())) {
      throw carpoolError(422, CARPOOL_ERRORS.INVALID_DOCUMENT, 'expiry_date is not a valid date.');
    }
  }

  if (EXPIRING_DOCUMENT_KINDS.includes(kind)) {
    if (!expiryDate) {
      throw carpoolError(422, CARPOOL_ERRORS.INVALID_DOCUMENT, `${KIND_LABELS[kind]} needs an expiry_date.`);
    }

    if (isExpired({ expiryDate })) {
      throw carpoolError(422, CARPOOL_ERRORS.DOCUMENT_EXPIRED, `This ${KIND_LABELS[kind].toLowerCase()} has already expired.`);
    }
  }

  const url = await storeFile({ userId, kind, file: payload?.file ?? payload?.image });

  await CarpoolDocument.updateMany({ userId, vehicleId, kind, isCurrent: true }, { $set: { isCurrent: false } });

  const doc = await CarpoolDocument.create({
    userId,
    vehicleId,
    kind,
    url,
    documentNumber: String(payload?.document_number ?? payload?.documentNumber ?? '').trim(),
    expiryDate,
  });

  await refreshVehicleVerification(userId, vehicleId ? [vehicleId] : null);

  return serializeDocument(doc);
};

/** Host: where Offer Ride stands — what is uploaded, approved, missing or expired. */
export const getDocumentStatus = async ({ userId }) => {
  const [docs, vehicles] = await Promise.all([
    CarpoolDocument.find({ userId, isCurrent: true }).sort({ createdAt: -1 }),
    CarpoolVehicle.find({ userId, deletedAt: null }).select('model make registrationNumber verificationStatus'),
  ]);

  const describe = (kinds, owned) => Object.fromEntries(kinds.map((kind) => {
    const doc = owned.find((entry) => entry.kind === kind);
    return [kind, doc ? serializeDocument(doc) : null];
  }));

  const hostDocs = docs.filter((doc) => !doc.vehicleId);
  const host = describe(HOST_DOCUMENT_KINDS, hostDocs);

  const vehicleRows = vehicles.map((vehicle) => {
    const own = docs.filter((doc) => String(doc.vehicleId) === String(vehicle._id));
    const documents = describe(VEHICLE_DOCUMENT_KINDS, own);
    const all = { ...host, ...documents };

    return {
      vehicleId: String(vehicle._id),
      model: vehicle.model,
      registrationNumber: vehicle.registrationNumber,
      verificationStatus: vehicle.verificationStatus,
      documents,
      missing: Object.entries(all).filter(([, doc]) => !doc || doc.expired || doc.status === 'REJECTED').map(([kind]) => kind),
      canPublish: vehicle.verificationStatus === CARPOOL_VEHICLE_VERIFICATION.VERIFIED,
    };
  });

  return {
    host,
    vehicles: vehicleRows,
    canPublish: vehicleRows.some((row) => row.canPublish),
  };
};

/**
 * Publish gate: the vehicle is verified and the expiring documents are still
 * valid on the day of the ride — an insurance that lapses before departure is
 * refused now rather than discovered on the road.
 */
export const assertDocumentsValidFor = async ({ vehicle, departureAt }) => {
  if (vehicle.verificationStatus !== CARPOOL_VEHICLE_VERIFICATION.VERIFIED) {
    throw carpoolError(
      403,
      CARPOOL_ERRORS.VEHICLE_NOT_VERIFIED,
      'Upload your driver photo, driving licence, RC and insurance and wait for approval before offering a ride.',
    );
  }

  const docs = await CarpoolDocument.find({
    userId: vehicle.userId,
    isCurrent: true,
    kind: { $in: EXPIRING_DOCUMENT_KINDS },
    $or: [{ vehicleId: null }, { vehicleId: vehicle._id }],
  }).lean();

  const lapsed = docs.find((doc) => isExpired(doc, departureAt || startOfToday()));

  if (lapsed) {
    throw carpoolError(
      403,
      CARPOOL_ERRORS.DOCUMENT_EXPIRED,
      `Your ${KIND_LABELS[lapsed.kind].toLowerCase()} expires before this ride. Upload the renewed one.`,
    );
  }
};

// ---------------------------------------------------------------------------
// Admin

export const listDocumentsForAdmin = async (query = {}) => {
  const filter = { isCurrent: true };
  const status = String(query.status || '').toUpperCase();

  if (status) {
    if (!Object.values(CARPOOL_DOCUMENT_STATUS).includes(status)) {
      throw carpoolError(422, CARPOOL_ERRORS.INVALID_DOCUMENT, `Unknown status ${status}.`);
    }
    filter.status = status;
  }

  if (query.userId && mongoose.Types.ObjectId.isValid(String(query.userId))) {
    filter.userId = query.userId;
  }

  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const page = Math.max(1, Number(query.page) || 1);

  const [docs, total, counts] = await Promise.all([
    CarpoolDocument.find(filter)
      .sort({ createdAt: status === 'PENDING' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', 'name phone email gender')
      .populate('vehicleId', 'model make registrationNumber seatCapacity verificationStatus'),
    CarpoolDocument.countDocuments(filter),
    CarpoolDocument.aggregate([{ $match: { isCurrent: true } }, { $group: { _id: '$status', total: { $sum: 1 } } }]),
  ]);

  return {
    results: docs.map((doc) => ({
      ...serializeDocument(doc),
      host: doc.userId
        ? { id: String(doc.userId._id), name: doc.userId.name || '', phone: doc.userId.phone || '', email: doc.userId.email || '' }
        : null,
      vehicle: doc.vehicleId
        ? {
            id: String(doc.vehicleId._id),
            model: [doc.vehicleId.make, doc.vehicleId.model].filter(Boolean).join(' '),
            registrationNumber: doc.vehicleId.registrationNumber,
            verificationStatus: doc.vehicleId.verificationStatus,
          }
        : null,
    })),
    counts: Object.fromEntries(Object.values(CARPOOL_DOCUMENT_STATUS).map((key) => [
      key, counts.find((row) => row._id === key)?.total || 0,
    ])),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

const notifyHost = async (doc) => {
  try {
    const { sendPushNotificationToEntities } = await import('../../services/pushNotificationService.js');
    const approved = doc.status === CARPOOL_DOCUMENT_STATUS.APPROVED;

    await sendPushNotificationToEntities({
      userIds: [String(doc.userId)],
      title: approved ? `${KIND_LABELS[doc.kind]} approved` : `${KIND_LABELS[doc.kind]} rejected`,
      body: approved ? 'Your carpool document was approved.' : doc.rejectionReason || 'Please upload it again.',
      data: {
        notification_type: approved ? 'CARPOOL_DOCUMENT_APPROVED' : 'CARPOOL_DOCUMENT_REJECTED',
        document_id: String(doc._id),
        kind: doc.kind,
      },
    });
  } catch (error) {
    console.error('[carpool] document review notification failed', error?.message || error);
  }
};

const review = async ({ documentId, adminId, status, reason = '' }) => {
  if (!mongoose.Types.ObjectId.isValid(String(documentId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.INVALID_DOCUMENT, 'Document not found.');
  }

  const doc = await CarpoolDocument.findById(documentId);

  if (!doc) {
    throw carpoolError(404, CARPOOL_ERRORS.INVALID_DOCUMENT, 'Document not found.');
  }

  if (!doc.isCurrent) {
    throw carpoolError(409, CARPOOL_ERRORS.INVALID_DOCUMENT, 'A newer version of this document has been uploaded.');
  }

  doc.status = status;
  doc.rejectionReason = status === CARPOOL_DOCUMENT_STATUS.REJECTED ? reason : '';
  doc.reviewedBy = mongoose.Types.ObjectId.isValid(String(adminId || '')) ? adminId : null;
  doc.reviewedAt = new Date();
  await doc.save();

  // A host document counts toward every one of the host's vehicles.
  await refreshVehicleVerification(doc.userId, doc.vehicleId ? [doc.vehicleId] : null);
  await notifyHost(doc);

  return serializeDocument(doc);
};

export const approveDocument = ({ documentId, adminId }) =>
  review({ documentId, adminId, status: CARPOOL_DOCUMENT_STATUS.APPROVED });

export const rejectDocument = ({ documentId, adminId, reason }) => {
  const text = String(reason || '').trim();

  if (!text) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_DOCUMENT, 'A reason is required to reject a document.');
  }

  return review({ documentId, adminId, status: CARPOOL_DOCUMENT_STATUS.REJECTED, reason: text.slice(0, 500) });
};
