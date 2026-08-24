import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { Pharmacy } from '../models/Pharmacy.js';

const ok = (res, data) => res.json({ success: true, data });

export const listAdminPharmacies = asyncHandler(async (_req, res) => {
  ok(res, await Pharmacy.find().sort({ createdAt: -1 }).lean());
});

export const createAdminPharmacy = asyncHandler(async (req, res) => {
  const { name, address, phone, operatingHours, coordinates, active } = req.body;

  if (!String(name || '').trim()) {
    throw new ApiError(400, 'name is required');
  }

  const pharmacy = await Pharmacy.create({
    name,
    address,
    phone,
    operatingHours,
    active: active === undefined ? true : Boolean(active),
    location: Array.isArray(coordinates) && coordinates.length === 2 ? { type: 'Point', coordinates } : undefined,
  });

  ok(res, pharmacy);
});

export const updateAdminPharmacy = asyncHandler(async (req, res) => {
  const { name, address, phone, operatingHours, coordinates, active } = req.body;
  const update = {};

  if (name !== undefined) update.name = name;
  if (address !== undefined) update.address = address;
  if (phone !== undefined) update.phone = phone;
  if (operatingHours !== undefined) update.operatingHours = operatingHours;
  if (active !== undefined) update.active = Boolean(active);
  if (Array.isArray(coordinates) && coordinates.length === 2) {
    update.location = { type: 'Point', coordinates };
  }

  const pharmacy = await Pharmacy.findByIdAndUpdate(req.params.id, update, { new: true });

  if (!pharmacy) {
    throw new ApiError(404, 'Pharmacy not found');
  }

  ok(res, pharmacy);
});

export const deleteAdminPharmacy = asyncHandler(async (req, res) => {
  const pharmacy = await Pharmacy.findByIdAndDelete(req.params.id);

  if (!pharmacy) {
    throw new ApiError(404, 'Pharmacy not found');
  }

  ok(res, { deleted: true });
});
