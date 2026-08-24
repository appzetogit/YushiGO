import React, { useEffect, useState } from 'react';
import { Search, LoaderCircle, XCircle, Pill, ChevronRight, FileText } from 'lucide-react';
import { adminService } from '../../services/adminService';

const STATUS_STYLES = {
  COMPLETED: 'bg-green-100 text-green-700 border border-green-200',
  CANCELLED: 'bg-red-100 text-red-700 border border-red-200',
  UPCOMING: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
  ON_TRIP: 'bg-blue-100 text-blue-700 border border-blue-200',
};

const formatDate = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} • ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`;
};

const MedicineOrders = () => {
  const [activeTab, setActiveTab] = useState('All');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      setIsLoading(true);
      setError('');
      try {
        const response = await adminService.getMedicineOrders({ page: 1, limit: 25, tab: activeTab.toLowerCase(), search });
        const payload = response?.data || response || {};
        if (!active) return;
        setRows(payload?.results || payload?.data || []);
        setTotal(payload?.paginator?.total ?? (payload?.results || []).length);
      } catch (loadError) {
        if (active) {
          setRows([]);
          setError(loadError?.message || 'Could not load medicine orders.');
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [activeTab, search]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <div className="px-4 py-2 md:px-6 md:pt-2 md:pb-6 space-y-4 max-w-full">
        <div className="flex items-center justify-between px-4 py-3 bg-white rounded-xl shadow-sm border border-gray-100">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-gray-900">Medicine Orders</h1>
            <p className="text-xs text-gray-500 mt-0.5 font-medium">Track medicine pickup & drop orders across the platform.</p>
          </div>
          <div className="hidden md:flex items-center gap-2 text-xs font-medium text-gray-400">
            <span>Medicine Delivery</span>
            <ChevronRight size={14} className="text-gray-300" />
            <span className="text-gray-600">Medicine Orders</span>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col relative">
          <div className="flex flex-col gap-4 border-b border-gray-100 px-4 py-3 lg:flex-row lg:items-center">
            <div className="flex flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
              {['All', 'Completed', 'Cancelled', 'Upcoming', 'On Trip'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 text-xs font-bold transition-colors whitespace-nowrap rounded-md ${
                    activeTab === tab ? 'text-gray-900 bg-yellow-50' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-56 shrink-0">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search orders..."
                className="h-8 w-full rounded-md border border-gray-200 bg-gray-50 pl-8 pr-3 text-[11px] outline-none focus:bg-white focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
              />
            </div>
          </div>

          <div className="overflow-x-auto min-h-[400px]">
            <table className="w-full text-left border-collapse whitespace-nowrap">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="bg-gray-50/80 border-b border-gray-100">
                  {['Order ID', 'Date', 'Customer', 'Driver', 'Pharmacy', 'Type', 'Rx', 'Status', 'Payment'].map((heading) => (
                    <th key={heading} className="px-4 py-2.5 text-[11px] font-bold text-gray-600 tracking-wide">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {isLoading ? (
                  <tr>
                    <td colSpan={9} className="py-24 text-center">
                      <LoaderCircle className="animate-spin text-yellow-400 mx-auto" size={32} />
                      <p className="mt-3 text-xs font-bold text-gray-400 uppercase tracking-widest">Loading medicine orders...</p>
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={9} className="py-24 text-center">
                      <div className="bg-red-50 text-red-500 p-4 rounded-lg inline-block border border-red-100">
                        <XCircle size={24} className="mx-auto mb-2" />
                        <p className="text-sm font-bold">{error}</p>
                      </div>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-24 text-center">
                      <div className="mx-auto flex flex-col items-center justify-center opacity-50">
                        <Pill size={48} className="text-gray-300 mb-3" />
                        <p className="text-sm font-bold text-gray-500">No medicine orders found</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} className="hover:bg-yellow-50/30 transition-colors">
                      <td className="px-4 py-2 text-[13px] font-bold text-gray-900 font-mono">{row.requestId || '-'}</td>
                      <td className="px-4 py-2 text-[12px] font-medium text-gray-600">{formatDate(row.date)}</td>
                      <td className="px-4 py-2 text-[13px] font-bold text-gray-800">{row.userName || '-'}</td>
                      <td className="px-4 py-2 text-[13px] font-medium text-gray-700">{row.driverName || '--'}</td>
                      <td className="px-4 py-2 text-[13px] font-medium text-gray-700">{row.pharmacyName || '-'}</td>
                      <td className="px-4 py-2 text-[12px] font-medium text-gray-600 capitalize">{String(row.deliveryType || '').replace(/_/g, ' ') || '-'}</td>
                      <td className="px-4 py-2 text-[12px]">
                        {row.hasPrescription ? (
                          <span className="inline-flex items-center gap-1 text-blue-600 font-bold"><FileText size={12} /> Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold rounded capitalize tracking-wide ${STATUS_STYLES[row.tripStatus] || 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                          {row.tripStatus ? String(row.tripStatus).replace('_', ' ').toLowerCase() : 'Unknown'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[12px] font-bold text-gray-700">{row.paymentOption || 'CASH'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!isLoading && rows.length > 0 && (
            <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50 text-xs font-medium text-gray-500">
              Showing <span className="font-bold text-gray-900">{rows.length}</span> of <span className="font-bold text-gray-900">{total || rows.length}</span> orders
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MedicineOrders;
