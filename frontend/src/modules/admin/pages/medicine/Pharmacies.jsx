import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Pill, Trash2, PencilLine, X, ChevronRight, Phone, MapPin, Clock } from 'lucide-react';
import { adminService } from '../../services/adminService';
import toast from 'react-hot-toast';

const emptyForm = { name: '', address: '', phone: '', operatingHours: '', active: true };

const PharmacyModal = ({ pharmacy, onClose, onSaved }) => {
  const [form, setForm] = useState(pharmacy ? { ...emptyForm, ...pharmacy } : emptyForm);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error('Pharmacy name is required');
      return;
    }

    setSaving(true);
    try {
      if (pharmacy?._id) {
        await adminService.updatePharmacy(pharmacy._id, form);
        toast.success('Pharmacy updated');
      } else {
        await adminService.createPharmacy(form);
        toast.success('Pharmacy created');
      }
      onSaved();
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Failed to save pharmacy');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-md rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-bold text-gray-900">{pharmacy ? 'Edit Pharmacy' : 'Add Pharmacy'}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-colors">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-[11px] font-bold text-gray-500 mb-1">Pharmacy Name *</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full h-9 border border-gray-200 rounded-md bg-gray-50 px-3 text-sm outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
              placeholder="e.g. Apollo Pharmacy"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 mb-1">Address</label>
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full h-9 border border-gray-200 rounded-md bg-gray-50 px-3 text-sm outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
              placeholder="Street, city"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-gray-500 mb-1">Phone</label>
              <input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full h-9 border border-gray-200 rounded-md bg-gray-50 px-3 text-sm outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-gray-500 mb-1">Operating Hours</label>
              <input
                value={form.operatingHours}
                onChange={(e) => setForm({ ...form, operatingHours: e.target.value })}
                className="w-full h-9 border border-gray-200 rounded-md bg-gray-50 px-3 text-sm outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
                placeholder="9 AM - 9 PM"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-400"
            />
            Active
          </label>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-bold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-bold text-black bg-yellow-400 rounded-lg hover:bg-yellow-500 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Pharmacy'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const Pharmacies = () => {
  const [pharmacies, setPharmacies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalPharmacy, setModalPharmacy] = useState(null);
  const [showModal, setShowModal] = useState(false);

  const loadPharmacies = async () => {
    setLoading(true);
    try {
      const response = await adminService.getPharmacies();
      setPharmacies(response.data || []);
    } catch (error) {
      toast.error('Failed to load pharmacies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPharmacies();
  }, []);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this pharmacy?')) return;
    try {
      await adminService.deletePharmacy(id);
      toast.success('Pharmacy deleted');
      loadPharmacies();
    } catch (error) {
      toast.error('Failed to delete pharmacy');
    }
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return pharmacies;
    return pharmacies.filter((p) => [p.name, p.address, p.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(query)));
  }, [pharmacies, search]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <div className="px-4 py-2 md:px-6 md:pt-2 md:pb-6 space-y-4 max-w-full">
        <div className="flex items-center justify-between px-4 py-3 bg-white rounded-xl shadow-sm border border-gray-100">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-gray-900">Pharmacies</h1>
            <p className="text-xs text-gray-500 mt-0.5 font-medium">Manage partner pharmacies available for medicine pickup & drop.</p>
          </div>
          <div className="hidden md:flex items-center gap-2 text-xs font-medium text-gray-400">
            <span>Medicine Delivery</span>
            <ChevronRight size={14} className="text-gray-300" />
            <span className="text-gray-600">Pharmacies</span>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:w-64">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search pharmacies..."
                className="h-9 w-full rounded-md border border-gray-200 bg-gray-50 pl-8 pr-3 text-sm outline-none focus:bg-white focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
              />
            </div>
            <button
              onClick={() => { setModalPharmacy(null); setShowModal(true); }}
              className="flex h-9 items-center gap-1.5 px-4 rounded-md text-sm font-bold bg-black text-white hover:bg-gray-900 transition-colors"
            >
              <Plus size={16} /> Add Pharmacy
            </button>
          </div>

          <div className="overflow-x-auto min-h-[300px]">
            <table className="w-full text-left border-collapse whitespace-nowrap">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="bg-gray-50/80 border-b border-gray-100">
                  {['Name', 'Address', 'Phone', 'Hours', 'Status', 'Actions'].map((heading, i) => (
                    <th key={heading} className={`px-4 py-2.5 text-[11px] font-bold text-gray-600 tracking-wide ${i === 5 ? 'text-right pr-6' : ''}`}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {loading ? (
                  <tr><td colSpan={6} className="py-16 text-center text-xs font-bold text-gray-400">Loading pharmacies...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-16 text-center">
                      <Pill size={40} className="text-gray-300 mx-auto mb-2" />
                      <p className="text-sm font-bold text-gray-500">No pharmacies found</p>
                    </td>
                  </tr>
                ) : (
                  filtered.map((pharmacy) => (
                    <tr key={pharmacy._id} className="hover:bg-yellow-50/30 transition-colors">
                      <td className="px-4 py-2.5 text-[13px] font-bold text-gray-900">{pharmacy.name}</td>
                      <td className="px-4 py-2.5 text-[12px] text-gray-600 flex items-center gap-1"><MapPin size={12} className="text-gray-400" />{pharmacy.address || '-'}</td>
                      <td className="px-4 py-2.5 text-[12px] text-gray-600"><span className="inline-flex items-center gap-1"><Phone size={12} className="text-gray-400" />{pharmacy.phone || '-'}</span></td>
                      <td className="px-4 py-2.5 text-[12px] text-gray-600"><span className="inline-flex items-center gap-1"><Clock size={12} className="text-gray-400" />{pharmacy.operatingHours || '-'}</span></td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold rounded capitalize tracking-wide ${pharmacy.active ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                          {pharmacy.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => { setModalPharmacy(pharmacy); setShowModal(true); }} className="p-1.5 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg">
                            <PencilLine size={16} />
                          </button>
                          <button onClick={() => handleDelete(pharmacy._id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showModal && (
        <PharmacyModal
          pharmacy={modalPharmacy}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); loadPharmacies(); }}
        />
      )}
    </div>
  );
};

export default Pharmacies;
