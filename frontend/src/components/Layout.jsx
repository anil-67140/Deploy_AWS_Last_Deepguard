import { useEffect, useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import AppErrorBoundary from "./AppErrorBoundary";
import { useSelector, useDispatch } from "react-redux";
import { supabase } from "../utils/api";
import { clearUser } from "../store";
import toast from "react-hot-toast";
import {
  LayoutDashboard,
  Upload,
  FileText,
  Gauge,
  Settings,
  LogOut,
  Shield,
  ChevronLeft,
  ChevronRight,
  Menu,
} from "lucide-react";

const NAV_ITEMS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/upload", icon: Upload, label: "Upload File" },
  { to: "/reports", icon: FileText, label: "Reports" },
  { to: "/performance", icon: Gauge, label: "Performance" }, // FR-12
];

const ADMIN_ITEMS = [{ to: "/admin", icon: Settings, label: "Admin Panel" }];

const STORAGE_KEY = "dg.sidebar.collapsed";
const readCollapsed = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // storage blocked (private mode) — just start expanded
  }
};

/** One sidebar link. When the sidebar is collapsed (desktop) only the icon is shown, with a hover label. */
function NavItem({ to, icon: Icon, label, collapsed }) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) =>
        `sidebar-link group relative ${isActive ? "active" : ""} ${collapsed ? "md:justify-center md:px-0" : ""}`
      }
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className={collapsed ? "md:hidden" : ""}>{label}</span>
      {collapsed && (
        <span className="pointer-events-none absolute left-full ml-3 hidden md:group-hover:block whitespace-nowrap rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-xs font-medium text-slate-100 shadow-xl z-50">
          {label}
        </span>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { user, role } = useSelector((s) => s.auth);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // desktop: collapse to an icon rail (remembered between visits)   mobile: slide-in drawer
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
    // Let charts / canvases re-measure once the width animation has finished.
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 260);
    return () => clearTimeout(t);
  }, [collapsed]);

  // the drawer closes whenever you navigate
  useEffect(() => setMobileOpen(false), [pathname]);

  // keyboard: Esc closes the drawer, "[" toggles the sidebar (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setMobileOpen(false);
      const el = e.target;
      const typing =
        el &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === "[" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    dispatch(clearUser());
    navigate("/login");
    toast.success("Logged out");
  };

  const hideWhenCollapsed = collapsed ? "md:hidden" : "";
  const sectionLabel =
    "text-xs text-slate-600 font-semibold uppercase tracking-wider px-3 mb-2";

  return (
    <div className="flex h-screen bg-slate-900 overflow-hidden">
      {/* mobile: dim the page behind the open drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        id="app-sidebar"
        className={[
          "z-40 flex flex-col flex-shrink-0 bg-slate-900 border-r border-slate-800",
          // mobile: off-canvas drawer
          "fixed inset-y-0 left-0 w-64 transition-transform duration-200 ease-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // desktop: in the layout, width animates between full and icon-rail
          "md:relative md:translate-x-0 md:transition-[width] md:duration-200",
          collapsed ? "md:w-[4.5rem]" : "md:w-60",
        ].join(" ")}
      >
        {/* collapse / expand handle (desktop) */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title={
            collapsed ? "Expand sidebar  ( [ )" : "Collapse sidebar  ( [ )"
          }
          className="hidden md:flex absolute -right-3 top-6 z-50 w-6 h-6 items-center justify-center rounded-full bg-slate-800 border border-slate-600 text-slate-300 hover:text-white hover:bg-sky-600 hover:border-sky-500 shadow-md transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronLeft className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Logo */}
        <div
          className={`p-5 border-b border-slate-800 ${collapsed ? "md:px-0" : ""}`}
        >
          <div
            className={`flex items-center gap-3 ${collapsed ? "md:justify-center" : ""}`}
          >
            <div className="w-9 h-9 flex-shrink-0 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center">
              <Shield className="w-5 h-5 text-sky-400" />
            </div>
            <div className={hideWhenCollapsed}>
              <h1 className="font-bold text-white text-sm leading-none">
                DeepGuard
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Financial Forensics
              </p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav
          className={`flex-1 p-3 space-y-1 overflow-y-auto ${collapsed ? "md:overflow-visible" : ""}`}
        >
          <p className={`${sectionLabel} ${hideWhenCollapsed}`}>Navigation</p>
          {NAV_ITEMS.filter(
            (item) =>
              item.to !== "/upload" || ["admin", "auditor"].includes(role),
          ).map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} />
          ))}

          {role === "admin" && (
            <>
              <p className={`${sectionLabel} mt-5 ${hideWhenCollapsed}`}>
                Admin
              </p>
              {collapsed && (
                <div className="hidden md:block h-px bg-slate-800 my-3 mx-2" />
              )}
              {ADMIN_ITEMS.map((item) => (
                <NavItem key={item.to} {...item} collapsed={collapsed} />
              ))}
            </>
          )}
        </nav>

        {/* User */}
        <div className="p-3 border-t border-slate-800">
          <div
            className={`flex items-center gap-3 px-3 py-2 mb-1 ${collapsed ? "md:justify-center md:px-0" : ""}`}
            title={collapsed ? user?.email : undefined}
          >
            <div className="w-8 h-8 flex-shrink-0 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-xs font-bold text-sky-400 uppercase">
              {user?.email?.[0] || "U"}
            </div>
            <div className={`flex-1 min-w-0 ${hideWhenCollapsed}`}>
              <p className="text-xs font-semibold text-slate-200 truncate">
                {user?.email}
              </p>
              <p className="text-xs text-slate-500 capitalize">{role}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            title={collapsed ? "Sign Out" : undefined}
            aria-label="Sign Out"
            className={`sidebar-link w-full hover:text-red-400 hover:bg-red-500/10 ${collapsed ? "md:justify-center md:px-0" : ""}`}
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            <span className={hideWhenCollapsed}>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* mobile top bar with the menu button */}
        <header className="md:hidden flex items-center gap-3 px-4 h-14 flex-shrink-0 border-b border-slate-800 bg-slate-900">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            aria-expanded={mobileOpen}
            aria-controls="app-sidebar"
            className="p-2 -ml-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="w-7 h-7 rounded-md bg-sky-500/20 border border-sky-500/30 flex items-center justify-center">
            <Shield className="w-4 h-4 text-sky-400" />
          </div>
          <span className="font-bold text-white text-sm">DeepGuard</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <AppErrorBoundary>
            <Outlet />
          </AppErrorBoundary>
        </main>
      </div>
    </div>
  );
}
