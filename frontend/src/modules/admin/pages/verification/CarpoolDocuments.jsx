import React, { useEffect, useState } from 'react';
import { Car, CheckCircle2, ChevronRight, FileText, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';

const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

const STATUS_STYLES = {
  PENDING: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-rose-50 text-rose-700',
};

const unwrap = (response) => {
  if (response?.results) return response;
  if (response?.data?.results) return response.data;
  if (response?.data?.data?.results) return response.data.data;
  return { results: [], counts: {} };
};

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const isPdf = (url) => /\.pdf($|\?)/i.test(String(url || ''));

const CarpoolDocuments = () => {
  const [status, setStatus] = useState('PENDING');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [preview, setPreview] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = unwrap(await adminService.getCarpoolDocuments({ status }));
      setItems(data.results || []);
      setCounts(data.counts || {});
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [status]);

  const approve = async (doc) => {
    setBusyId(doc.id);
    try {
      await adminService.approveCarpoolDocument(doc.id);
      toast.success(`${doc.label} approved`);
      load();
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Approval failed');
    } finally {
      setBusyId('');
    }
  };

  const reject = async (doc) => {
    const reason = window.prompt(`Why is this ${doc.label.toLowerCase()} being rejected? The host will see this.`);
    if (reason === null) return;
    if (!reason.trim()) {
      toast.error('A reason is required');
      return;
    }
    setBusyId(doc.id);
    try {
      await adminService.rejectCarpoolDocument(doc.id, reason.trim());
      toast.success(`${doc.label} rejected`);
      load();
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Rejection failed');
    } finally {
      setBusyId('');
    }
  };

  const open = (url) => (isPdf(url) ? window.open(url, '_blank', 'noopener') : setPreview(url));

  return (
    <div className="min-h-screen bg-slate-50/50 p-4 lg:p-6">
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400">
          <span>Verifications</span>
          <ChevronRight size={12} />
          <span className="text-yellow-600">Carpool Documents</span>
        </div>
        <h1 className="text-2xl font-black text-slate-900">Carpool Host Documents</h1>
        <p className="text-sm font-medium text-slate-500">
          A host can offer rides once their driver photo and licence, and the car&apos;s RC and insurance, are all approved.
        </p>
      </div>

      <div className="mb-4 inline-flex rounded-2xl border border-slate-200 bg-white p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setStatus(tab.key)}
            className={`rounded-xl px-4 py-1.5 text-sm font-bold transition ${status === tab.key ? 'bg-black text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs opacity-70">{counts[tab.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[28px] border border-slate-100 bg-white shadow-sm">
        {loading ? (
          <div className="space-y-4 p-6">
            {[1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-slate-50">
              <FileText size={32} className="text-slate-300" />
            </div>
            <h3 className="text-lg font-black text-slate-900">No {status.toLowerCase()} documents</h3>
            <p className="mt-1 max-w-sm text-sm font-medium text-slate-500">Documents hosts upload from Offer Ride appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead>
                <tr className="text-left text-xs font-bold text-slate-500">
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Host</th>
                  <th className="px-4 py-3">Vehicle</th>
                  <th className="px-4 py-3">Details</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((doc) => (
                  <tr key={doc.id} className="align-top transition hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <button onClick={() => open(doc.url)} className="flex items-center gap-2.5 text-left">
                        <div className="flex h-14 w-20 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                          {isPdf(doc.url) ? <FileText size={20} className="text-slate-400" /> : <img src={doc.url} alt={doc.label} className="h-full w-full object-cover" />}
                        </div>
                        <span className="text-sm font-black text-slate-900">{doc.label}</span>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-bold text-slate-800">{doc.host?.name || '-'}</p>
                      <p className="text-[11px] font-semibold text-slate-500">{doc.host?.phone || ''}</p>
                    </td>
                    <td className="px-4 py-3">
                      {doc.vehicle ? (
                        <div className="flex items-center gap-2">
                          <Car size={14} className="text-slate-400" />
                          <div>
                            <p className="text-sm font-bold text-slate-800">{doc.vehicle.model}</p>
                            <p className="text-[11px] font-bold text-slate-400">{doc.vehicle.registrationNumber}</p>
                          </div>
                        </div>
                      ) : (
                        <span className="text-[11px] font-semibold text-slate-400">Applies to all the host&apos;s cars</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[11px] font-semibold text-slate-600">
                      {doc.documentNumber ? <p>No. {doc.documentNumber}</p> : null}
                      {doc.expiryDate ? (
                        <p className={doc.expired ? 'font-bold text-rose-600' : ''}>
                          Expires {formatDate(doc.expiryDate)}{doc.expired ? ' (expired)' : ''}
                        </p>
                      ) : null}
                      <p className="text-slate-400">Uploaded {formatDate(doc.uploadedAt)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${STATUS_STYLES[doc.status] || ''}`}>
                        {doc.status}
                      </span>
                      {doc.rejectionReason ? <p className="mt-1 max-w-[200px] text-[11px] font-semibold text-rose-600">{doc.rejectionReason}</p> : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {doc.status !== 'APPROVED' ? (
                          <button
                            disabled={busyId === doc.id}
                            onClick={() => approve(doc)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-black px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:opacity-50"
                          >
                            <CheckCircle2 size={12} /> Approve
                          </button>
                        ) : null}
                        {doc.status !== 'REJECTED' ? (
                          <button
                            disabled={busyId === doc.id}
                            onClick={() => reject(doc)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-2.5 py-1 text-[11px] font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                          >
                            <XCircle size={12} /> Reject
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPreview('')}>
          <img src={preview} alt="Document" className="max-h-[90vh] max-w-full rounded-2xl bg-white object-contain" />
        </div>
      ) : null}
    </div>
  );
};

export default CarpoolDocuments;
