import React, { useState, useEffect } from 'react';
import {
  Search,
  MoreVertical,
  FileText,
  Star,
  Plus,
  Eye,
  Edit2,
  Key,
  XCircle,
  Trash2,
  Lock,
  Loader2,
  ChevronRight,
  Filter,
  List,
  LayoutGrid,
  Wallet
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { adminService } from '../../services/adminService';
import { AnimatePresence } from 'framer-motion';

const ACTION_MENU_WIDTH = 220;
const ACTION_MENU_GAP = 8;
const ACTION_MENU_MAX_HEIGHT = 260;

const DriverList = ({ mode = 'approved' }) => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeMenu, setActiveMenu] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ dateRange: '', vehicleType: '' });
  const [passwordModal, setPasswordModal] = useState({ isOpen: false, driverId: null, password: '', isSubmitting: false });
  const [walletModal, setWalletModal] = useState(null);
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [paginator, setPaginator] = useState(null);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  const fetchDrivers = async ({ nextPage = page, nextLimit = itemsPerPage, nextSearch = searchTerm } = {}) => {
    setIsLoading(true);
    setError('');
    try {
      const responseData = await adminService.getDrivers(nextPage, nextLimit, {
        ...(mode === 'active' ? { isOnline: true } : { approve: true }),
        search: String(nextSearch || '').trim(),
      });
      const driversList = responseData.data?.results || [];
      if (responseData.success) {
        const visibleDrivers = mode === 'active'
          ? driversList.filter((d) => Boolean(d.isOnline))
          : driversList;

        const approved = visibleDrivers.map((d) => ({
          id: d._id,
          name: d.name || 'Unknown',
          driverCode: d.driver_code || d.referralCode || (d.phone ? `DRV${String(d.phone).slice(-4)}${String(d._id || d.id || '').slice(-6).toUpperCase()}`.replace(/\W/g, '') : 'N/A'),
          serviceLocation: d.service_location_name || d.city || d.service_location?.name || 'India',
          phone: d.phone || d.mobile || 'N/A',
          transportType: d.transport_type || d.register_for || d.vehicle_type || 'All - Bike',
          rating: Number(d.rating_count || d.ratingCount || 0) > 0
            ? Number(d.rating || d.average_rating || d.avg_rating || 0)
            : 0,
          isOnline: Boolean(d.isOnline),
          onlineSelfieImage: d.online_selfie_image || '',
          onlineSelfieCapturedAt: d.online_selfie_captured_at || null,
          registeredAt: d.createdAt || null,
          active: d.active !== false,
          walletBalance: Number(d.wallet_balance || 0),
          status: mode === 'active' ? 'Online' : (d.approve ? 'Approved' : (d.status || 'Approved')),
        }));
        setDrivers(approved);
        setPaginator(responseData.data?.paginator || null);
      } else {
        setError(responseData.message || 'Failed to fetch drivers');
      }
    } catch (err) {
      setError(err.message || 'Network error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDrivers({ nextPage: 1, nextLimit: itemsPerPage, nextSearch: searchTerm });
    setPage(1);
  }, [itemsPerPage]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      fetchDrivers({ nextPage: 1, nextLimit: itemsPerPage, nextSearch: searchTerm });
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchTerm]);

  useEffect(() => {
    fetchDrivers({ nextPage: page, nextLimit: itemsPerPage, nextSearch: searchTerm });
  }, [page]);

  const closeMenu = () => {
    setActiveMenu(null);
    setMenuPosition(null);
  };

  const toggleMenu = (e, userId) => {
    e.stopPropagation();
    if (activeMenu === userId) {
      closeMenu();
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const viewportPadding = 12;
    const spaceBelow = window.innerHeight - rect.bottom - ACTION_MENU_GAP;
    const spaceAbove = rect.top - ACTION_MENU_GAP;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;

    const left = Math.min(
      Math.max(viewportPadding, rect.right - ACTION_MENU_WIDTH),
      window.innerWidth - ACTION_MENU_WIDTH - viewportPadding,
    );

    setMenuPosition({
      left,
      ...(openUp
        ? { bottom: Math.max(viewportPadding, window.innerHeight - rect.top + ACTION_MENU_GAP) }
        : {
            top: Math.max(
              viewportPadding,
              Math.min(
                rect.bottom + ACTION_MENU_GAP,
                window.innerHeight - ACTION_MENU_MAX_HEIGHT - viewportPadding,
              ),
            ),
          }),
    });
    setActiveMenu(userId);
  };

  useEffect(() => {
    if (!activeMenu) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu();
    };

    const handleReset = () => closeMenu();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleReset, true);
    window.addEventListener('resize', handleReset);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleReset, true);
      window.removeEventListener('resize', handleReset);
    };
  }, [activeMenu]);

  const handleAction = async (action, driverId) => {
    const confirmMsg = action === 'delete' ? 'Are you sure you want to delete this driver?' : 'Are you sure you want to disapprove this driver?';
    if (action !== 'password' && !window.confirm(confirmMsg)) return;

    try {
      let resData;
      if (action === 'delete') {
        resData = await adminService.deleteDriver(driverId);
      } else if (action === 'disapprove') {
        resData = await adminService.updateDriverStatus(driverId, { approve: false, status: 'disapproved', active: false });
      } else if (action === 'password') {
        setPasswordModal(prev => ({ ...prev, isSubmitting: true }));
        resData = await adminService.updateDriverPassword(driverId, passwordModal.password);
      }

      if (resData.success) {
        alert(`${action.charAt(0).toUpperCase() + action.slice(1)} successful`);
        if (action === 'delete' || action === 'disapprove') {
          setDrivers(prev => prev.filter(d => d.id !== driverId));
        }
        if (action === 'password') {
          setPasswordModal({ isOpen: false, driverId: null, password: '', isSubmitting: false });
        }
      } else {
        alert(resData.message || `Failed to ${action}`);
        if (action === 'password') setPasswordModal(prev => ({ ...prev, isSubmitting: false }));
      }
    } catch (err) {
      alert(err.message || `Network error during ${action}`);
      if (action === 'password') setPasswordModal(prev => ({ ...prev, isSubmitting: false }));
    }
  };

  const toggleDriverActive = async (driver) => {
    const nextActive = !driver.active;
    if (!nextActive && !window.confirm(`Deactivate ${driver.name}? They will be taken offline and cannot go online until reactivated.`)) return;

    setStatusUpdatingId(driver.id);
    try {
      const resData = await adminService.updateDriverStatus(driver.id, { status: nextActive ? 'approved' : 'inactive' });
      if (resData.success) {
        setDrivers(prev => prev.map(d => (d.id === driver.id ? { ...d, active: nextActive, isOnline: nextActive ? d.isOnline : false } : d)));
      } else {
        alert(resData.message || 'Failed to update status');
      }
    } catch (err) {
      alert(err.message || 'Network error while updating status');
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const openWalletModal = (driver) => {
    if (!driver) return;
    setWalletModal({ driver, mode: 'credit', amount: '', description: '', isSubmitting: false });
  };

  // What the modal will send: "set balance" becomes a credit or debit of the difference.
  const walletChange = (() => {
    if (!walletModal || walletModal.amount === '') return null;
    const amount = Math.round(Number(walletModal.amount) * 100) / 100;
    if (!Number.isFinite(amount)) return null;
    if (walletModal.mode === 'set') {
      const diff = Math.round((amount - walletModal.driver.walletBalance) * 100) / 100;
      if (diff === 0) return null;
      return { operation: diff > 0 ? 'credit' : 'debit', amount: Math.abs(diff) };
    }
    if (amount <= 0) return null;
    return { operation: walletModal.mode, amount };
  })();

  const submitWallet = async () => {
    if (!walletModal || !walletChange) return;
    const { driver, description } = walletModal;
    setWalletModal(prev => ({ ...prev, isSubmitting: true }));
    try {
      const resData = await adminService.adjustDriverWallet(driver.id, {
        ...walletChange,
        description: String(description || '').trim() || undefined,
      });
      if (resData.success) {
        const balance = Number(resData.data?.balance ?? driver.walletBalance);
        setDrivers(prev => prev.map(d => (d.id === driver.id ? { ...d, walletBalance: balance } : d)));
        setWalletModal(null);
      } else {
        alert(resData.message || 'Failed to update wallet');
        setWalletModal(prev => ({ ...prev, isSubmitting: false }));
      }
    } catch (err) {
      alert(err.message || 'Network error while updating wallet');
      setWalletModal(prev => ({ ...prev, isSubmitting: false }));
    }
  };

  const formatMoney = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const formatDate = (value) => {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  };

  const totalPages = Math.max(1, Number(paginator?.last_page || 1));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const totalEntries = Number(paginator?.total || 0);
  const perPage = Number(paginator?.per_page || itemsPerPage);
  const startIndex = (safePage - 1) * perPage;
  const showingFrom = totalEntries === 0 ? 0 : startIndex + 1;
  const showingTo = totalEntries === 0 ? 0 : Math.min(startIndex + drivers.length, totalEntries);

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-3 lg:p-4 font-sans text-gray-900">
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
          {error}
        </div>
      )}
      <div className="mb-3">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-0.5">
          <span>Drivers</span>
          <ChevronRight size={10} />
          <span className="text-gray-700 font-medium">{mode === 'active' ? 'Active Drivers' : 'Approved Drivers'}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-base text-gray-900 font-bold">{mode === 'active' ? 'Active Drivers' : 'Approved Drivers'}</h1>
          {mode !== 'active' ? (
            <button
              onClick={() => navigate('/admin/drivers/create')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-black font-semibold bg-yellow-400 rounded-md shadow-sm hover:bg-yellow-500 transition-colors"
            >
              <Plus size={14} /> Add Drivers
            </button>
          ) : null}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative w-full sm:w-auto">
             <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
             <input
               className="w-full sm:w-[280px] pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:border-yellow-400"
               placeholder="Search by name, phone, or location"
               value={searchTerm}
               onChange={(e) => setSearchTerm(e.target.value)}
             />
          </div>
          
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span>Show</span>
              <select
                value={itemsPerPage}
                onChange={(e) => setItemsPerPage(parseInt(e.target.value, 10))}
                className="border border-gray-200 rounded-md px-1.5 py-1 text-xs text-gray-700 font-semibold focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:border-yellow-400"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </div>
            <button 
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 transition-colors ml-auto sm:ml-0"
            >
              <Filter size={14} /> Filters
            </button>
          </div>
        </div>
        
        {/* Filters Panel */}
        {showFilters && (
          <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Date Range</label>
              <select 
                value={filters.dateRange}
                onChange={(e) => setFilters({...filters, dateRange: e.target.value})}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs text-gray-700 bg-gray-50 outline-none focus:border-yellow-400 focus:bg-white"
              >
                <option value="">All Time</option>
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Vehicle Type</label>
              <select 
                value={filters.vehicleType}
                onChange={(e) => setFilters({...filters, vehicleType: e.target.value})}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs text-gray-700 bg-gray-50 outline-none focus:border-yellow-400 focus:bg-white"
              >
                <option value="">All Types</option>
                <option value="sedan">Sedan</option>
                <option value="suv">SUV</option>
                <option value="hatchback">Hatchback</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Table Card */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-visible">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse whitespace-nowrap">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Mobile</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Selfie</th>
                <th className="px-3 py-2 text-center">Docs</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2">Wallet</th>
                <th className="px-3 py-2">Rating</th>
                <th className="px-3 py-2">Registered</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs text-gray-700">
              {isLoading ? (
                <tr>
                  <td colSpan="12" className="px-3 py-6 text-center text-gray-400">Loading drivers...</td>
                </tr>
              ) : drivers.length === 0 ? (
                <tr>
                  <td colSpan="12" className="px-3 py-6 text-center text-gray-400">No drivers found.</td>
                </tr>
              ) : (
                drivers.map((driver) => (
                  <tr key={driver.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-1.5 font-medium text-gray-900">{driver.name}</td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
                        {driver.driverCode}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-gray-600">{driver.serviceLocation}</td>
                    <td className="px-3 py-1.5 font-medium">{driver.phone}</td>
                    <td className="px-3 py-1.5 text-gray-600">{driver.transportType}</td>
                    <td className="px-3 py-1.5">
                      {driver.onlineSelfieImage ? (
                        <button
                          type="button"
                          onClick={() => window.open(driver.onlineSelfieImage, '_blank', 'noopener,noreferrer')}
                          className="flex items-center gap-1.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 hover:bg-gray-50 transition-colors"
                        >
                          <img src={driver.onlineSelfieImage} alt={`${driver.name} selfie`} className="h-5 w-5 rounded object-cover" />
                        </button>
                      ) : (
                        <span className="text-[10px] text-gray-400">No selfie</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button
                        onClick={() => navigate(`/admin/drivers/${driver.id}?tab=Documents`)}
                        className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-black transition-colors"
                        title="View Documents"
                      >
                        <FileText size={12} />
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {mode === 'active' ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-800 border border-green-200 capitalize">
                          {driver.status}
                        </span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={driver.active}
                          disabled={statusUpdatingId === driver.id}
                          onClick={() => toggleDriverActive(driver)}
                          title={driver.active ? 'Active - click to deactivate' : 'Inactive - click to activate'}
                          className="inline-flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${driver.active ? 'bg-green-500' : 'bg-gray-300'}`}>
                            <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${driver.active ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                          </span>
                          <span className={`text-[10px] font-bold ${driver.active ? 'text-green-700' : 'text-gray-500'}`}>
                            {driver.active ? 'Active' : 'Inactive'}
                          </span>
                        </button>
                      )}
                      {mode !== 'active' && (
                        <div className={`mt-0.5 flex items-center justify-center gap-1 text-[10px] font-semibold ${driver.isOnline ? 'text-green-600' : 'text-gray-400'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${driver.isOnline ? 'bg-green-500' : 'bg-gray-300'}`} />
                          {driver.isOnline ? 'Online' : 'Offline'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => openWalletModal(driver)}
                        className={`inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 font-semibold hover:bg-gray-50 transition-colors ${driver.walletBalance < 0 ? 'text-red-600' : 'text-gray-800'}`}
                        title="Edit wallet balance"
                      >
                        {formatMoney(driver.walletBalance)}
                        <Edit2 size={10} className="text-gray-400" />
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map((s) => (
                          <Star key={s} size={10} className={s <= Math.round(driver.rating) ? "fill-yellow-400 text-yellow-400" : "text-gray-200"} />
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-[10px] text-gray-500 whitespace-nowrap">{formatDate(driver.registeredAt)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="relative inline-block">
                        <button 
                          onClick={(e) => toggleMenu(e, driver.id)}
                          className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 transition-colors"
                        >
                          <MoreVertical size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!isLoading && drivers.length > 0 && (
          <div className="p-3 flex items-center justify-between text-xs text-gray-500 border-t border-gray-100 bg-gray-50/50">
            <span>Showing {showingFrom} to {showingTo} of {totalEntries} entries</span>
            <div className="flex items-center gap-1">
              <button
                className="px-2 py-1 font-semibold hover:text-black disabled:opacity-50"
                disabled={safePage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Prev
              </button>
              <button className="px-2.5 py-1 rounded bg-yellow-400 text-black font-bold">{safePage}</button>
              <button
                className="px-2 py-1 font-semibold hover:text-black disabled:opacity-50"
                disabled={safePage >= totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {activeMenu && menuPosition && createPortal(
        <>
          <div className="fixed inset-0 z-[9998] bg-transparent" onClick={closeMenu} />
          <div
            className="fixed z-[9999] bg-white rounded-xl shadow-xl border border-gray-200 p-1.5 overflow-y-auto transform origin-top-right transition-all"
            style={{
              width: ACTION_MENU_WIDTH,
              maxHeight: `min(${ACTION_MENU_MAX_HEIGHT}px, calc(100vh - 24px))`,
              ...menuPosition,
            }}
          >
            <button
              onClick={() => {
                closeMenu();
                handleAction('disapprove', activeMenu);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-red-50 hover:text-red-700 text-gray-700 rounded-lg transition-colors text-sm font-medium"
            >
              <XCircle size={15} className="text-red-600" /> Disapprove
            </button>
            <button
              onClick={() => {
                closeMenu();
                navigate(`/admin/drivers/edit/${activeMenu}`);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 text-gray-700 rounded-lg transition-colors text-sm font-medium"
            >
              <Edit2 size={15} className="text-yellow-600" /> Edit Details
            </button>
            <button
              onClick={() => {
                closeMenu();
                setPasswordModal({ isOpen: true, driverId: activeMenu, password: '', isSubmitting: false });
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 text-gray-700 rounded-lg transition-colors text-sm font-medium"
            >
              <Key size={15} className="text-blue-600" /> Reset Password
            </button>
            <button
              onClick={() => {
                const driver = drivers.find(d => d.id === activeMenu);
                closeMenu();
                openWalletModal(driver);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 text-gray-700 rounded-lg transition-colors text-sm font-medium"
            >
              <Wallet size={15} className="text-emerald-600" /> Edit Wallet
            </button>
            <button
              onClick={() => {
                closeMenu();
                navigate(`/admin/drivers/${activeMenu}`);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 text-gray-700 rounded-lg transition-colors text-sm font-medium"
            >
              <Eye size={15} className="text-gray-500" /> View Profile
            </button>
            <div className="h-px bg-gray-100 my-1 mx-1" />
            <button
              onClick={() => {
                closeMenu();
                handleAction('delete', activeMenu);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-red-50 hover:text-red-700 text-gray-700 rounded-lg transition-colors text-sm font-medium"
            >
              <Trash2 size={15} className="text-red-600" /> Delete Driver
            </button>
          </div>
        </>,
        document.body,
      )}

      {/* Wallet Modal */}
      {walletModal && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl border border-gray-100 overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Edit Wallet</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {walletModal.driver.name} · current balance{' '}
                  <span className={`font-bold ${walletModal.driver.walletBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>{formatMoney(walletModal.driver.walletBalance)}</span>
                </p>
              </div>
              <button
                onClick={() => setWalletModal(null)}
                className="text-gray-400 hover:text-gray-900 transition-colors"
              >
                <XCircle size={20} />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1 text-xs font-bold">
              {[['credit', 'Add'], ['debit', 'Deduct'], ['set', 'Set balance']].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setWalletModal(prev => ({ ...prev, mode: key }))}
                  className={`rounded-md py-1.5 transition-colors ${walletModal.mode === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">{walletModal.mode === 'set' ? 'New balance (₹)' : 'Amount (₹)'}</label>
              <input
                type="number"
                step="0.01"
                min={walletModal.mode === 'set' ? undefined : '0'}
                autoFocus
                placeholder={walletModal.mode === 'set' ? 'e.g. 0' : 'e.g. 500'}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:border-yellow-400 transition-colors"
                value={walletModal.amount}
                onChange={(e) => setWalletModal(prev => ({ ...prev, amount: e.target.value }))}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Note (optional)</label>
              <input
                type="text"
                maxLength={200}
                placeholder="Reason for the change"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:border-yellow-400 transition-colors"
                value={walletModal.description}
                onChange={(e) => setWalletModal(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>

            {walletChange && (
              <p className="text-xs text-gray-500">
                {walletChange.operation === 'credit' ? 'Adds' : 'Deducts'} <span className="font-bold text-gray-900">{formatMoney(walletChange.amount)}</span> · new balance{' '}
                <span className="font-bold text-gray-900">
                  {formatMoney(walletModal.driver.walletBalance + (walletChange.operation === 'credit' ? walletChange.amount : -walletChange.amount))}
                </span>
              </p>
            )}

            <button
              onClick={submitWallet}
              disabled={walletModal.isSubmitting || !walletChange}
              className="w-full py-2 bg-yellow-400 text-black rounded-lg text-sm font-bold shadow-sm hover:bg-yellow-500 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {walletModal.isSubmitting ? <Loader2 className="animate-spin" size={15} /> : <Wallet size={15} />}
              Update Wallet
            </button>
          </div>
        </div>
      )}

      {/* Password Modal */}
      <AnimatePresence>
        {passwordModal.isOpen && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl border border-gray-100 overflow-hidden p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Update Password</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Set a new password for this driver</p>
                </div>
                <button 
                  onClick={() => setPasswordModal({ isOpen: false, driverId: null, password: '', isSubmitting: false })}
                  className="text-gray-400 hover:text-gray-900 transition-colors"
                >
                  <XCircle size={20} />
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">New Password</label>
                <div className="relative">
                  <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input 
                    type="text" 
                    placeholder="Enter new password"
                    autoFocus
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:border-yellow-400 transition-colors"
                    value={passwordModal.password}
                    onChange={(e) => setPasswordModal(prev => ({ ...prev, password: e.target.value }))}
                  />
                </div>
                <p className="text-[10px] text-gray-400 mt-1.5">Minimum 8 characters required.</p>
              </div>

              <button 
                onClick={() => {
                  if (passwordModal.password.length < 4) { alert('Password too short'); return; }
                  handleAction('password', passwordModal.driverId);
                }}
                disabled={passwordModal.isSubmitting || !passwordModal.password}
                className="w-full py-2 bg-yellow-400 text-black rounded-lg text-sm font-bold shadow-sm hover:bg-yellow-500 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {passwordModal.isSubmitting ? <Loader2 className="animate-spin" size={15} /> : <Key size={15} />}
                Update Password
              </button>
            </div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DriverList;
