import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';
import { Badge, Button, Card, Empty, Loading, PageHeader, Tabs } from './ui';
import { SERVICE_TYPES, askReason, errorMessage, formatDateTime, money, unwrap } from './helpers';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'support', label: 'Support & safety' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'payments', label: 'Payments' },
  { key: 'audit', label: 'Audit log' },
];

const Stat = ({ label, value, hint }) => (
  <div className="rounded-[22px] border border-slate-100 bg-white p-4 shadow-sm">
    <div className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</div>
    <div className="mt-1 text-2xl font-black text-slate-900">{value}</div>
    {hint && <div className="text-xs text-slate-500">{hint}</div>}
  </div>
);

const Overview = () => {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState(null);

  const load = async () => {
    try {
      const from = new Date(Date.now() - days * 86400000).toISOString();
      setReport(unwrap(await adminService.getDriverHireReport({ from, to: new Date(Date.now() + 30 * 86400000).toISOString() })));
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load report'));
    }
  };

  useEffect(() => {
    load();
  }, [days]);

  if (!report) return <Card><Loading /></Card>;

  const urgent = (report.openSupportCases?.URGENT || 0) + (report.openSupportCases?.HIGH || 0);
  return (
    <div>
      <div className="mb-3 flex gap-2">
        {[7, 30, 90].map((value) => (
          <Button key={value} variant={days === value ? 'dark' : 'light'} onClick={() => setDays(value)}>Last {value} days</Button>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bookings" value={report.totalBookings} hint="by pickup date, incl. upcoming" />
        <Stat label="Completion rate" value={report.completionRate === null ? '-' : `${report.completionRate}%`} hint="of finished bookings" />
        <Stat label="Gross fares" value={money(report.revenue.gross)} hint={`platform ${money(report.revenue.platformFees)}`} />
        <Stat label="Customer rating" value={report.ratings.average ?? '-'} hint={`${report.ratings.count} review(s)`} />
        <Stat label="Drivers online" value={report.drivers.onlineNow} hint={`${report.drivers.APPROVED || 0} approved · ${report.drivers.PENDING || 0} pending`} />
        <Stat label="No driver found" value={report.cancellations.noDriverFound} />
        <Stat label="Cancellations" value={report.cancellations.byCustomer + report.cancellations.byDriver + report.cancellations.byAdmin} hint={`customer ${report.cancellations.byCustomer} · driver ${report.cancellations.byDriver} · admin ${report.cancellations.byAdmin}`} />
        <Stat label="Open urgent cases" value={urgent} />
      </div>
      <Card className="p-4">
        <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Bookings by service</div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {Object.entries(report.byServiceType).map(([type, count]) => (
              <tr key={type}><td className="py-2">{SERVICE_TYPES[type]}</td><td className="py-2 text-right font-bold">{count}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

const SupportCases = () => {
  const [status, setStatus] = useState('OPEN');
  const [items, setItems] = useState(null);

  const load = async () => {
    try {
      setItems(unwrap(await adminService.getDriverHireSupportCases({ status })).cases || []);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load cases'));
    }
  };

  useEffect(() => {
    load();
  }, [status]);

  const update = async (entry, data) => {
    try {
      await adminService.updateDriverHireSupportCase(entry.id, data);
      toast.success('Case updated');
      load();
    } catch (error) {
      toast.error(errorMessage(error, 'Update failed'));
    }
  };

  return (
    <div>
      <Tabs tabs={['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].map((key) => ({ key, label: key.replace('_', ' ').toLowerCase() }))} value={status} onChange={setStatus} />
      <Card>
        {!items ? <Loading /> : items.length === 0 ? <Empty title="No cases" /> : (
          <div className="divide-y divide-slate-100">
            {items.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm">
                <div className="max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge value={entry.priority} />
                    <span className="font-black">{entry.caseCode}</span>
                    <span className="font-semibold">{entry.category.replace(/_/g, ' ').toLowerCase()}</span>
                    <span className="text-slate-400">from {entry.raisedByRole === 'user' ? 'customer' : 'driver'} · {formatDateTime(entry.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-slate-700">{entry.description}</p>
                  {entry.resolutionNotes && <p className="mt-1 text-slate-500"><span className="font-bold">Resolution:</span> {entry.resolutionNotes}</p>}
                </div>
                <div className="flex gap-2">
                  {entry.status === 'OPEN' && <Button variant="light" onClick={() => update(entry, { status: 'IN_PROGRESS' })}>Take</Button>}
                  {['OPEN', 'IN_PROGRESS'].includes(entry.status) && (
                    <Button variant="success" onClick={() => {
                      const notes = askReason('Resolution notes:');
                      if (notes) update(entry, { status: 'RESOLVED', resolutionNotes: notes });
                    }}>Resolve</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

const PAYMENT_FILTERS = [
  { key: '', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'PAID', label: 'Paid' },
  { key: 'FAILED', label: 'Failed' },
];

/** Every customer charge with its platform fee, driver payout and refund (spec §4 Payments). */
const Payments = () => {
  const [paymentStatus, setPaymentStatus] = useState('');
  const [items, setItems] = useState(null);

  useEffect(() => {
    setItems(null);
    adminService
      .getDriverHirePayments(paymentStatus ? { paymentStatus } : {})
      .then((response) => setItems(unwrap(response).payments || []))
      .catch((error) => {
        setItems([]);
        toast.error(errorMessage(error, 'Failed to load payments'));
      });
  }, [paymentStatus]);

  const totals = (items || []).reduce(
    (sum, entry) => ({
      amount: sum.amount + (entry.paymentStatus === 'PAID' ? entry.amount : 0),
      platform: sum.platform + (entry.paymentStatus === 'PAID' ? entry.platformFee || 0 : 0),
      refunded: sum.refunded + (entry.refundAmount || 0),
    }),
    { amount: 0, platform: 0, refunded: 0 },
  );

  return (
    <div>
      <Tabs tabs={PAYMENT_FILTERS} value={paymentStatus} onChange={setPaymentStatus} />
      {items && items.length > 0 && (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Collected" value={money(totals.amount)} hint="paid, in this list" />
          <Stat label="Platform fees" value={money(totals.platform)} />
          <Stat label="Refunded" value={money(totals.refunded)} />
        </div>
      )}
      <Card>
        {!items ? <Loading /> : items.length === 0 ? <Empty title="No payments" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-wider text-slate-400">
                  <th className="p-3">Date</th>
                  <th className="p-3">Kind</th>
                  <th className="p-3">Method</th>
                  <th className="p-3 text-right">Amount</th>
                  <th className="p-3 text-right">Platform</th>
                  <th className="p-3 text-right">Driver</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Payout</th>
                  <th className="p-3">Refund</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((entry) => (
                  <tr key={entry._id || entry.id}>
                    <td className="p-3 text-slate-500">{formatDateTime(entry.createdAt)}</td>
                    <td className="p-3 font-semibold">{String(entry.kind || '').replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="p-3">{String(entry.method || '').toLowerCase()}</td>
                    <td className="p-3 text-right font-bold">{money(entry.amount, entry.currency)}</td>
                    <td className="p-3 text-right">{money(entry.platformFee, entry.currency)}</td>
                    <td className="p-3 text-right">{money(entry.driverAmount, entry.currency)}</td>
                    <td className="p-3"><Badge value={entry.paymentStatus} /></td>
                    <td className="p-3"><Badge value={entry.payoutStatus} /></td>
                    <td className="p-3">
                      {entry.refundAmount > 0 ? `${money(entry.refundAmount, entry.currency)} · ${String(entry.refundStatus || '').toLowerCase()}` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-2 text-xs text-slate-400">Latest 200. Mark a payment paid or refund it from the booking in Driver Hire Bookings.</p>
    </div>
  );
};

const AUDIT_FILTERS = [
  { key: '', label: 'All' },
  { key: 'DriverHireBooking', label: 'Bookings' },
  { key: 'DriverHirePricing', label: 'Pricing' },
  { key: 'DriverHireProfile', label: 'Drivers' },
  { key: 'DriverHirePayment', label: 'Payments' },
];

const summarizeChange = (value) => {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined && typeof item !== 'object')
    .slice(0, 6)
    .map(([key, item]) => `${key}: ${item}`)
    .join(' · ');
};

/** Admin actions, booking status changes, pricing and document decisions (spec §4 Audit). */
const AuditLog = () => {
  const [entityType, setEntityType] = useState('');
  const [items, setItems] = useState(null);

  useEffect(() => {
    setItems(null);
    adminService
      .getDriverHireAudit(entityType ? { entityType } : {})
      .then((response) => setItems(unwrap(response).entries || []))
      .catch((error) => {
        setItems([]);
        toast.error(errorMessage(error, 'Failed to load audit log'));
      });
  }, [entityType]);

  return (
    <div>
      <Tabs tabs={AUDIT_FILTERS} value={entityType} onChange={setEntityType} />
      <Card>
        {!items ? <Loading /> : items.length === 0 ? <Empty title="No entries" /> : (
          <div className="divide-y divide-slate-100">
            {items.map((entry) => (
              <div key={entry._id || entry.id} className="flex flex-wrap items-start justify-between gap-2 p-4 text-sm">
                <div className="max-w-3xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-black">{String(entry.action || '').replace(/_/g, ' ').toLowerCase()}</span>
                    <span className="text-slate-400">{String(entry.entityType || '').replace('DriverHire', '').toLowerCase()} {String(entry.entityId || '').slice(-6)}</span>
                  </div>
                  {summarizeChange(entry.changeSummary) && <p className="mt-1 text-slate-500">{summarizeChange(entry.changeSummary)}</p>}
                </div>
                <div className="text-right text-xs text-slate-400">
                  <div>{formatDateTime(entry.createdAt)}</div>
                  <div>by {entry.actorRole}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <p className="mt-2 text-xs text-slate-400">Latest 200 entries.</p>
    </div>
  );
};

const Reviews = () => {
  const [items, setItems] = useState(null);
  const load = async () => {
    try {
      setItems(unwrap(await adminService.getDriverHireReviews()).reviews || []);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load reviews'));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const moderate = async (review, status) => {
    try {
      await adminService.moderateDriverHireReview(review._id, status);
      load();
    } catch (error) {
      toast.error(errorMessage(error, 'Update failed'));
    }
  };

  return (
    <Card>
      {!items ? <Loading /> : items.length === 0 ? <Empty title="No reviews yet" /> : (
        <div className="divide-y divide-slate-100">
          {items.map((review) => (
            <div key={review._id} className="flex items-start justify-between gap-3 p-4 text-sm">
              <div>
                <div className="font-bold">★ {review.rating} <span className="font-normal text-slate-400">· {review.reviewerRole === 'user' ? 'customer → driver' : 'driver → customer'} · {formatDateTime(review.createdAt)}</span></div>
                {review.comment && <p className="mt-1 text-slate-700">{review.comment}</p>}
              </div>
              {review.moderationStatus === 'PUBLISHED'
                ? <Button variant="light" onClick={() => moderate(review, 'HIDDEN')}>Hide</Button>
                : <Button variant="light" onClick={() => moderate(review, 'PUBLISHED')}>Restore</Button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

const DriverHireReports = () => {
  const [tab, setTab] = useState('overview');
  return (
    <div className="min-h-screen bg-slate-50/50 p-4 lg:p-6">
      <PageHeader crumb="Reports" title="Reports & Support" subtitle="Bookings, completion, cancellations, driver supply, ratings and support cases." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'support' && <SupportCases />}
      {tab === 'reviews' && <Reviews />}
      {tab === 'payments' && <Payments />}
      {tab === 'audit' && <AuditLog />}
    </div>
  );
};

export default DriverHireReports;
