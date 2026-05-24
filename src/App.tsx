import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AppWindow,
  Box,
  Copy,
  Database,
  HardDrive,
  EyeOff,
  FolderOpen,
  Globe,
  Info,
  Monitor,
  Moon,
  Power,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Star,
  Sun,
  Terminal,
} from "lucide-react";
import "./App.css";

type PortService = {
  port: number;
  protocol: string;
  pid: number;
  processName: string;
  displayName: string;
  source?: "docker" | "application" | null;
  command?: string | null;
  cwd?: string | null;
  folderGroup?: string | null;
  address?: string | null;
  ownerMatchesCurrentUser: boolean;
  canKill: boolean;
};

type CapabilityStatus =
  | "pending"
  | "scanning"
  | "web"
  | "api_docs"
  | "grpc"
  | "api_no_docs"
  | "unknown"
  | "error";

type CapabilityScan = {
  port: number;
  status: Exclude<CapabilityStatus, "pending" | "scanning">;
  baseUrl?: string | null;
  docsUrl?: string | null;
  detail?: string | null;
};

type CapabilityState = {
  status: CapabilityStatus;
  baseUrl?: string | null;
  docsUrl?: string | null;
  detail?: string | null;
};

type Group = {
  key: string;
  label: string;
  services: PortService[];
};

type ExcludedService = {
  key: string;
  port: number;
  protocol: string;
  pid: number;
  processName: string;
  displayName?: string;
  source?: "docker" | "application" | null;
  cwd?: string | null;
  folderGroup?: string | null;
  address?: string | null;
  excludedAt: string;
};

type ServiceTagInput = Pick<
  PortService | ExcludedService,
  "displayName" | "processName" | "source" | "cwd" | "folderGroup" | "address"
>;

type ThemeMode = "system" | "light" | "dark";

const FAVORITES_KEY = "porthole:favorites";
const EXCLUDED_KEY = "porthole:excluded";
const THEME_KEY = "porthole:theme";

function App() {
  const [services, setServices] = useState<PortService[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, CapabilityState>>({});
  const [favorites, setFavorites] = useState<Set<string>>(() => readFavorites());
  const [excluded, setExcluded] = useState<Record<string, ExcludedService>>(() => readExcluded());
  const [view, setView] = useState<"active" | "excluded">("active");
  const [scanState, setScanState] = useState<"idle" | "scanning" | "error">("idle");
  const [filterFavorites, setFilterFavorites] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme());
  const [error, setError] = useState<string | null>(null);
  const firstScanStarted = useRef(false);

  useEffect(() => {
    if (firstScanStarted.current) return;
    firstScanStarted.current = true;
    void refreshPorts();
  }, []);

  useEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
  }, [favorites]);

  useEffect(() => {
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify(excluded));
  }, [excluded]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme === "system") applyTheme(theme);
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  const activeServices = useMemo(
    () => services.filter((service) => !excluded[stableServiceKey(service)]),
    [excluded, services],
  );

  const visibleServices = useMemo(() => {
    const favoriteFiltered = filterFavorites
      ? activeServices.filter((service) => favorites.has(stableServiceKey(service)))
      : activeServices;
    return filterServices(favoriteFiltered, searchQuery);
  }, [activeServices, filterFavorites, favorites, searchQuery]);

  const groups = useMemo(() => groupServices(visibleServices), [visibleServices]);
  const favoriteCount = useMemo(
    () => activeServices.filter((service) => favorites.has(stableServiceKey(service))).length,
    [activeServices, favorites],
  );
  const excludedItems = useMemo(
    () => filterExcluded(Object.values(excluded), searchQuery).sort((left, right) => left.port - right.port),
    [excluded, searchQuery],
  );
  const totalExcludedCount = useMemo(() => Object.keys(excluded).length, [excluded]);
  const showActiveSkeleton = view === "active" && scanState === "scanning";

  async function refreshPorts() {
    setScanState("scanning");
    setError(null);
    setCapabilities({});
    try {
      const nextServices = await invoke<PortService[]>("scan_ports");
      setServices(nextServices);
      setScanState("idle");
      nextServices.filter((service) => !excluded[stableServiceKey(service)]).forEach((service) => {
        void scanCapability(service);
      });
    } catch (err) {
      setScanState("error");
      setError(String(err));
    }
  }

  async function scanCapability(service: PortService) {
    const key = serviceKey(service);
    setCapabilities((current) => ({
      ...current,
      [key]: { status: "scanning" },
    }));

    try {
      const result = await invoke<CapabilityScan>("scan_capabilities", {
        address: service.address,
        port: service.port,
      });
      setCapabilities((current) => ({
        ...current,
        [key]: {
          status: result.status,
          baseUrl: result.baseUrl,
          docsUrl: result.docsUrl,
          detail: result.detail,
        },
      }));
    } catch (err) {
      setCapabilities((current) => ({
        ...current,
        [key]: { status: "error", detail: String(err) },
      }));
    }
  }

  function toggleFavorite(service: PortService) {
    const key = stableServiceKey(service);
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function excludeService(service: PortService) {
    const key = stableServiceKey(service);
    setExcluded((current) => ({
      ...current,
      [key]: {
        key,
        port: service.port,
        protocol: service.protocol,
        pid: service.pid,
        processName: service.processName,
        displayName: service.displayName,
        source: service.source,
        cwd: service.cwd,
        folderGroup: service.folderGroup,
        address: service.address,
        excludedAt: new Date().toISOString(),
      },
    }));
    setFavorites((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function restoreExcluded(key: string) {
    setExcluded((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function openUrl(url: string) {
    await invoke("open_url", { url });
  }

  async function openFolder(path?: string | null) {
    if (!path) return;
    await invoke("open_folder", { path });
  }

  async function openTerminal(path?: string | null) {
    if (!path) return;
    await invoke("open_terminal", { path });
  }

  async function killProcess(service: PortService) {
    await invoke("kill_process", { pid: service.pid });
    await refreshPorts();
  }

  async function copyPid(pid: number) {
    await navigator.clipboard.writeText(String(pid));
  }

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100 sm:p-6">
      <header className="mx-auto mb-5 flex max-w-[1320px] flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-normal">Porthole</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {services.length} listening services on this machine
          </p>
        </div>
        <div className="flex flex-wrap gap-2 xl:justify-end" aria-label="Scanner controls">
          <button
            className={buttonClass(view === "active")}
            type="button"
            title="Show active ports"
            onClick={() => setView("active")}
          >
            <ScanSearch className="size-4" />
            <span>Active {activeServices.length}</span>
          </button>
          <button
            className={buttonClass(view === "excluded")}
            type="button"
            title="Show excluded ports"
            onClick={() => setView("excluded")}
          >
            <EyeOff className="size-4" />
            <span>Excluded {excludedItems.length}</span>
          </button>
          <button
            className={buttonClass(filterFavorites)}
            type="button"
            title="Show favorites"
            disabled={view === "excluded"}
            onClick={() => setFilterFavorites((value) => !value)}
          >
            <StarIcon active={filterFavorites} />
            <span>Favorites {favoriteCount}</span>
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-emerald-700 bg-emerald-700 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            title="Refresh ports"
            disabled={scanState === "scanning"}
            onClick={() => void refreshPorts()}
          >
            <RefreshCw className={scanState === "scanning" ? "size-4 animate-spin" : "size-4"} />
            {scanState === "scanning" ? "Scanning..." : "Refresh"}
          </button>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </div>
      </header>

      <section className="mx-auto mb-4 max-w-[1320px]" aria-label="Search services">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
          <input
            className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/15 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
            placeholder="Search by port, service, directory, group, address..."
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
          />
        </div>
      </section>

      {error ? (
        <div className="mx-auto mb-4 max-w-[1320px] rounded-lg border border-red-300 bg-white p-4 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      ) : null}

      {showActiveSkeleton && services.length === 0 ? (
        <SummarySkeleton />
      ) : (
        <section
          className="mx-auto mb-5 grid max-w-[1320px] grid-cols-2 gap-3 xl:grid-cols-4"
          aria-label="Scan summary"
        >
          <Metric label="Ports" value={services.length} />
          <Metric label="Active" value={activeServices.length} />
          <Metric label="Favorites" value={favoriteCount} />
          <Metric label="Excluded" value={totalExcludedCount} />
        </section>
      )}

      {view === "excluded" ? (
        <ExcludedPorts
          excludedItems={excludedItems}
          searchQuery={searchQuery}
          services={services}
          onRestore={restoreExcluded}
        />
      ) : (
        <section className="mx-auto grid max-w-[1320px] gap-4" aria-label="Detected services">
          {showActiveSkeleton ? (
            <PortSkeleton />
          ) : groups.length === 0 ? (
            <div className="rounded-lg border border-slate-300 bg-white p-5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {searchQuery
                ? "No active services match your search."
                : filterFavorites
                ? "No favorite services are currently listening."
                : "No local listening ports were found."}
            </div>
          ) : (
            groups.map((group) => (
            <section className="rounded-lg border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900" key={group.key}>
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 dark:border-slate-800 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-base font-semibold">{group.label}</h2>
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {group.services.length} service{group.services.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <IconButton
                    icon={<FolderOpen className="size-4" />}
                    label="Open folder"
                    disabled={!isRealPath(group.key)}
                    onClick={() => void openFolder(group.key)}
                  />
                  <IconButton
                    icon={<Terminal className="size-4" />}
                    label="Open terminal"
                    disabled={!isRealPath(group.key)}
                    onClick={() => void openTerminal(group.key)}
                  />
                </div>
              </div>

              <div className="grid">
                <div className="hidden grid-cols-[minmax(210px,1.1fr)_minmax(160px,0.8fr)_minmax(210px,1.2fr)_minmax(220px,0.8fr)] gap-4 bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-normal text-slate-500 dark:bg-slate-950/70 dark:text-slate-400 xl:grid">
                  <span>Service</span>
                  <span>Capability</span>
                  <span>Location</span>
                  <span>Actions</span>
                </div>
                {group.services.map((service) => {
                  const key = serviceKey(service);
                  const capability = capabilities[key] ?? { status: "pending" };
                  const favorite = favorites.has(stableServiceKey(service));
                  const launchUrl = capability.docsUrl || capability.baseUrl;
                  const canOpenBrowser =
                    launchUrl &&
                    (capability.status === "web" || capability.status === "api_docs");

                  return (
                    <ServiceRow
                      canOpenBrowser={Boolean(canOpenBrowser)}
                      capability={capability}
                      favorite={favorite}
                      key={key}
                      launchUrl={launchUrl || null}
                      onCopyPid={copyPid}
                      onExclude={excludeService}
                      onKill={killProcess}
                      onOpenFolder={openFolder}
                      onOpenTerminal={openTerminal}
                      onOpenUrl={openUrl}
                      onToggleFavorite={toggleFavorite}
                      service={service}
                    />
                  );
                })}
              </div>
            </section>
            ))
          )}
        </section>
      )}
    </main>
  );
}

function ExcludedPorts({
  excludedItems,
  onRestore,
  searchQuery,
  services,
}: {
  excludedItems: ExcludedService[];
  onRestore: (key: string) => void;
  searchQuery: string;
  services: PortService[];
}) {
  const liveKeys = useMemo(
    () => new Set(services.map((service) => stableServiceKey(service))),
    [services],
  );

  return (
    <section className="mx-auto grid max-w-[1320px] gap-4" aria-label="Excluded services">
      {excludedItems.length === 0 ? (
        <div className="rounded-lg border border-slate-300 bg-white p-5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          {searchQuery ? "No excluded ports match your search." : "No excluded ports."}
        </div>
      ) : (
        <section className="rounded-lg border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="hidden grid-cols-[minmax(210px,1fr)_minmax(240px,1.4fr)_minmax(120px,0.4fr)] gap-4 bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-normal text-slate-500 dark:bg-slate-950/70 dark:text-slate-400 xl:grid">
            <span>Service</span>
            <span>Location</span>
            <span>Actions</span>
          </div>
          {excludedItems.map((item) => {
            const live = liveKeys.has(item.key);

            return (
              <article
                className="grid gap-4 border-t border-slate-200 p-4 dark:border-slate-800 md:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(210px,1fr)_minmax(240px,1.4fr)_minmax(120px,0.4fr)] xl:items-center"
                key={item.key}
              >
                <div className="min-w-0 rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 xl:bg-transparent xl:p-0 xl:dark:bg-transparent">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-base">
                      {item.protocol.toUpperCase()} {item.port}
                    </strong>
                    <span className={live ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300"}>
                      {live ? "Listening" : "Not found"}
                    </span>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm text-slate-600 dark:text-slate-300">
                      {item.displayName || item.processName}
                    </p>
                    <ServiceTag item={item} />
                  </div>
                </div>
                <div className="min-w-0 rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 md:col-span-2 xl:col-span-1 xl:bg-transparent xl:p-0 xl:dark:bg-transparent">
                  <span className="text-xs text-slate-500 dark:text-slate-400">{item.address || "local listener"}</span>
                  <LocationLabel
                    path={item.folderGroup || item.cwd}
                    fallback="Folder unavailable"
                  />
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end xl:justify-end">
                  <IconButton
                    icon={<RotateCcw className="size-4" />}
                    label="Restore port"
                    onClick={() => onRestore(item.key)}
                  />
                </div>
              </article>
            );
          })}
        </section>
      )}
    </section>
  );
}

function ServiceRow({
  canOpenBrowser,
  capability,
  favorite,
  launchUrl,
  onCopyPid,
  onExclude,
  onKill,
  onOpenFolder,
  onOpenTerminal,
  onOpenUrl,
  onToggleFavorite,
  service,
}: {
  canOpenBrowser: boolean;
  capability: CapabilityState;
  favorite: boolean;
  launchUrl: string | null;
  onCopyPid: (pid: number) => Promise<void>;
  onExclude: (service: PortService) => void;
  onKill: (service: PortService) => Promise<void>;
  onOpenFolder: (path?: string | null) => Promise<void>;
  onOpenTerminal: (path?: string | null) => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  onToggleFavorite: (service: PortService) => void;
  service: PortService;
}) {
  return (
    <article className="grid gap-3 border-t border-slate-200 p-3 dark:border-slate-800 sm:p-4 xl:min-h-22 xl:grid-cols-[minmax(210px,1.1fr)_minmax(160px,0.8fr)_minmax(210px,1.2fr)_minmax(220px,0.8fr)] xl:items-center xl:gap-4">
      <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 xl:bg-transparent xl:p-0 xl:dark:bg-transparent">
        <button
          className={favoriteButtonClass(favorite)}
          type="button"
          title={favorite ? "Unpin favorite" : "Pin favorite"}
          onClick={() => onToggleFavorite(service)}
        >
          <StarIcon active={favorite} />
          <span className="sr-only">{favorite ? "Unpin favorite" : "Pin favorite"}</span>
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-base">
              {service.protocol.toUpperCase()} {service.port}
            </strong>
            <span className="text-xs text-slate-500 dark:text-slate-400">PID {service.pid}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="truncate text-sm text-slate-600 dark:text-slate-300">{service.displayName}</p>
            <ServiceTag item={service} />
          </div>
        </div>
      </div>

      <InfoBlock label="Capability">
        <span className={badgeClass(capability.status)}>
          {capability.status === "scanning" ? <ScanSearch className="size-3.5" /> : null}
          {capabilityLabel(capability.status)}
        </span>
        <TooltipText
          className="mt-1 text-sm text-slate-600 dark:text-slate-300"
          text={capability.detail || "Waiting for capability scan"}
        />
      </InfoBlock>

      <InfoBlock label="Location">
        <span className="text-xs text-slate-500 dark:text-slate-400">{service.address || "local listener"}</span>
        <LocationLabel path={service.cwd || service.command} fallback="Folder unavailable" />
      </InfoBlock>

      <div className="flex flex-wrap justify-end gap-2 rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 sm:justify-start xl:justify-end xl:bg-transparent xl:p-0 xl:dark:bg-transparent">
        <IconButton
          icon={<Globe className="size-4" />}
          label="Open in browser"
          disabled={!canOpenBrowser}
          onClick={() => launchUrl && void onOpenUrl(launchUrl)}
        />
        <IconButton
          icon={<FolderOpen className="size-4" />}
          label="Open folder"
          disabled={!service.cwd}
          onClick={() => void onOpenFolder(service.cwd)}
        />
        <IconButton
          icon={<Terminal className="size-4" />}
          label="Open terminal"
          disabled={!service.cwd}
          onClick={() => void onOpenTerminal(service.cwd)}
        />
        <IconButton
          icon={<EyeOff className="size-4" />}
          label="Exclude port"
          onClick={() => onExclude(service)}
        />
        {service.canKill ? (
          <IconButton
            danger
            icon={<Power className="size-4" />}
            label="Kill process"
            onClick={() => void onKill(service)}
          />
        ) : (
          <IconButton
            icon={<Copy className="size-4" />}
            label="Copy PID"
            onClick={() => void onCopyPid(service.pid)}
          />
        )}
      </div>
    </article>
  );
}

function InfoBlock({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 xl:bg-transparent xl:p-0 xl:dark:bg-transparent">
      <div className="mb-1 text-xs font-bold uppercase tracking-normal text-slate-400 dark:text-slate-500 xl:hidden">
        {label}
      </div>
      {children}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <section className="mx-auto mb-5 grid max-w-[1320px] grid-cols-2 gap-3 xl:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div className="rounded-lg border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" key={index}>
          <div className="h-3 w-20 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className="mt-3 h-7 w-12 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
        </div>
      ))}
    </section>
  );
}

function PortSkeleton() {
  return (
    <section className="rounded-lg border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900" aria-label="Scanning ports">
      <div className="flex items-center gap-2 border-b border-slate-200 p-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
        <RefreshCw className="size-4 animate-spin" />
        Scanning local listeners
      </div>
      <div className="grid">
        {Array.from({ length: 5 }).map((_, index) => (
          <article
            className="grid gap-3 border-t border-slate-200 p-3 dark:border-slate-800 sm:p-4 xl:grid-cols-[minmax(210px,1.1fr)_minmax(160px,0.8fr)_minmax(210px,1.2fr)_minmax(220px,0.8fr)] xl:gap-4"
            key={index}
          >
            <SkeletonBlock lines={3} />
            <SkeletonBlock lines={2} />
            <SkeletonBlock lines={2} />
            <div className="flex gap-2 rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 xl:justify-end xl:bg-transparent xl:p-0 xl:dark:bg-transparent">
              {Array.from({ length: 4 }).map((_, buttonIndex) => (
                <div className="size-9 animate-pulse rounded-md bg-slate-200 dark:bg-slate-800" key={buttonIndex} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SkeletonBlock({ lines }: { lines: number }) {
  return (
    <div className="rounded-md bg-slate-50 p-3 dark:bg-slate-950/60 xl:bg-transparent xl:p-0 xl:dark:bg-transparent" aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <div
          className={[
            "mb-2 h-3 animate-pulse rounded bg-slate-200 last:mb-0 dark:bg-slate-800",
            index === 0 ? "w-24" : index === 1 ? "w-36" : "w-20",
          ].join(" ")}
          key={index}
        />
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <span className="block text-xs font-medium uppercase tracking-normal text-slate-500 dark:text-slate-400">{label}</span>
      <strong className="mt-1 block text-2xl font-bold">{value}</strong>
    </div>
  );
}

function ThemeToggle({
  onChange,
  theme,
}: {
  onChange: (theme: ThemeMode) => void;
  theme: ThemeMode;
}) {
  const options: Array<{ icon: ReactNode; label: string; value: ThemeMode }> = [
    { icon: <Monitor className="size-4" />, label: "System", value: "system" },
    { icon: <Sun className="size-4" />, label: "Light", value: "light" },
    { icon: <Moon className="size-4" />, label: "Dark", value: "dark" },
  ];

  return (
    <div className="inline-flex h-9 rounded-md border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900" aria-label="Theme">
      {options.map((option) => (
        <button
          className={[
            "inline-flex size-8 items-center justify-center rounded text-sm font-medium transition",
            theme === option.value
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-950"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
          ].join(" ")}
          key={option.value}
          aria-label={`${option.label} theme`}
          type="button"
          title={`${option.label} theme`}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

function ServiceTag({ item }: { item: ServiceTagInput }) {
  const tag = serviceTagFor(item);
  if (!tag) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${tag.className}`}>
      {tag.icon}
      {tag.label}
    </span>
  );
}

function serviceTagFor(item: ServiceTagInput) {
  const haystack = searchableText([
    item.displayName,
    item.processName,
    item.source,
    item.cwd,
    item.folderGroup,
    item.address,
  ]);

  const serviceIcons: Array<{
    className: string;
    icon: ReactNode;
    label: string;
    match: RegExp;
  }> = [
    {
      className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
      icon: <Database className="size-3" />,
      label: "PostgreSQL",
      match: /\b(postgres|postgresql|pgadmin)\b/,
    },
    {
      className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
      icon: <HardDrive className="size-3" />,
      label: "Redis",
      match: /\b(redis|valkey)\b/,
    },
  ];

  const known = serviceIcons.find((entry) => entry.match.test(haystack));
  if (known) return known;

  if (item.source === "docker") {
    return {
      className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
      icon: <Box className="size-3" />,
      label: "Docker",
    };
  }

  if (item.source === "application") {
    return {
      className: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
      icon: <AppWindow className="size-3" />,
      label: "App",
    };
  }

  return null;
}

function LocationLabel({
  fallback,
  path,
}: {
  fallback: string;
  path?: string | null;
}) {
  if (!path) {
    return <p className="mt-1 truncate text-sm text-slate-600 dark:text-slate-300">{fallback}</p>;
  }

  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
      <span className="truncate">{finalPathSegment(path)}</span>
      <span className="group relative inline-flex shrink-0">
        <Info className="size-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        <span className="pointer-events-none absolute left-1/2 top-5 z-50 hidden w-max max-w-96 -translate-x-1/2 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-normal text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 group-hover:block">
          {path}
        </span>
        <span className="sr-only">Full path: {path}</span>
      </span>
    </p>
  );
}

function TooltipText({ className = "", text }: { className?: string; text: string }) {
  return (
    <span className={`group relative flex min-w-0 ${className}`}>
      <span className="truncate">{text}</span>
      <span className="pointer-events-none absolute left-0 top-6 z-50 hidden max-w-96 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-normal text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 group-hover:block">
        {text}
      </span>
    </span>
  );
}

function IconButton({
  danger = false,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={[
        "inline-flex size-9 items-center justify-center rounded-md border bg-white text-sm transition dark:bg-slate-900",
        "disabled:cursor-not-allowed disabled:opacity-45",
        danger
          ? "border-red-300 text-red-700 hover:border-red-500 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:border-red-700 dark:hover:bg-red-950/50"
          : "border-slate-300 text-slate-700 hover:border-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-800",
      ].join(" ")}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function StarIcon({ active }: { active: boolean }) {
  return (
    <Star
      className={active ? "size-4 fill-amber-400 text-amber-500" : "size-4 text-slate-500 dark:text-slate-400"}
    />
  );
}

function readFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set<string>();
    const values = JSON.parse(raw);
    return Array.isArray(values) ? new Set<string>(values) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function readExcluded() {
  try {
    const raw = localStorage.getItem(EXCLUDED_KEY);
    if (!raw) return {};
    const values = JSON.parse(raw);
    return values && typeof values === "object" && !Array.isArray(values)
      ? (values as Record<string, ExcludedService>)
      : {};
  } catch {
    return {};
  }
}

function readTheme(): ThemeMode {
  const theme = localStorage.getItem(THEME_KEY);
  return theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
}

function applyTheme(theme: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const useDark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", useDark);
  document.documentElement.style.colorScheme = useDark ? "dark" : "light";
}

function filterServices(services: PortService[], query: string) {
  const normalized = normalizeSearch(query);
  if (!normalized) return services;
  return services.filter((service) => serviceSearchText(service).includes(normalized));
}

function filterExcluded(items: ExcludedService[], query: string) {
  const normalized = normalizeSearch(query);
  if (!normalized) return items;
  return items.filter((item) => excludedSearchText(item).includes(normalized));
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function serviceSearchText(service: PortService) {
  return searchableText([
    service.port,
    service.pid,
    service.protocol,
    service.processName,
    service.displayName,
    service.source,
    service.command,
    service.cwd,
    service.folderGroup,
    service.address,
    formatGroupLabel(service.folderGroup || ""),
  ]);
}

function excludedSearchText(item: ExcludedService) {
  return searchableText([
    item.port,
    item.pid,
    item.protocol,
    item.processName,
    item.displayName,
    item.source,
    item.cwd,
    item.folderGroup,
    item.address,
    item.excludedAt,
    formatGroupLabel(item.folderGroup || ""),
  ]);
}

function searchableText(values: Array<number | string | null | undefined>) {
  return values
    .filter((value): value is number | string => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function serviceKey(service: PortService) {
  return `${service.pid}:${service.port}:${service.address || "local"}`;
}

function stableServiceKey(service: PortService) {
  if (service.source === "docker") {
    return `docker:${service.port}:${service.displayName || service.processName}`;
  }

  if (service.source === "application") {
    return `application:${service.port}:${service.displayName || service.processName}`;
  }

  return `${service.folderGroup || service.cwd || service.source || "unknown"}:${service.port}:${service.displayName || service.processName}`;
}

function groupServices(services: PortService[]): Group[] {
  const grouped = new Map<string, PortService[]>();
  services.forEach((service) => {
    const key = service.folderGroup || service.cwd || `Process ${service.pid}`;
    grouped.set(key, [...(grouped.get(key) || []), service]);
  });

  return [...grouped.entries()]
    .map(([key, groupServices]) => ({
      key,
      label: formatGroupLabel(key),
      services: groupServices.sort((left, right) => left.port - right.port),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function formatGroupLabel(path: string) {
  if (path.startsWith("Docker/")) return path.replace("Docker/", "");
  if (!isRealPath(path)) return path;
  return finalPathSegment(path);
}

function finalPathSegment(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 1] || path).replace(/\.app$/i, "");
}

function isRealPath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function capabilityLabel(status: CapabilityStatus) {
  const labels: Record<CapabilityStatus, string> = {
    pending: "Pending",
    scanning: "Scanning",
    web: "Web app",
    api_docs: "API docs",
    grpc: "gRPC",
    api_no_docs: "API",
    unknown: "Unknown",
    error: "Error",
  };
  return labels[status];
}

function buttonClass(active: boolean) {
  return [
    "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45",
    active
      ? "border-amber-400 bg-amber-50 text-slate-900 dark:border-amber-600 dark:bg-amber-950/50 dark:text-amber-100"
      : "border-slate-300 bg-white text-slate-800 hover:border-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-800",
  ].join(" ");
}

function favoriteButtonClass(active: boolean) {
  return [
    "inline-flex size-9 items-center justify-center rounded-full border",
    active
      ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/50"
      : "border-slate-300 bg-white hover:border-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500 dark:hover:bg-slate-800",
  ].join(" ");
}

function badgeClass(status: CapabilityStatus) {
  const base =
    "inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-bold leading-none";
  const variants: Record<CapabilityStatus, string> = {
    pending: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    scanning: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    web: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    api_docs: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    grpc: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
    api_no_docs: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    unknown: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
    error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  };

  return `${base} ${variants[status]}`;
}

export default App;
