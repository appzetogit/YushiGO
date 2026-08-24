import {
  createMedicineOrderRecord,
  getActiveMedicineOrderForIdentity,
  getMedicineOrderById,
  listActivePharmacies,
  listMedicineOrdersForIdentity,
} from '../services/medicineService.js';

export const createMedicineOrder = async (req, res) => {
  const { pickup, drop, pickupAddress, dropAddress, fare, vehicleTypeId, vehicleTypeIds, vehicleIconType, vehicleIconUrl, paymentMethod, medicine } = req.body;

  const order = await createMedicineOrderRecord({
    userId: req.auth.sub,
    pickup,
    drop,
    pickupAddress,
    dropAddress,
    fare,
    vehicleTypeId,
    vehicleTypeIds,
    vehicleIconType,
    vehicleIconUrl,
    paymentMethod,
    medicine,
  });

  res.status(201).json({
    success: true,
    data: order,
  });
};

export const getMyActiveMedicineOrder = async (req, res) => {
  const order = await getActiveMedicineOrderForIdentity({
    role: req.auth.role,
    entityId: req.auth.sub,
  });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.json({
    success: true,
    data: order,
  });
};

export const getMedicineOrder = async (req, res) => {
  const order = await getMedicineOrderById({
    medicineOrderId: req.params.medicineOrderId,
    role: req.auth.role,
    entityId: req.auth.sub,
  });

  res.json({
    success: true,
    data: order,
  });
};

export const listMyMedicineOrders = async (req, res) => {
  const orders = await listMedicineOrdersForIdentity({
    role: req.auth.role,
    entityId: req.auth.sub,
    limit: req.query.limit,
  });

  res.json({
    success: true,
    data: {
      results: orders,
      total: orders.length,
    },
  });
};

export const listPharmacies = async (req, res) => {
  const pharmacies = await listActivePharmacies();

  res.json({
    success: true,
    data: pharmacies,
  });
};
