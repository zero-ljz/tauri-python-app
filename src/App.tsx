import { useEffect, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menubar from "@radix-ui/react-menubar";
import * as Switch from "@radix-ui/react-switch";
import * as Tooltip from "@radix-ui/react-tooltip";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { observer } from "mobx-react-lite";
import {
  Activity,
  Bug,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  Gauge,
  LayoutDashboard,
  Loader2,
  Maximize2,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Settings,
  Square,
  Sun,
  TerminalSquare,
  Timer,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import "./App.css";
import { IpcMonitor } from "./components/IpcMonitor";
import { ipcMonitorStore } from "./stores/ipcMonitorStore";
import { taskRuntimeStore } from "./stores/taskRuntimeStore";
import type { TaskDescriptor, TaskStatusResult } from "./generated/sidecarTypes";

type ThemeMode = "light" | "dark";
type SectionId = "overview" | "tasks" | "runs";
type BadgeVariant = "neutral" | "good" | "warn" | "bad" | "info";
type AppWindow = ReturnType<typeof getCurrentWindow>;
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const storageKeys = {
  sidebar: "tauri-python-app:sidebar-collapsed",
  theme: "tauri-python-app:theme",
};

const sectionItems: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "tasks", label: "任务目录", icon: Database },
  { id: "runs", label: "运行记录", icon: Gauge },
];

const resizeHandles: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "left-3 right-3 top-0 h-1 cursor-n-resize" },
  { direction: "South", className: "bottom-0 left-3 right-3 h-1 cursor-s-resize" },
  { direction: "West", className: "bottom-3 left-0 top-3 w-1 cursor-w-resize" },
  { direction: "East", className: "bottom-3 right-0 top-3 w-1 cursor-e-resize" },
  { direction: "NorthWest", className: "left-0 top-0 h-3 w-3 cursor-nw-resize" },
  { direction: "NorthEast", className: "right-0 top-0 h-3 w-3 cursor-ne-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 h-3 w-3 cursor-sw-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 h-3 w-3 cursor-se-resize" },
];

const App = observer(() => {
  const store = taskRuntimeStore;
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => initialTheme());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem(storageKeys.sidebar) === "true",
  );

  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(storageKeys.theme, theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.sidebar, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const scrollToSection = (section: SectionId) => {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <Tooltip.Provider delayDuration={220}>
      <div className="h-screen overflow-hidden bg-background text-foreground antialiased">
        <ResizeHandles />
        <TitleBar
          theme={theme}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />

        <div className="flex h-screen flex-col pt-9">
          <WebMenuBar
            activeSection={activeSection}
            theme={theme}
            sidebarCollapsed={sidebarCollapsed}
            onOpenPreferences={() => setPreferencesOpen(true)}
            onScrollToSection={scrollToSection}
            onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
          />

          <div className="flex min-h-0 flex-1">
            <Sidebar
              activeSection={activeSection}
              collapsed={sidebarCollapsed}
              connection={store.connection}
              onOpenIpc={() => ipcMonitorStore.setOpen(true)}
              onOpenPreferences={() => setPreferencesOpen(true)}
              onScrollToSection={scrollToSection}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
            />

            <main className="min-w-0 flex-1 overflow-auto scroll-smooth">
              <div className="mx-auto grid w-full max-w-[1440px] gap-5 px-5 py-5">
                {store.lastError ? <ErrorBand message={store.lastError} /> : null}
                <section id="overview" className="scroll-mt-5">
                  <OverviewSection />
                </section>
                <section id="tasks" className="scroll-mt-5">
                  <TasksSection />
                </section>
                <section id="runs" className="scroll-mt-5">
                  <RunsSection />
                </section>
              </div>
            </main>
          </div>
        </div>

        <PreferencesDialog
          open={preferencesOpen}
          sidebarCollapsed={sidebarCollapsed}
          theme={theme}
          onOpenChange={setPreferencesOpen}
          onSidebarCollapsedChange={setSidebarCollapsed}
          onThemeChange={setTheme}
        />
        <IpcMonitor />
      </div>
    </Tooltip.Provider>
  );
});

function initialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(storageKeys.theme);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getTauriWindow(): AppWindow | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function runWindowAction(action: (window: AppWindow) => Promise<void>) {
  const appWindow = getTauriWindow();
  if (!appWindow) {
    return;
  }
  void action(appWindow).catch((error) => console.error("Window action failed", error));
}

function ResizeHandles() {
  return (
    <>
      {resizeHandles.map((handle) => (
        <div
          key={handle.direction}
          className={`fixed z-[80] bg-transparent ${handle.className}`}
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            runWindowAction((window) => window.startResizeDragging(handle.direction));
          }}
        />
      ))}
    </>
  );
}

function TitleBar({
  theme,
  onToggleTheme,
}: {
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getTauriWindow();
    if (!appWindow) {
      return;
    }

    let cleanup: (() => void) | undefined;
    void appWindow.isMaximized().then(setIsMaximized).catch(() => undefined);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setIsMaximized).catch(() => undefined);
      })
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch(() => undefined);

    return () => cleanup?.();
  }, []);

  const handleDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.detail > 1 ||
      (event.target instanceof Element && event.target.closest("[data-no-drag]"))
    ) {
      return;
    }
    runWindowAction((window) => window.startDragging());
  };

  const toggleMaximize = () => {
    runWindowAction(async (window) => {
      await window.toggleMaximize();
      setIsMaximized(await window.isMaximized());
    });
  };

  return (
    <header
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[70] flex h-9 select-none items-center border-b border-border bg-titlebar/95 text-sm backdrop-blur"
      onDoubleClick={toggleMaximize}
      onMouseDown={handleDrag}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <div className="grid h-4 w-4 place-items-center rounded-[4px] bg-accent text-[10px] font-bold text-accent-foreground">
          Py
        </div>
        <span className="truncate font-medium text-titlebar-foreground">tauri-python-app</span>
      </div>

      <div data-no-drag className="flex h-full items-center">
        <TitleBarButton label={theme === "dark" ? "浅色模式" : "深色模式"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </TitleBarButton>
        <TitleBarButton label="最小化" onClick={() => runWindowAction((window) => window.minimize())}>
          <Minus size={15} />
        </TitleBarButton>
        <TitleBarButton label={isMaximized ? "还原" : "最大化"} onClick={toggleMaximize}>
          {isMaximized ? <Copy size={13} /> : <Maximize2 size={13} />}
        </TitleBarButton>
        <TitleBarButton
          label="关闭"
          className="hover:bg-danger hover:text-danger-foreground"
          onClick={() => runWindowAction((window) => window.close())}
        >
          <X size={15} />
        </TitleBarButton>
      </div>
    </header>
  );
}

function TitleBarButton({
  label,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={`grid h-9 w-11 place-items-center text-titlebar-muted transition-colors hover:bg-muted hover:text-titlebar-foreground ${className}`}
      type="button"
    />
  );
}

function WebMenuBar({
  activeSection,
  theme,
  sidebarCollapsed,
  onOpenPreferences,
  onScrollToSection,
  onToggleTheme,
  onToggleSidebar,
}: {
  activeSection: SectionId;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  onOpenPreferences: () => void;
  onScrollToSection: (section: SectionId) => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}) {
  const store = taskRuntimeStore;

  return (
    <Menubar.Root className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-menubar px-2">
      <Menubar.Menu>
        <Menubar.Trigger className={menuTriggerClass}>文件</Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className={menuContentClass} align="start">
            <MenuItem icon={RefreshCw} label="刷新" onSelect={() => void store.refresh()} />
            <MenuItem icon={Settings} label="首选项" onSelect={onOpenPreferences} />
            <MenuSeparator />
            <MenuItem icon={X} label="关闭窗口" onSelect={() => runWindowAction((window) => window.close())} />
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>

      <Menubar.Menu>
        <Menubar.Trigger className={menuTriggerClass}>视图</Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className={menuContentClass} align="start">
            {sectionItems.map((item) => (
              <MenuItem
                key={item.id}
                active={activeSection === item.id}
                icon={item.icon}
                label={item.label}
                onSelect={() => onScrollToSection(item.id)}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
              label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
              onSelect={onToggleSidebar}
            />
            <MenuItem
              icon={theme === "dark" ? Sun : Moon}
              label={theme === "dark" ? "浅色模式" : "深色模式"}
              onSelect={onToggleTheme}
            />
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>

      <Menubar.Menu>
        <Menubar.Trigger className={menuTriggerClass}>运行时</Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className={menuContentClass} align="start">
            <MenuItem icon={RefreshCw} label="刷新目录" onSelect={() => void store.refresh()} />
            <MenuItem
              icon={Bug}
              label={ipcMonitorStore.isOpen ? "隐藏 IPC 面板" : "显示 IPC 面板"}
              onSelect={() => ipcMonitorStore.toggleOpen()}
            />
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    </Menubar.Root>
  );
}

const menuTriggerClass =
  "rounded-[5px] px-3 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground";
const menuContentClass =
  "z-[100] min-w-52 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-xl shadow-black/10 outline-none";
const menuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded-[5px] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

function MenuItem({
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menubar.Item className={menuItemClass} onSelect={onSelect}>
      <Icon size={15} />
      <span className="flex-1">{label}</span>
      {active ? <CheckCircle2 size={14} /> : null}
    </Menubar.Item>
  );
}

function MenuSeparator() {
  return <Menubar.Separator className="my-1 h-px bg-border" />;
}

function Sidebar({
  activeSection,
  collapsed,
  connection,
  onOpenIpc,
  onOpenPreferences,
  onScrollToSection,
  onToggleCollapsed,
}: {
  activeSection: SectionId;
  collapsed: boolean;
  connection: string;
  onOpenIpc: () => void;
  onOpenPreferences: () => void;
  onScrollToSection: (section: SectionId) => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ${
        collapsed ? "w-[72px]" : "w-64"
      }`}
    >
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-accent">
              Python Sidecar
            </p>
            <p className="truncate text-sm font-semibold">Task Runtime</p>
          </div>
        )}
        <TooltipButton
          label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          className="h-9 w-9 shrink-0"
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </TooltipButton>
      </div>

      <nav className="grid gap-1 px-2">
        {sectionItems.map((item) => (
          <SidebarItem
            key={item.id}
            active={activeSection === item.id}
            collapsed={collapsed}
            icon={item.icon}
            label={item.label}
            onClick={() => onScrollToSection(item.id)}
          />
        ))}
        <SidebarItem
          active={ipcMonitorStore.isOpen}
          collapsed={collapsed}
          icon={TerminalSquare}
          label="IPC 监控"
          onClick={onOpenIpc}
        />
        <SidebarItem
          active={false}
          collapsed={collapsed}
          icon={Settings}
          label="首选项"
          onClick={onOpenPreferences}
        />
      </nav>

      <div className="mt-auto border-t border-border p-3">
        <div
          className={`flex items-center gap-3 rounded-md bg-surface-subtle p-2 ${
            collapsed ? "justify-center" : ""
          }`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${connectionDotClass(connection)}`} />
          {collapsed ? null : (
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">连接状态</p>
              <p className="truncate text-sm font-semibold">{connection}</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function SidebarItem({
  active,
  collapsed,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  const button = (
    <button
      type="button"
      className={`flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium outline-none transition-colors ${
        active
          ? "bg-accent text-accent-foreground shadow-sm"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      } ${collapsed ? "justify-center px-0" : ""}`}
      onClick={onClick}
    >
      <Icon size={18} />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {!collapsed && active ? <ChevronRight className="ml-auto" size={16} /> : null}
    </button>
  );

  if (!collapsed) {
    return button;
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={tooltipClass} side="right" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function OverviewSection() {
  const store = taskRuntimeStore;

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Runtime"
        title="任务运行总览"
        action={
          <ActionButton variant="secondary" onClick={() => void store.refresh()}>
            <RefreshCw size={16} />
            刷新
          </ActionButton>
        }
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Activity} label="PID" value={store.systemInfo?.pid ?? "--"} />
        <Metric icon={Database} label="任务数" value={store.catalog.length || "--"} />
        <Metric icon={Cpu} label="活动运行" value={store.activeRunCount} />
        <Metric icon={Timer} label="Python" value={store.systemInfo?.python_version ?? "--"} />
      </section>
    </div>
  );
}

function TasksSection() {
  const store = taskRuntimeStore;

  return (
    <Panel title="任务目录" action={<StatusBadge variant="info">{store.catalog.length}</StatusBadge>}>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {store.catalog.map((task) => (
          <TaskCard key={task.name} task={task} />
        ))}
      </div>
    </Panel>
  );
}

function RunsSection() {
  const store = taskRuntimeStore;

  return (
    <Panel title="运行记录" action={<StatusBadge variant="neutral">{store.runList.length}</StatusBadge>}>
      <RunList />
    </Panel>
  );
}

function PreferencesDialog({
  open,
  sidebarCollapsed,
  theme,
  onOpenChange,
  onSidebarCollapsedChange,
  onThemeChange,
}: {
  open: boolean;
  sidebarCollapsed: boolean;
  theme: ThemeMode;
  onOpenChange: (open: boolean) => void;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  onThemeChange: (theme: ThemeMode) => void;
}) {
  const store = taskRuntimeStore;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[100] grid w-[min(620px,calc(100vw-32px))] max-h-[calc(100vh-72px)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-auto rounded-md border border-border bg-popover p-5 text-popover-foreground shadow-2xl outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-bold">首选项</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                外观、导航和运行时状态
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <TooltipButton label="关闭" className="h-9 w-9">
                <X size={16} />
              </TooltipButton>
            </Dialog.Close>
          </div>

          <div className="grid gap-3">
            <PreferenceRow
              title="深色模式"
              control={
                <SwitchControl
                  checked={theme === "dark"}
                  onCheckedChange={(checked) => onThemeChange(checked ? "dark" : "light")}
                />
              }
            />
            <PreferenceRow
              title="折叠侧边导航"
              control={
                <SwitchControl checked={sidebarCollapsed} onCheckedChange={onSidebarCollapsedChange} />
              }
            />
            <PreferenceRow
              title="IPC 快捷面板"
              control={
                <SwitchControl
                  checked={ipcMonitorStore.isOpen}
                  onCheckedChange={(checked) => ipcMonitorStore.setOpen(checked)}
                />
              }
            />
          </div>

          <div className="grid gap-2 rounded-md border border-border bg-surface-subtle p-3">
            <PreferenceSummary label="连接" value={store.connection} />
            <PreferenceSummary label="Python" value={store.systemInfo?.python_version ?? "--"} />
            <PreferenceSummary label="任务数" value={store.catalog.length || "--"} />
            <PreferenceSummary label="活动运行" value={store.activeRunCount} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PageHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-normal text-foreground sm:text-3xl">{title}</h1>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4">
        <h2 className="truncate text-sm font-bold">{title}</h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
}) {
  return (
    <article className="flex h-[76px] min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-4 shadow-sm">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
        <Icon size={19} />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <strong className="block truncate text-base">{value}</strong>
      </div>
    </article>
  );
}

const TaskCard = observer(({ task }: { task: TaskDescriptor }) => {
  const store = taskRuntimeStore;
  const Icon = task.name.includes("cpu") ? Cpu : task.kind === "blocking_io" ? Database : Timer;
  const busy = store.busyTaskNames.has(task.name);

  return (
    <article className="grid gap-3 rounded-md border border-border bg-surface-subtle p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface text-accent ring-1 ring-border">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold">{task.title}</h3>
          <p className="truncate text-xs text-muted-foreground">{task.name}</p>
        </div>
        <StatusBadge variant="info">{kindLabel(task.kind)}</StatusBadge>
      </div>

      <textarea
        className="min-h-[104px] w-full resize-y rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/15"
        value={store.payloadDrafts.get(task.name) ?? "{}"}
        onChange={(event) => store.setPayloadDraft(task.name, event.currentTarget.value)}
        spellCheck={false}
        aria-label={`${task.name} payload`}
      />

      <ActionButton onClick={() => void store.start(task)} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
        启动
      </ActionButton>
    </article>
  );
});

function RunList() {
  const store = taskRuntimeStore;

  if (!store.runList.length) {
    return (
      <div className="grid min-h-[220px] place-items-center rounded-md border border-dashed border-border bg-surface-subtle text-sm text-muted-foreground">
        暂无运行记录
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {store.runList.map((run) => (
        <RunRow key={run.task_id} run={run} />
      ))}
    </div>
  );
}

const RunRow = observer(({ run }: { run: TaskStatusResult }) => {
  const cancellable = ["queued", "running", "cancelling"].includes(run.state);

  return (
    <article className="flex items-start gap-3 rounded-md border border-border bg-surface-subtle p-4">
      <div className="grid min-w-0 flex-1 gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {statusIcon(run.state)}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-bold">{run.task_name}</h3>
            <p className="truncate text-xs text-muted-foreground">{run.task_id}</p>
          </div>
          <StatusBadge variant={statusVariant(run.state)}>{run.state}</StatusBadge>
        </div>
        <ProgressBar value={run.progress} />
        <div className="flex justify-between gap-3 text-xs text-muted-foreground">
          <span>{Math.round(run.progress * 100)}%</span>
          <span className="truncate">{run.message ?? "--"}</span>
        </div>
        {run.result ? (
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-code p-3 text-xs text-code-foreground">
            {JSON.stringify(run.result, null, 2)}
          </pre>
        ) : null}
        {run.error ? <p className="text-sm text-danger">{run.error}</p> : null}
      </div>

      {cancellable ? (
        <TooltipButton label="取消" onClick={() => void taskRuntimeStore.cancel(run.task_id)}>
          <Square size={15} />
        </TooltipButton>
      ) : null}
    </article>
  );
});

function PreferenceRow({ title, control }: { title: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface-subtle p-4">
      <h3 className="min-w-0 text-sm font-bold">{title}</h3>
      {control}
    </div>
  );
}

function PreferenceSummary({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <strong className="truncate text-sm">{value}</strong>
    </div>
  );
}

function SwitchControl({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="relative h-6 w-11 shrink-0 rounded-full border border-border bg-muted outline-none transition-colors data-[state=checked]:bg-accent"
    >
      <Switch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[21px]" />
    </Switch.Root>
  );
}

function ErrorBand({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
      <XCircle size={18} />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}

function ActionButton({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const variantClass = {
    primary: "border-accent bg-accent text-accent-foreground hover:bg-accent-strong",
    secondary: "border-border bg-surface text-foreground hover:bg-muted",
    ghost: "border-transparent bg-transparent text-foreground hover:bg-muted",
    danger: "border-danger bg-danger text-danger-foreground hover:bg-danger/90",
  }[variant];

  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={`inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-bold outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${variantClass} ${className}`}
    />
  );
}

function TooltipButton({
  label,
  className = "h-9 w-9",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          {...props}
          type={props.type ?? "button"}
          aria-label={label}
          className={`inline-grid place-items-center rounded-md border border-border bg-surface text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={tooltipClass} sideOffset={8}>
          {label}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const tooltipClass =
  "z-[110] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-semibold text-popover-foreground shadow-lg";

function StatusBadge({ variant = "neutral", children }: { variant?: BadgeVariant; children: ReactNode }) {
  const variantClass: Record<BadgeVariant, string> = {
    neutral: "border-border bg-muted text-muted-foreground",
    good: "border-success/20 bg-success/10 text-success",
    warn: "border-warning/20 bg-warning/10 text-warning",
    bad: "border-danger/20 bg-danger/10 text-danger",
    info: "border-info/20 bg-info/10 text-info",
  };

  return (
    <span
      className={`inline-flex min-h-6 shrink-0 items-center justify-center rounded-full border px-2 text-[11px] font-extrabold uppercase leading-none ${variantClass[variant]}`}
    >
      {children}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(value, 1));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-progress transition-[width] duration-200"
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

function kindLabel(kind: TaskDescriptor["kind"]) {
  return kind.replace("_", " ");
}

function connectionDotClass(connection: string) {
  if (connection === "ready") {
    return "bg-success";
  }
  if (connection === "error") {
    return "bg-danger";
  }
  return "bg-warning";
}

function statusVariant(state: TaskStatusResult["state"]): BadgeVariant {
  if (state === "completed") {
    return "good";
  }
  if (state === "failed" || state === "cancelled") {
    return "bad";
  }
  if (state === "cancelling") {
    return "warn";
  }
  return "info";
}

function statusIcon(state: TaskStatusResult["state"]) {
  if (state === "completed") {
    return <CheckCircle2 className="mt-0.5 shrink-0 text-success" size={18} />;
  }
  if (state === "failed" || state === "cancelled") {
    return <XCircle className="mt-0.5 shrink-0 text-danger" size={18} />;
  }
  return <Loader2 className="mt-0.5 shrink-0 animate-spin text-info" size={18} />;
}

export default App;
