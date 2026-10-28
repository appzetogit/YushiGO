import React from 'react';
import { STATUS_LABELS } from './helpers';

/** Small components shared by the Search a Driver admin pages. */

const STATUS_STYLES = {
  REQUESTED: 'bg-amber-50 text-amber-700',
  DRIVER_ASSIGNED: 'bg-sky-50 text-sky-700',
  DRIVER_EN_ROUTE: 'bg-sky-50 text-sky-700',
  DRIVER_ARRIVED: 'bg-indigo-50 text-indigo-700',
  TRIP_STARTED: 'bg-violet-50 text-violet-700',
  TRIP_COMPLETED: 'bg-emerald-50 text-emerald-700',
  DISPUTED: 'bg-rose-50 text-rose-700',
  EXPIRED: 'bg-slate-100 text-slate-600',
  PENDING: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-rose-50 text-rose-700',
  SUSPENDED: 'bg-slate-200 text-slate-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-rose-50 text-rose-700',
  OPEN: 'bg-amber-50 text-amber-700',
  IN_PROGRESS: 'bg-sky-50 text-sky-700',
  RESOLVED: 'bg-emerald-50 text-emerald-700',
  CLOSED: 'bg-slate-100 text-slate-600',
  URGENT: 'bg-rose-600 text-white',
  HIGH: 'bg-rose-50 text-rose-700',
};

export const Badge = ({ value, label }) => (
  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold ${STATUS_STYLES[value] || (String(value).startsWith('CANCELLED') ? 'bg-slate-100 text-slate-600' : 'bg-slate-100 text-slate-700')}`}>
    {label || STATUS_LABELS[value] || String(value || '').replace(/_/g, ' ').toLowerCase()}
  </span>
);

export const PageHeader = ({ crumb, title, subtitle, actions = null }) => (
  <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400">
        <span>Search a Driver</span>
        <span>/</span>
        <span className="text-yellow-600">{crumb}</span>
      </div>
      <h1 className="text-2xl font-black text-slate-900">{title}</h1>
      {subtitle && <p className="text-sm font-medium text-slate-500">{subtitle}</p>}
    </div>
    {actions}
  </div>
);

export const Tabs = ({ tabs, value, onChange }) => (
  <div className="mb-4 inline-flex flex-wrap rounded-2xl border border-slate-200 bg-white p-1">
    {tabs.map((tab) => (
      <button
        key={tab.key}
        onClick={() => onChange(tab.key)}
        className={`rounded-xl px-4 py-1.5 text-sm font-bold transition ${value === tab.key ? 'bg-black text-white' : 'text-slate-600 hover:bg-slate-50'}`}
      >
        {tab.label}
      </button>
    ))}
  </div>
);

export const Card = ({ children, className = '' }) => (
  <div className={`overflow-hidden rounded-[28px] border border-slate-100 bg-white shadow-sm ${className}`}>{children}</div>
);

export const Empty = ({ title, hint }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <h3 className="text-lg font-black text-slate-900">{title}</h3>
    {hint && <p className="mt-1 max-w-sm text-sm font-medium text-slate-500">{hint}</p>}
  </div>
);

export const Loading = () => (
  <div className="space-y-4 p-6">
    {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />)}
  </div>
);

export const Button = ({ variant = 'dark', className = '', ...props }) => {
  const styles = {
    dark: 'bg-black text-white hover:bg-slate-800',
    light: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700',
  };
  return (
    <button
      type="button"
      {...props}
      className={`rounded-xl px-3 py-1.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    />
  );
};
