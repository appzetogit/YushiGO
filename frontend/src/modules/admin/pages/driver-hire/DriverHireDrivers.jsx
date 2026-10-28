import React, { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';
import { Badge, Button, Card, Empty, Loading, PageHeader, Tabs } from './ui';
import { SERVICE_TYPES, askReason, errorMessage, formatDate, unwrap } from './helpers';

const TABS = [
  { key: 'PENDING', label: 'Pending review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'SUSPENDED', label: 'Suspended' },
  { key: 'EXPIRING', label: 'Licence expiring' },
];

const isPdf = (url) => /\.pdf($|\?)/i.test(String(url || ''));

const ACTIONS = {
  PENDING: [['approve', 'Approve', 'success'], ['reject', 'Reject', 'danger'], ['suspend', 'Suspend', 'light']],
  APPROVED: [['suspend', 'Suspend', 'danger']],
  REJECTED: [['approve', 'Approve', 'success']],
  SUSPENDED: [['reinstate', 'Reinstate', 'success']],
};

const REASON_PROMPTS = {
  reject: 'What needs fixing? The driver sees this.',
  suspend: 'Why is this driver being suspended? Recorded in the audit log.',
};

const DriverDetail = ({ profileId, onClose, onChanged }) => {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminService.getDriverHireDriver(profileId)
      .then((response) => setDetail(unwrap(response)))
      .catch((error) => toast.error(errorMessage(error, 'Failed to load driver')));
  }, [profileId]);

  const act = async (action) => {
    let reason = '';
    if (REASON_PROMPTS[action]) {
      reason = askReason(REASON_PROMPTS[action]);
      if (!reason) return;
    }
    setBusy(true);
    try {
      await adminService.reviewDriverHireDriver(profileId, action, reason);
      toast.success('Saved');
      onChanged();
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Action failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6" onClick={(event) => event.stopPropagation()}>
        {!detail ? <Loading /> : (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-black">{detail.driver?.name}</h2>
                <div className="text-sm text-slate-500">{detail.driver?.phone}</div>
                <div className="mt-1"><Badge value={detail.verificationStatus} /></div>
              </div>
              <button onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
            </div>
            <p className="mb-3 text-xs text-slate-400">Opening this profile shows the full licence number and is recorded in the audit log.</p>
            <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs font-bold text-slate-400">Licence number</dt><dd className="font-mono font-semibold">{detail.licenceNumber || '-'}</dd></div>
              <div><dt className="text-xs font-bold text-slate-400">Licence expiry</dt><dd className={`font-semibold ${detail.licenceExpired ? 'text-rose-600' : ''}`}>{formatDate(detail.licenceExpiry)}{detail.licenceExpired ? ' (expired)' : ''}</dd></div>
              <div><dt className="text-xs font-bold text-slate-400">Drives</dt><dd>{(detail.transmissions || []).map((t) => t.toLowerCase()).join(', ')}</dd></div>
              <div><dt className="text-xs font-bold text-slate-400">Experience</dt><dd>{detail.experienceYears} years</dd></div>
              <div className="col-span-2"><dt className="text-xs font-bold text-slate-400">Services</dt><dd>{(detail.serviceTypes || []).map((t) => SERVICE_TYPES[t]).join(', ')}</dd></div>
              <div><dt className="text-xs font-bold text-slate-400">Agreement</dt><dd>{detail.agreementCurrent ? `Accepted (${detail.agreementVersion})` : 'Not current'}</dd></div>
              <div><dt className="text-xs font-bold text-slate-400">Rating</dt><dd>★ {detail.rating || '-'} ({detail.ratingCount})</dd></div>
            </dl>
            {detail.reviewNote && <p className="mb-4 rounded-2xl bg-slate-50 p-3 text-sm"><span className="font-bold">Last review note:</span> {detail.reviewNote}</p>}
            {detail.licenceDocumentUrl && (
              isPdf(detail.licenceDocumentUrl) ? (
                <a href={detail.licenceDocumentUrl} target="_blank" rel="noopener noreferrer" className="mb-4 flex items-center gap-2 text-sm font-bold text-sky-700"><FileText size={16} /> Open licence (PDF)</a>
              ) : (
                <img src={detail.licenceDocumentUrl} alt="Driving licence" className="mb-4 max-h-80 w-full rounded-2xl border border-slate-100 object-contain" />
              )
            )}
            <div className="flex flex-wrap gap-2">
              {(ACTIONS[detail.verificationStatus] || []).map(([action, label, variant]) => (
                <Button key={action} variant={variant} disabled={busy} onClick={() => act(action)}>{label}</Button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const DriverHireDrivers = () => {
  const [tab, setTab] = useState('PENDING');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = tab === 'EXPIRING' ? { status: 'APPROVED', expiringWithinDays: 30 } : { status: tab };
      setItems(unwrap(await adminService.getDriverHireDrivers(params)).profiles || []);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load drivers'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [tab]);

  return (
    <div className="min-h-screen bg-slate-50/50 p-4 lg:p-6">
      <PageHeader
        crumb="Drivers"
        title="Hire-Driver Verification"
        subtitle="Approve drivers before they can take bookings. An expired licence stops new bookings automatically."
      />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <Card>
        {loading ? <Loading /> : items.length === 0 ? (
          <Empty title="No drivers here" hint="Drivers submit their licence and capabilities from the driver app." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead>
                <tr className="text-left text-xs font-bold text-slate-500">
                  <th className="px-4 py-3">Driver</th>
                  <th className="px-4 py-3">Licence</th>
                  <th className="px-4 py-3">Drives</th>
                  <th className="px-4 py-3">Services</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((profile) => (
                  <tr key={profile.id} onClick={() => setOpenId(profile.id)} className="cursor-pointer text-sm transition hover:bg-slate-50/70">
                    <td className="px-4 py-3"><div className="font-bold">{profile.driver?.name || '-'}</div><div className="text-xs text-slate-500">{profile.driver?.phone}</div></td>
                    <td className="px-4 py-3">••••{profile.licenceNumberLast4}<div className={`text-xs ${profile.licenceExpired ? 'font-bold text-rose-600' : 'text-slate-500'}`}>expires {formatDate(profile.licenceExpiry)}</div></td>
                    <td className="px-4 py-3">{profile.transmissions.map((t) => t.toLowerCase()).join(', ')}</td>
                    <td className="px-4 py-3 text-xs">{profile.serviceTypes.map((t) => SERVICE_TYPES[t]).join(', ')}</td>
                    <td className="px-4 py-3">{formatDate(profile.submittedAt)}</td>
                    <td className="px-4 py-3"><Badge value={profile.verificationStatus} />{profile.isOnline && <span className="ml-2 text-xs font-bold text-emerald-600">online</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && <DriverDetail profileId={openId} onClose={() => setOpenId('')} onChanged={load} />}
    </div>
  );
};

export default DriverHireDrivers;
