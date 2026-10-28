import React, { useEffect, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';
import { Badge, Button, Card, Empty, Loading, PageHeader, Tabs } from './ui';
import { SERVICE_TYPES, STATUS_LABELS, askReason, errorMessage, formatDateTime, formatMinutes, money, unwrap } from './helpers';

const TABS = [
  { key: 'attention', label: 'Needs a driver' },
  { key: 'active', label: 'Active' },
  { key: 'TRIP_COMPLETED', label: 'Completed' },
  { key: 'DISPUTED', label: 'Disputed' },
  { key: 'closed', label: 'Cancelled / expired' },
  { key: 'all', label: 'All' },
];

const TAB_QUERY = {
  attention: { attention: 'true' },
  active: { status: 'REQUESTED,DRIVER_ASSIGNED,DRIVER_EN_ROUTE,DRIVER_ARRIVED,TRIP_STARTED' },
  TRIP_COMPLETED: { status: 'TRIP_COMPLETED' },
  DISPUTED: { status: 'DISPUTED' },
  closed: { status: 'CANCELLED_BY_CUSTOMER,CANCELLED_BY_DRIVER,CANCELLED_BY_ADMIN,EXPIRED' },
  all: {},
};

const BEFORE_START = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
const FINISHED = ['TRIP_COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_DRIVER', 'CANCELLED_BY_ADMIN', 'EXPIRED'];

const FareLines = ({ title, fare, currency }) => (
  <div>
    <div className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">{title}</div>
    <div className="space-y-1 rounded-2xl bg-slate-50 p-3 text-sm">
      {(fare?.lines || []).map((line, index) => (
        <div key={`${line.code}-${index}`} className="flex justify-between gap-3">
          <span className="text-slate-600">{line.label}</span>
          <span className="font-semibold text-slate-800">{money(line.amount, currency)}</span>
        </div>
      ))}
      {fare?.tax > 0 && (
        <div className="flex justify-between"><span className="text-slate-600">Tax</span><span className="font-semibold">{money(fare.tax, currency)}</span></div>
      )}
      <div className="flex justify-between border-t border-slate-200 pt-1 font-black">
        <span>Total</span><span>{money(fare?.total, currency)}</span>
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>Platform {money(fare?.platformFee, currency)}</span>
        <span>Driver {money(fare?.driverAmount, currency)}</span>
      </div>
    </div>
  </div>
);

const BookingDrawer = ({ bookingId, onClose, onChanged }) => {
  const [detail, setDetail] = useState(null);
  const [drivers, setDrivers] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setDetail(unwrap(await adminService.getDriverHireBooking(bookingId)));
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load booking'));
    }
  };

  useEffect(() => {
    setDetail(null);
    setDrivers(null);
    load();
  }, [bookingId]);

  const run = async (fn, success) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      await load();
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Action failed'));
    } finally {
      setBusy(false);
    }
  };

  const findDrivers = async () => {
    try {
      setDrivers(unwrap(await adminService.getDriverHireEligibleDrivers(bookingId)).drivers || []);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load drivers'));
    }
  };

  if (!detail) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
        <div className="h-full w-full max-w-xl bg-white p-6" onClick={(event) => event.stopPropagation()}><Loading /></div>
      </div>
    );
  }

  const { booking, payments = [], supportCases = [] } = detail;
  const currency = booking.fare?.currency || 'INR';

  const cancel = () => {
    const reason = askReason('Why is this booking being cancelled? This is recorded and shown to the customer.');
    if (!reason) return;
    const charge = detail.cancellationFeeIfCancelledNow > 0
      && window.confirm(`Charge the customer the ${money(detail.cancellationFeeIfCancelledNow, currency)} cancellation fee? Cancel = waive it.`);
    run(() => adminService.cancelDriverHireBooking(bookingId, reason, charge), 'Booking cancelled');
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-slate-400">{SERVICE_TYPES[booking.serviceType]}</div>
            <h2 className="text-xl font-black text-slate-900">{booking.bookingCode}</h2>
            <div className="mt-1"><Badge value={booking.status} /></div>
          </div>
          <button onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
          <div><div className="text-xs font-bold text-slate-400">Customer</div><div className="font-semibold">{booking.customer?.name || '-'}</div><div className="text-slate-500">{booking.customer?.phone}</div></div>
          <div><div className="text-xs font-bold text-slate-400">Driver</div><div className="font-semibold">{booking.driver?.name || 'Not assigned'}</div><div className="text-slate-500">{booking.driver?.phone}</div></div>
          <div><div className="text-xs font-bold text-slate-400">Pickup</div><div className="font-semibold">{formatDateTime(booking.scheduledAt)}</div><div className="text-slate-500">{booking.pickup?.address}</div></div>
          <div><div className="text-xs font-bold text-slate-400">Destination</div><div className="text-slate-600">{booking.destination?.address || 'Local / as directed'}</div></div>
          <div><div className="text-xs font-bold text-slate-400">Car</div><div className="font-semibold">{booking.vehicle?.make} {booking.vehicle?.model}</div><div className="text-slate-500">{booking.vehicle?.transmission?.toLowerCase()}</div></div>
          <div><div className="text-xs font-bold text-slate-400">Duration</div><div className="font-semibold">{formatMinutes(booking.durationMinutes)}{booking.nights ? ` · ${booking.nights} night(s)` : ''}</div><div className="text-slate-500">{booking.paymentMethod?.toLowerCase()}</div></div>
        </div>
        {booking.requirements && <p className="mb-4 rounded-2xl bg-amber-50 p-3 text-sm text-amber-800">{booking.requirements}</p>}
        {booking.offer?.driverId && (
          <p className="mb-4 rounded-2xl bg-sky-50 p-3 text-sm text-sky-800">Offered to a driver until {formatDateTime(booking.offer.expiresAt)}.</p>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          {booking.status === 'REQUESTED' && <Button disabled={busy} onClick={findDrivers}>Find eligible drivers</Button>}
          {BEFORE_START.includes(booking.status) && (
            <Button variant="light" disabled={busy} onClick={() => {
              const reason = askReason('Why is the driver being taken off this booking?');
              if (reason) run(() => adminService.reassignDriverHireBooking(bookingId, reason), 'Back in the queue');
            }}>Reassign</Button>
          )}
          {!FINISHED.includes(booking.status) && booking.status !== 'DISPUTED' && <Button variant="danger" disabled={busy} onClick={cancel}>Cancel booking</Button>}
          {booking.status === 'TRIP_COMPLETED' && (
            <Button variant="light" disabled={busy} onClick={() => {
              const note = askReason('What is disputed?');
              if (note) run(() => adminService.openDriverHireDispute(bookingId, note), 'Dispute opened');
            }}>Open dispute</Button>
          )}
          {booking.status === 'DISPUTED' && (
            <Button variant="success" disabled={busy} onClick={() => {
              const outcome = askReason('Outcome of the dispute (recorded on the booking):');
              if (!outcome) return;
              const refund = Number(window.prompt('Refund amount (0 for none):', '0') || 0);
              run(() => adminService.resolveDriverHireDispute(bookingId, outcome, refund), 'Dispute resolved');
            }}>Resolve dispute</Button>
          )}
        </div>

        {drivers && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Eligible drivers ({drivers.length})</div>
            {drivers.length === 0 ? (
              <p className="text-sm text-slate-500">No approved driver matches this car, time and area.</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
                {drivers.map((driver) => (
                  <div key={driver.driverId} className="flex items-center justify-between gap-3 p-3">
                    <div className="text-sm">
                      <div className="font-bold">{driver.name} <span className={`ml-1 text-xs ${driver.isOnline ? 'text-emerald-600' : 'text-slate-400'}`}>{driver.isOnline ? 'online' : 'offline'}</span></div>
                      <div className="text-slate-500">{driver.phone} · ★ {driver.rating || '-'} · {driver.experienceYears} yrs</div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="light" disabled={busy} onClick={() => run(() => adminService.assignDriverHireBooking(bookingId, driver.driverId, false), 'Offer sent')}>Offer</Button>
                      <Button disabled={busy} onClick={() => {
                        if (window.confirm(`Assign ${driver.name} directly? Only do this if they have already agreed.`)) {
                          run(() => adminService.assignDriverHireBooking(bookingId, driver.driverId, true), 'Driver assigned');
                        }
                      }}>Assign</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mb-4 grid gap-3">
          <FareLines title="Estimate" fare={booking.fare} currency={currency} />
          {booking.final?.total !== null && booking.final?.total !== undefined && <FareLines title={`Final (${formatMinutes(booking.final.actualMinutes)} driven)`} fare={booking.final} currency={currency} />}
        </div>

        {booking.cancellation?.reason && (
          <p className="mb-4 rounded-2xl bg-slate-50 p-3 text-sm">
            <span className="font-bold">Cancellation:</span> {booking.cancellation.reason}
            {booking.cancellation.fee > 0 && ` · fee ${money(booking.cancellation.fee, currency)}`}
            {booking.cancellation.noShow && ' · no-show'}
          </p>
        )}
        {booking.dispute?.openedAt && (
          <p className="mb-4 rounded-2xl bg-rose-50 p-3 text-sm text-rose-800">
            <span className="font-bold">Dispute:</span> {booking.dispute.note}
            {booking.dispute.outcome && <><br /><span className="font-bold">Outcome:</span> {booking.dispute.outcome}</>}
          </p>
        )}

        {payments.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Payments</div>
            <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
              {payments.map((payment) => (
                <div key={payment.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <div className="font-bold">{payment.kind === 'TRIP' ? 'Trip' : 'Cancellation fee'} · {money(payment.amount, payment.currency)} · {payment.method.toLowerCase()}</div>
                    <div className="text-slate-500">
                      <Badge value={payment.paymentStatus} />
                      {payment.refundAmount > 0 && <span className="ml-2">refund {money(payment.refundAmount, payment.currency)} ({payment.refundStatus.toLowerCase()})</span>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {['PENDING', 'FAILED'].includes(payment.paymentStatus) && (
                      <Button variant="success" disabled={busy} onClick={() => run(() => adminService.setDriverHirePaymentStatus(payment.id, 'PAID'), 'Marked paid')}>Mark paid</Button>
                    )}
                    {payment.paymentStatus === 'PAID' && payment.refundAmount < payment.amount && (
                      <Button variant="light" disabled={busy} onClick={() => {
                        const amount = Number(window.prompt('Refund amount:', String(payment.amount - payment.refundAmount)) || 0);
                        const reason = amount > 0 ? askReason('Refund reason:') : null;
                        if (reason) run(() => adminService.refundDriverHirePayment(payment.id, amount, reason), 'Refund recorded');
                      }}>Refund</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {supportCases.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Support cases</div>
            {supportCases.map((entry) => (
              <div key={entry._id} className="mb-2 rounded-2xl border border-slate-100 p-3 text-sm">
                <div className="flex gap-2"><Badge value={entry.priority} /><Badge value={entry.status} /><span className="font-bold">{entry.category.replace(/_/g, ' ').toLowerCase()}</span></div>
                <p className="mt-1 text-slate-600">{entry.description}</p>
              </div>
            ))}
          </div>
        )}

        <div>
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Timeline</div>
          <ol className="space-y-1.5 text-sm">
            {(booking.timeline || []).map((entry, index) => (
              <li key={index} className="flex gap-3">
                <span className="w-28 shrink-0 text-slate-400">{formatDateTime(entry.at)}</span>
                <span className="font-semibold text-slate-700">{entry.event ? entry.event.replace(/_/g, ' ').toLowerCase() : STATUS_LABELS[entry.status]}</span>
                <span className="text-slate-400">{entry.actorRole}</span>
                {entry.note && <span className="text-slate-500">· {entry.note}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
};

const DriverHireBookings = () => {
  const [tab, setTab] = useState('attention');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = unwrap(await adminService.getDriverHireBookings({ ...TAB_QUERY[tab], q: search || undefined, limit: 50 }));
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load bookings'));
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
        crumb="Bookings"
        title="Driver Bookings"
        subtitle="Customers booking a verified driver for their own car. Assign, reassign, cancel and settle disputes here."
        actions={<Button variant="light" onClick={load}><RefreshCw size={14} className="inline" /> Refresh</Button>}
      />

      <div className="flex flex-wrap items-start gap-3">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <form className="mb-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-1.5" onSubmit={(event) => { event.preventDefault(); load(); }}>
          <Search size={14} className="text-slate-400" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Booking code" className="w-36 bg-transparent text-sm outline-none" />
        </form>
      </div>

      <Card>
        {loading ? <Loading /> : items.length === 0 ? (
          <Empty title="Nothing here" hint={tab === 'attention' ? 'No unassigned bookings are due in the next hour.' : 'No bookings match.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead>
                <tr className="text-left text-xs font-bold text-slate-500">
                  <th className="px-4 py-3">Booking</th>
                  <th className="px-4 py-3">Pickup</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Driver</th>
                  <th className="px-4 py-3">Car</th>
                  <th className="px-4 py-3">Fare</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((booking) => (
                  <tr key={booking.id} onClick={() => setOpenId(booking.id)} className="cursor-pointer text-sm transition hover:bg-slate-50/70">
                    <td className="px-4 py-3"><div className="font-black">{booking.bookingCode}</div><div className="text-xs text-slate-500">{SERVICE_TYPES[booking.serviceType]} · {formatMinutes(booking.durationMinutes)}</div></td>
                    <td className="px-4 py-3"><div className="font-semibold">{formatDateTime(booking.scheduledAt)}</div><div className="max-w-[220px] truncate text-xs text-slate-500">{booking.pickup?.address}</div></td>
                    <td className="px-4 py-3">{booking.customer?.name || '-'}</td>
                    <td className="px-4 py-3">{booking.driver?.name || <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">{booking.vehicle?.make} {booking.vehicle?.model}<div className="text-xs text-slate-500">{booking.vehicle?.transmission?.toLowerCase()}</div></td>
                    <td className="px-4 py-3 font-semibold">{money(booking.final?.total ?? booking.fare?.total, booking.fare?.currency)}</td>
                    <td className="px-4 py-3"><Badge value={booking.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-3 text-xs text-slate-500">{total} booking(s)</div>
          </div>
        )}
      </Card>

      {openId && <BookingDrawer bookingId={openId} onClose={() => setOpenId('')} onChanged={load} />}
    </div>
  );
};

export default DriverHireBookings;
