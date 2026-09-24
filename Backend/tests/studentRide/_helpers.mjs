import mongoose from 'mongoose';

/**
 * Stand in for the admin approving a student. New students start PENDING and
 * cannot book; suites that exercise booking approve theirs first, exactly as
 * the admin endpoint would.
 */
export const approveStudent = async (id) => {
  await mongoose.connection.collection('taxistudents').updateOne(
    { _id: new mongoose.Types.ObjectId(String(id)) },
    { $set: { verificationStatus: 'VERIFIED', verifiedAt: new Date() } },
  );
};
