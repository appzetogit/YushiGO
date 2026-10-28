import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';
import { Badge, Button, Card, Empty, Loading, PageHeader, Tabs } from './ui';
import { SERVICE_TYPES, askReason, errorMessage, formatDateTime, money, unwrap } from './helpers';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'support', label: 'Support & safety' },
  { key: 'reviews', label: 'Reviews' },
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
    </div>
  );
};

export default DriverHireReports;
