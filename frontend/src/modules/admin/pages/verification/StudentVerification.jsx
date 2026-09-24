import React, { useEffect, useState } from 'react';
import { BadgeCheck, CheckCircle2, ChevronRight, GraduationCap, Search, ShieldAlert, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';

const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'VERIFIED', label: 'Verified' },
  { key: 'REJECTED', label: 'Rejected' },
];

const STATUS_STYLES = {
  PENDING: 'bg-amber-50 text-amber-700',
  VERIFIED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-rose-50 text-rose-700',
};

// The API responds { success, data: { results, counts, pagination } }; the axios
// interceptor may or may not have unwrapped one level.
const unwrap = (response) => {
  if (response?.results) return response;
  if (response?.data?.results) return response.data;
  if (response?.data?.data?.results) return response.data.data;
  return { results: [], counts: {} };
};

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

const StudentVerification = () => {
  const [status, setStatus] = useState('PENDING');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [preview, setPreview] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = unwrap(await adminService.getStudentsForVerification({ status, search }));
      setItems(data.results || []);
      setCounts(data.counts || {});
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Failed to load students');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const id = window.setTimeout(load, 250);
    return () => window.clearTimeout(id);
  }, [status, search]);

  const approve = async (student) => {
    if (!window.confirm(`Approve ${student.name}? The parent will be able to book student rides.`)) return;
    setBusyId(student.id);
    try {
      await adminService.approveStudent(student.id);
      toast.success(`${student.name} verified`);
      load();
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Approval failed');
    } finally {
      setBusyId('');
    }
  };

  const reject = async (student) => {
    const reason = window.prompt(`Why is ${student.name} being rejected? The parent will see this.`);
    if (reason === null) return;
    if (!reason.trim()) {
      toast.error('A reason is required');
      return;
    }
    setBusyId(student.id);
    try {
      await adminService.rejectStudent(student.id, reason.trim());
      toast.success(`${student.name} rejected`);
      load();
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Rejection failed');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50/50 p-4 lg:p-6">
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400">
          <span>Verifications</span>
          <ChevronRight size={12} />
          <span className="text-yellow-600">Student Verification</span>
        </div>
        <h1 className="text-2xl font-black text-slate-900">Student Verification</h1>
        <p className="text-sm font-medium text-slate-500">
          A student can only be booked once approved. Check the school ID and the Aadhaar details before approving.
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-2xl border border-slate-200 bg-white p-1">
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
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            type="text"
            placeholder="Search by student name or school ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm font-medium outline-none focus:border-yellow-400 focus:ring-4 focus:ring-yellow-400/10"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] border border-slate-100 bg-white shadow-sm">
        {loading ? (
          <div className="space-y-4 p-6">
            {[1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-slate-50">
              <GraduationCap size={32} className="text-slate-300" />
            </div>
            <h3 className="text-lg font-black text-slate-900">No {status.toLowerCase()} students</h3>
            <p className="mt-1 max-w-sm text-sm font-medium text-slate-500">New students added by parents appear here for review.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead>
                <tr className="text-left text-xs font-bold text-slate-500">
                  <th className="px-4 py-3">Student</th>
                  <th className="px-4 py-3">Parent</th>
                  <th className="px-4 py-3">Aadhaar</th>
                  <th className="px-4 py-3">School ID</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((student) => (
                  <tr key={student.id} className="align-top transition hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-slate-100">
                          {student.profilePhotoUrl ? (
                            <img src={student.profilePhotoUrl} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <GraduationCap size={16} className="text-slate-300" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-black text-slate-900">{student.name}</p>
                          <p className="text-[11px] font-semibold text-slate-500">
                            DOB {formatDate(student.dateOfBirth)} · {student.age} yrs · {student.ageCategory}
                          </p>
                          <p className="text-[11px] font-semibold text-slate-400">
                            {[student.schoolName, student.className].filter(Boolean).join(' · ') || 'No school given'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-bold text-slate-800">{student.parent?.name || '-'}</p>
                      <p className="text-[11px] font-semibold text-slate-500">{student.parent?.phone || ''}</p>
                      <p className="text-[11px] font-semibold text-slate-400">{student.guardianCount} guardian(s)</p>
                    </td>
                    <td className="px-4 py-3">
                      {student.aadhaar?.provided ? (
                        <div className="space-y-1">
                          <p className="font-mono text-sm font-bold text-slate-800">{student.aadhaar.masked}</p>
                          {student.aadhaar.verified ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-700">
                              <BadgeCheck size={11} /> OTP verified
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase text-slate-600">Not OTP verified</span>
                          )}
                          {student.aadhaarProviderName ? (
                            <p className="text-[11px] font-semibold text-slate-500">Name on Aadhaar: {student.aadhaarProviderName}</p>
                          ) : null}
                          {student.aadhaarDuplicates > 0 ? (
                            <p className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700">
                              <ShieldAlert size={11} /> Same Aadhaar on {student.aadhaarDuplicates} other record(s)
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs font-semibold text-slate-400">Not provided</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-bold text-slate-800">{student.studentIdNumber || '-'}</p>
                      {student.studentIdPhotoUrl ? (
                        <button onClick={() => setPreview(student.studentIdPhotoUrl)} className="mt-1 block h-14 w-20 overflow-hidden rounded-lg border border-slate-200">
                          <img src={student.studentIdPhotoUrl} alt="School ID" className="h-full w-full object-cover" />
                        </button>
                      ) : (
                        <span className="text-[11px] font-semibold text-slate-400">No photo</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${STATUS_STYLES[student.verificationStatus] || ''}`}>
                        {student.verificationStatus}
                      </span>
                      {student.rejectionReason ? <p className="mt-1 max-w-[200px] text-[11px] font-semibold text-rose-600">{student.rejectionReason}</p> : null}
                      <p className="mt-1 text-[11px] font-semibold text-slate-400">Added {formatDate(student.createdAt)}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {student.verificationStatus !== 'VERIFIED' ? (
                          <button
                            disabled={busyId === student.id}
                            onClick={() => approve(student)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-black px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:opacity-50"
                          >
                            <CheckCircle2 size={12} /> Approve
                          </button>
                        ) : null}
                        {student.verificationStatus !== 'REJECTED' ? (
                          <button
                            disabled={busyId === student.id}
                            onClick={() => reject(student)}
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

export default StudentVerification;
