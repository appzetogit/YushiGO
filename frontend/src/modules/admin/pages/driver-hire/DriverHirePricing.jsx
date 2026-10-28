import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';
import { Badge, Button, Card, Empty, Loading, PageHeader } from './ui';
import { SERVICE_TYPES, errorMessage, formatDateTime, money, unwrap } from './helpers';

/**
 * Rules are versioned: saving publishes a new version and the old one stays on
 * every booking that used it. Nothing here is a market rate until an admin
 * sets it.
 */

const GROUPS = [
  {
    title: 'Time',
    fields: [
      ['baseFare', 'Base fare', 'money'],
      ['includedMinutes', 'Minutes in base fare', 'min'],
      ['minimumMinutes', 'Minimum billed minutes', 'min'],
      ['extraBlockMinutes', 'Extra-time block (min)', 'min'],
      ['extraBlockFare', 'Fare per extra block', 'money'],
    ],
  },
  {
    title: 'Waiting and night',
    fields: [
      ['freeWaitingMinutes', 'Free waiting (min)', 'min'],
      ['waitingPerMinute', 'Waiting per minute', 'money'],
      ['nightCharge', 'Night pickup charge', 'money'],
      ['nightStartHour', 'Night starts (hour 0–23)', 'hour'],
      ['nightEndHour', 'Night ends (hour 0–23)', 'hour'],
    ],
  },
  {
    title: 'Outstation',
    only: 'OUTSTATION',
    fields: [
      ['dailyAllowance', 'Driver allowance per day', 'money'],
      ['overnightAllowance', 'Overnight allowance per night', 'money'],
      ['oneWayReturnFare', 'Return travel (one-way trips)', 'money'],
    ],
  },
  {
    title: 'Fees and split',
    fields: [
      ['bookingFee', 'Booking fee', 'money'],
      ['taxPercent', 'Tax %', 'pct'],
      ['platformCommissionPercent', 'Platform commission %', 'pct'],
    ],
  },
  {
    title: 'Cancellation and no-show',
    fields: [
      ['freeCancelMinutes', 'Free cancel after assignment (min)', 'min'],
      ['freeCancelBeforePickupMinutes', 'Free cancel if pickup more than (min) away', 'min'],
      ['cancellationFee', 'Cancellation fee (driver assigned)', 'money'],
      ['lateCancellationFee', 'Late cancellation fee (driver on the way)', 'money'],
      ['noShowWaitMinutes', 'Driver waits before no-show (min)', 'min'],
      ['noShowFee', 'No-show fee', 'money'],
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((group) => group.fields.map(([key]) => key));

const blankRule = (serviceType) => ({
  serviceType,
  serviceLocationId: '',
  allowDriverExpenses: true,
  eventPackages: serviceType === 'EVENT' ? [{ code: '', name: '', minutes: 240, price: 0 }] : [],
  notes: '',
});

const PricingForm = ({ initial, locations, onClose, onSaved }) => {
  const [form, setForm] = useState(() => ({ ...initial, serviceLocationId: initial.serviceLocationId || '' }));
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    const payload = { serviceType: form.serviceType, serviceLocationId: form.serviceLocationId || null, notes: form.notes, allowDriverExpenses: form.allowDriverExpenses };
    for (const key of ALL_FIELDS) {
      if (form[key] !== '' && form[key] !== undefined && form[key] !== null) payload[key] = Number(form[key]);
    }
    if (form.serviceType === 'EVENT') payload.eventPackages = form.eventPackages.map((pkg) => ({ ...pkg, minutes: Number(pkg.minutes), price: Number(pkg.price) }));
    setSaving(true);
    try {
      await adminService.publishDriverHirePricing(payload);
      toast.success('New pricing version published');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not publish pricing'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-xl font-black">{SERVICE_TYPES[form.serviceType]} pricing</h2>
        <p className="mb-4 text-sm text-slate-500">Publishing creates a new version. Existing bookings keep the terms they were booked on.</p>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs font-bold text-slate-500">Service area</span>
          <select value={form.serviceLocationId} onChange={(event) => set('serviceLocationId', event.target.value)} disabled={Boolean(initial.id)} className="w-full rounded-xl border border-slate-200 px-3 py-2">
            <option value="">Default (all areas without their own rules)</option>
            {locations.map((location) => <option key={location._id || location.id} value={location._id || location.id}>{location.service_location_name || location.name}</option>)}
          </select>
        </label>

        {GROUPS.filter((group) => !group.only || group.only === form.serviceType).map((group) => (
          <fieldset key={group.title} className="mb-4">
            <legend className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">{group.title}</legend>
            <div className="grid grid-cols-2 gap-3">
              {group.fields.map(([key, label]) => (
                <label key={key} className="text-sm">
                  <span className="mb-1 block text-xs font-semibold text-slate-500">{label}</span>
                  <input type="number" min="0" step="any" value={form[key] ?? ''} onChange={(event) => set(key, event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2" />
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        {form.serviceType === 'EVENT' && (
          <fieldset className="mb-4">
            <legend className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Event packages</legend>
            {form.eventPackages.map((pkg, index) => (
              <div key={index} className="mb-2 grid grid-cols-[1fr_2fr_1fr_1fr_auto] gap-2">
                {[['code', 'Code'], ['name', 'Name'], ['minutes', 'Minutes'], ['price', 'Price']].map(([key, label]) => (
                  <input key={key} placeholder={label} value={pkg[key]} type={['minutes', 'price'].includes(key) ? 'number' : 'text'}
                    onChange={(event) => set('eventPackages', form.eventPackages.map((entry, i) => (i === index ? { ...entry, [key]: event.target.value } : entry)))}
                    className="rounded-xl border border-slate-200 px-2 py-1.5 text-sm" />
                ))}
                <button type="button" onClick={() => set('eventPackages', form.eventPackages.filter((_, i) => i !== index))} className="p-1 text-slate-400 hover:text-rose-600" aria-label="Remove package"><Trash2 size={16} /></button>
              </div>
            ))}
            <Button variant="light" onClick={() => set('eventPackages', [...form.eventPackages, { code: '', name: '', minutes: 240, price: 0 }])}><Plus size={12} className="inline" /> Add package</Button>
          </fieldset>
        )}

        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={Boolean(form.allowDriverExpenses)} onChange={(event) => set('allowDriverExpenses', event.target.checked)} />
          Drivers may add tolls/parking they paid for the customer (passed through at cost)
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs font-bold text-slate-500">Note for this version (internal)</span>
          <input value={form.notes || ''} onChange={(event) => set('notes', event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2" />
        </label>

        <div className="flex gap-2">
          <Button disabled={saving} onClick={save}>Publish new version</Button>
          <Button variant="light" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
};

const DriverHirePricing = () => {
  const [rules, setRules] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setRules(unwrap(await adminService.getDriverHirePricing(history)).pricing || []);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to load pricing'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [history]);

  useEffect(() => {
    adminService.getServiceLocations()
      .then((response) => setLocations(response?.data?.results || response?.data || []))
      .catch(() => setLocations([]));
  }, []);

  const locationName = useMemo(() => {
    const map = new Map(locations.map((location) => [String(location._id || location.id), location.service_location_name || location.name]));
    return (id) => (id ? map.get(String(id)) || 'Unknown area' : 'Default');
  }, [locations]);

  const missing = Object.keys(SERVICE_TYPES).filter((type) => !rules.some((rule) => rule.current && rule.serviceType === type && !rule.serviceLocationId));

  return (
    <div className="min-h-screen bg-slate-50/50 p-4 lg:p-6">
      <PageHeader
        crumb="Pricing"
        title="Driver Hire Pricing"
        subtitle="Per service type and area. The customer sees these as an itemised estimate with the waiting, overtime and cancellation terms."
        actions={(
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
            <input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} /> Show old versions
          </label>
        )}
      />

      {missing.length > 0 && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          No default pricing yet for: {missing.map((type) => SERVICE_TYPES[type]).join(', ')}. Customers cannot book these until you set it.
          <div className="mt-2 flex flex-wrap gap-2">
            {missing.map((type) => <Button key={type} variant="light" onClick={() => setEditing(blankRule(type))}>Set {SERVICE_TYPES[type]}</Button>)}
          </div>
        </div>
      )}

      <Card>
        {loading ? <Loading /> : rules.length === 0 ? (
          <Empty title="No pricing yet" hint="Set default pricing for each service type to open Search a Driver." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead>
                <tr className="text-left text-xs font-bold text-slate-500">
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Version</th>
                  <th className="px-4 py-3">Base</th>
                  <th className="px-4 py-3">Extra block</th>
                  <th className="px-4 py-3">Commission</th>
                  <th className="px-4 py-3">Cancel / late / no-show</th>
                  <th className="px-4 py-3">Published</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((rule) => (
                  <tr key={rule._id} className={rule.current ? '' : 'text-slate-400'}>
                    <td className="px-4 py-3 font-bold">{SERVICE_TYPES[rule.serviceType]}</td>
                    <td className="px-4 py-3">{locationName(rule.serviceLocationId)}</td>
                    <td className="px-4 py-3">v{rule.version} {rule.current ? <Badge value="APPROVED" label="current" /> : null}</td>
                    <td className="px-4 py-3">{rule.serviceType === 'EVENT' ? `${rule.eventPackages.length} package(s)` : `${money(rule.baseFare, rule.currency)} / ${rule.includedMinutes}m`}</td>
                    <td className="px-4 py-3">{money(rule.extraBlockFare, rule.currency)} / {rule.extraBlockMinutes}m</td>
                    <td className="px-4 py-3">{rule.platformCommissionPercent}%</td>
                    <td className="px-4 py-3">{money(rule.cancellationFee)} / {money(rule.lateCancellationFee)} / {money(rule.noShowFee)}</td>
                    <td className="px-4 py-3">{formatDateTime(rule.createdAt)}</td>
                    <td className="px-4 py-3 text-right">{rule.current && <Button variant="light" onClick={() => setEditing({ ...rule, id: rule._id })}>Edit</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        {Object.keys(SERVICE_TYPES).map((type) => (
          <Button key={type} variant="light" onClick={() => setEditing(blankRule(type))}><Plus size={12} className="inline" /> {SERVICE_TYPES[type]} rule for an area</Button>
        ))}
      </div>

      {editing && <PricingForm initial={editing} locations={locations} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
};

export default DriverHirePricing;
