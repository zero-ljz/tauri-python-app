import { useEffect, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
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
  Menu,
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
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "./components/ui/menubar";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { IpcMonitor } from "./components/IpcMonitor";
import type { TaskDescriptor, TaskStatusResult } from "./generated/sidecarTypes";
import { cn } from "./lib/utils";
import { ipcMonitorStore } from "./stores/ipcMonitorStore";
import { taskRuntimeStore } from "./stores/taskRuntimeStore";

type ThemeMode = "light" | "dark";
type SectionId = "overview" | "tasks" | "runs";
type BadgeVariant = "default" | "secondary" | "destructive" | "outline";
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

  const toggleTheme = () => setTheme((current) => (current === "dark" ? "light" : "dark"));

  const scrollToSection = (section: SectionId) => {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <TooltipProvider delayDuration={180}>
      <div className="h-screen overflow-hidden bg-background text-foreground antialiased">
        <ResizeHandles />
        <TitleBar
          activeSection={activeSection}
          sidebarCollapsed={sidebarCollapsed}
          theme={theme}
          onOpenPreferences={() => setPreferencesOpen(true)}
          onScrollToSection={scrollToSection}
          onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
          onToggleTheme={toggleTheme}
        />

        <div className="flex h-screen flex-col pt-9">
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

            <main className="min-w-0 flex-1 overflow-auto scroll-smooth bg-background">
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
    </TooltipProvider>
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
          className={cn("fixed z-[80] bg-transparent", handle.className)}
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
  activeSection,
  sidebarCollapsed,
  theme,
  onOpenPreferences,
  onScrollToSection,
  onToggleSidebar,
  onToggleTheme,
}: {
  activeSection: SectionId;
  sidebarCollapsed: boolean;
  theme: ThemeMode;
  onOpenPreferences: () => void;
  onScrollToSection: (section: SectionId) => void;
  onToggleSidebar: () => void;
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

  const toggleMaximize = () => {
    runWindowAction(async (window) => {
      await window.toggleMaximize();
      setIsMaximized(await window.isMaximized());
    });
  };

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.detail > 1 || isNoDragTarget(event.target)) {
      return;
    }
    runWindowAction((window) => window.startDragging());
  };

  const handleDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isNoDragTarget(event.target)) {
      return;
    }
    toggleMaximize();
  };

  return (
    <header
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[70] flex h-9 select-none items-center border-b bg-background/95 text-sm backdrop-blur"
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleDrag}
    >
      <div className="z-10 flex h-full min-w-0 items-center gap-1 pl-3 pr-2">
        <img alt="" className="size-4 shrink-0" draggable={false} src="/tauri.svg" />
        <div data-no-drag className="flex h-full items-center">
          <AppMenuBar
            activeSection={activeSection}
            sidebarCollapsed={sidebarCollapsed}
            theme={theme}
            onOpenPreferences={onOpenPreferences}
            onScrollToSection={onScrollToSection}
            onToggleSidebar={onToggleSidebar}
            onToggleTheme={onToggleTheme}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute left-1/2 top-1/2 max-w-[min(38vw,360px)] -translate-x-1/2 -translate-y-1/2 truncate px-3 text-sm font-medium">
        tauri-python-app
      </div>

      <div className="h-full min-w-8 flex-1" data-tauri-drag-region />

      <div data-no-drag className="z-10 flex h-full items-center">
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
          className="hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => runWindowAction((window) => window.close())}
        >
          <X size={15} />
        </TitleBarButton>
      </div>
    </header>
  );
}

function isNoDragTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-no-drag]"));
}

function TitleBarButton({
  label,
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button
      {...props}
      aria-label={label}
      className={cn("h-9 w-11 rounded-none text-muted-foreground hover:text-foreground", className)}
      size="icon"
      title={label}
      type="button"
      variant="ghost"
    />
  );
}

function AppMenuBar({
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
    <>
      <Menubar className="hidden h-9 rounded-none bg-transparent p-0 md:flex">
        <MenubarMenu>
          <MenubarTrigger className="h-7">文件</MenubarTrigger>
          <MenubarContent>
            <MenuItem icon={RefreshCw} label="刷新" onSelect={() => void store.refresh()} />
            <MenuItem icon={Settings} label="首选项" onSelect={onOpenPreferences} />
            <MenubarSeparator />
            <MenuItem
              icon={X}
              label="关闭窗口"
              onSelect={() => runWindowAction((window) => window.close())}
              variant="destructive"
            />
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger className="h-7">视图</MenubarTrigger>
          <MenubarContent>
            {sectionItems.map((item) => (
              <MenuItem
                key={item.id}
                active={activeSection === item.id}
                icon={item.icon}
                label={item.label}
                onSelect={() => onScrollToSection(item.id)}
              />
            ))}
            <MenubarSeparator />
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
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger className="h-7">运行时</MenubarTrigger>
          <MenubarContent>
            <MenuItem icon={RefreshCw} label="刷新目录" onSelect={() => void store.refresh()} />
            <MenuItem
              icon={Bug}
              label={ipcMonitorStore.isOpen ? "隐藏 IPC 面板" : "显示 IPC 面板"}
              onSelect={() => ipcMonitorStore.toggleOpen()}
            />
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <Menubar className="h-9 rounded-none bg-transparent p-0 md:hidden">
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2" aria-label="菜单">
            <Menu size={16} />
          </MenubarTrigger>
          <MenubarContent>
            <MenuItem icon={RefreshCw} label="刷新" onSelect={() => void store.refresh()} />
            <MenuItem icon={Settings} label="首选项" onSelect={onOpenPreferences} />
            <MenubarSeparator />
            {sectionItems.map((item) => (
              <MenuItem
                key={item.id}
                active={activeSection === item.id}
                icon={item.icon}
                label={item.label}
                onSelect={() => onScrollToSection(item.id)}
              />
            ))}
            <MenubarSeparator />
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
            <MenuItem
              icon={Bug}
              label={ipcMonitorStore.isOpen ? "隐藏 IPC 面板" : "显示 IPC 面板"}
              onSelect={() => ipcMonitorStore.toggleOpen()}
            />
            <MenubarSeparator />
            <MenuItem
              icon={X}
              label="关闭窗口"
              onSelect={() => runWindowAction((window) => window.close())}
              variant="destructive"
            />
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  active,
  onSelect,
  variant,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onSelect: () => void;
  variant?: "default" | "destructive";
}) {
  return (
    <MenubarItem onSelect={onSelect} variant={variant}>
      <Icon />
      <span className="flex-1">{label}</span>
      {active ? <CheckCircle2 /> : null}
    </MenubarItem>
  );
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
      className={cn(
        "flex shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200",
        collapsed ? "w-[72px]" : "w-64",
      )}
    >
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold uppercase text-muted-foreground">
              Python Sidecar
            </p>
            <p className="truncate text-sm font-semibold">Task Runtime</p>
          </div>
        )}
        <TooltipButton
          label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
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
          label="IPC 调试"
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
          className={cn(
            "flex items-center gap-3 rounded-md border bg-background p-2",
            collapsed && "justify-center",
          )}
        >
          <span className={cn("size-2.5 rounded-full", connectionDotClass(connection))} />
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
    <Button
      className={cn(
        "h-10 justify-start px-3",
        !active && "text-muted-foreground",
        collapsed && "justify-center px-0",
      )}
      onClick={onClick}
      type="button"
      variant={active ? "default" : "ghost"}
    >
      <Icon size={18} />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {!collapsed && active ? <ChevronRight className="ml-auto" size={16} /> : null}
    </Button>
  );

  if (!collapsed) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function OverviewSection() {
  const store = taskRuntimeStore;

  return (
    <div className="grid gap-5">
      <PageHeader
        action={
          <Button variant="secondary" onClick={() => void store.refresh()}>
            <RefreshCw size={16} />
            刷新
          </Button>
        }
        eyebrow="Runtime"
        title="任务运行总览"
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
    <section className="grid gap-3">
      <SectionHeader title="任务目录" action={<StatusBadge>{store.catalog.length}</StatusBadge>} />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {store.catalog.map((task) => (
          <TaskCard key={task.name} task={task} />
        ))}
      </div>
    </section>
  );
}

function RunsSection() {
  const store = taskRuntimeStore;

  return (
    <section className="grid gap-3">
      <SectionHeader title="运行记录" action={<StatusBadge variant="secondary">{store.runList.length}</StatusBadge>} />
      <RunList />
    </section>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>首选项</DialogTitle>
          <DialogDescription>外观、导航和运行时状态。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <PreferenceRow
            title="深色模式"
            control={
              <Switch
                checked={theme === "dark"}
                onCheckedChange={(checked) => onThemeChange(checked ? "dark" : "light")}
              />
            }
          />
          <PreferenceRow
            title="折叠侧边导航"
            control={<Switch checked={sidebarCollapsed} onCheckedChange={onSidebarCollapsedChange} />}
          />
          <PreferenceRow
            title="IPC 调试面板"
            control={
              <Switch
                checked={ipcMonitorStore.isOpen}
                onCheckedChange={(checked) => ipcMonitorStore.setOpen(checked)}
              />
            }
          />
        </div>

        <div className="grid gap-2 rounded-md border p-3">
          <PreferenceSummary label="连接" value={store.connection} />
          <PreferenceSummary label="Python" value={store.systemInfo?.python_version ?? "--"} />
          <PreferenceSummary label="任务数" value={store.catalog.length || "--"} />
          <PreferenceSummary label="活动运行" value={store.activeRunCount} />
        </div>
      </DialogContent>
    </Dialog>
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
        <p className="text-xs font-medium uppercase text-muted-foreground">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-normal text-foreground sm:text-3xl">
          {title}
        </h1>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3">
      <h2 className="truncate text-sm font-semibold">{title}</h2>
      {action}
    </div>
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
    <Card className="flex h-[76px] min-w-0 flex-row items-center gap-3 px-4 shadow-xs">
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon size={19} />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <strong className="block truncate text-base">{value}</strong>
      </div>
    </Card>
  );
}

const TaskCard = observer(({ task }: { task: TaskDescriptor }) => {
  const store = taskRuntimeStore;
  const Icon = task.name.includes("cpu") ? Cpu : task.kind === "blocking_io" ? Database : Timer;
  const busy = store.busyTaskNames.has(task.name);

  return (
    <Card className="grid gap-3 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold">{task.title}</h3>
          <p className="truncate text-xs text-muted-foreground">{task.name}</p>
        </div>
        <StatusBadge variant="outline">{kindLabel(task.kind)}</StatusBadge>
      </div>

      <Textarea
        aria-label={`${task.name} payload`}
        className="min-h-[104px] resize-y font-mono text-xs"
        spellCheck={false}
        value={store.payloadDrafts.get(task.name) ?? "{}"}
        onChange={(event) => store.setPayloadDraft(task.name, event.currentTarget.value)}
      />

      <Button onClick={() => void store.start(task)} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
        启动
      </Button>
    </Card>
  );
});

function RunList() {
  const store = taskRuntimeStore;

  if (!store.runList.length) {
    return (
      <div className="grid min-h-[220px] place-items-center rounded-md border border-dashed bg-muted text-sm text-muted-foreground">
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
    <Card className="flex items-start gap-3 p-4">
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
          <pre className="max-h-40 overflow-auto rounded-md border bg-muted p-3 text-xs text-foreground">
            {JSON.stringify(run.result, null, 2)}
          </pre>
        ) : null}
        {run.error ? <p className="text-sm text-destructive">{run.error}</p> : null}
      </div>

      {cancellable ? (
        <TooltipButton label="取消" onClick={() => void taskRuntimeStore.cancel(run.task_id)}>
          <Square size={15} />
        </TooltipButton>
      ) : null}
    </Card>
  );
});

function PreferenceRow({ title, control }: { title: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-4">
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

function ErrorBand({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <XCircle size={18} />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}

function TooltipButton({
  label,
  className,
  variant = "outline",
  size = "icon",
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          aria-label={label}
          className={className}
          size={size}
          title={label}
          type="button"
          variant={variant}
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}

function StatusBadge({ variant = "secondary", children }: { variant?: BadgeVariant; children: ReactNode }) {
  return (
    <Badge
      className="min-h-6 rounded-full px-2 text-[11px] font-extrabold uppercase leading-none"
      variant={variant}
    >
      {children}
    </Badge>
  );
}

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(value, 1));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-200"
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
    return "bg-primary";
  }
  if (connection === "error") {
    return "bg-destructive";
  }
  return "bg-muted-foreground";
}

function statusVariant(state: TaskStatusResult["state"]): BadgeVariant {
  if (state === "completed") {
    return "default";
  }
  if (state === "failed" || state === "cancelled") {
    return "destructive";
  }
  if (state === "cancelling") {
    return "outline";
  }
  return "secondary";
}

function statusIcon(state: TaskStatusResult["state"]) {
  if (state === "completed") {
    return <CheckCircle2 className="mt-0.5 shrink-0 text-primary" size={18} />;
  }
  if (state === "failed" || state === "cancelled") {
    return <XCircle className="mt-0.5 shrink-0 text-destructive" size={18} />;
  }
  return <Loader2 className="mt-0.5 shrink-0 animate-spin text-muted-foreground" size={18} />;
}

export default App;
