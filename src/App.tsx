import { useEffect, type ReactNode } from "react";
import { observer } from "mobx-react-lite";
import {
  Activity,
  CheckCircle2,
  Cpu,
  Database,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Timer,
  XCircle,
} from "lucide-react";

import "./App.css";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Progress } from "./components/ui/progress";
import { taskRuntimeStore } from "./stores/taskRuntimeStore";
import type { TaskDescriptor, TaskStatusResult } from "./generated/sidecarTypes";

const App = observer(() => {
  const store = taskRuntimeStore;

  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Tauri v2 / Python sidecar</p>
          <h1>Task Runtime</h1>
        </div>
        <div className="topbar__actions">
          <Badge variant={connectionVariant(store.connection)}>{store.connection}</Badge>
          <Button
            variant="secondary"
            size="icon"
            onClick={() => void store.refresh()}
            title="Refresh"
          >
            <RefreshCw size={17} />
          </Button>
        </div>
      </header>

      {store.lastError ? (
        <div className="error-band">
          <XCircle size={18} />
          <span>{store.lastError}</span>
        </div>
      ) : null}

      <section className="metrics-strip">
        <Metric icon={<Activity size={18} />} label="PID" value={store.systemInfo?.pid ?? "--"} />
        <Metric
          icon={<Database size={18} />}
          label="Tasks"
          value={store.catalog.length || "--"}
        />
        <Metric icon={<Cpu size={18} />} label="Active" value={store.activeRunCount} />
        <Metric
          icon={<Timer size={18} />}
          label="Python"
          value={store.systemInfo?.python_version ?? "--"}
        />
      </section>

      <section className="workspace-grid">
        <section className="panel">
          <div className="panel__header">
            <h2>Catalog</h2>
          </div>
          <div className="task-list">
            {store.catalog.map((task) => (
              <TaskCard key={task.name} task={task} />
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel__header">
            <h2>Runs</h2>
          </div>
          <div className="run-list">
            {store.runList.length ? (
              store.runList.map((run) => <RunRow key={run.task_id} run={run} />)
            ) : (
              <div className="empty-state">No runs yet</div>
            )}
          </div>
        </section>
      </section>

      <section className="panel log-panel">
        <div className="panel__header">
          <h2>Sidecar Logs</h2>
        </div>
        <div className="log-stream">
          {store.logs.length ? (
            store.logs.map((line, index) => <code key={`${line}-${index}`}>{line}</code>)
          ) : (
            <span className="muted">No stderr or lifecycle events</span>
          )}
        </div>
      </section>
    </main>
  );
});

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="metric">
      <span className="metric__icon">{icon}</span>
      <span className="metric__label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const TaskCard = observer(({ task }: { task: TaskDescriptor }) => {
  const store = taskRuntimeStore;
  const Icon = task.name.includes("cpu") ? Cpu : task.kind === "blocking_io" ? Database : Timer;
  const busy = store.busyTaskNames.has(task.name);

  return (
    <article className="task-card">
      <div className="task-card__title">
        <Icon size={18} />
        <div>
          <h3>{task.title}</h3>
          <span>{task.name}</span>
        </div>
        <Badge variant="info">{kindLabel(task.kind)}</Badge>
      </div>
      <textarea
        value={store.payloadDrafts.get(task.name) ?? "{}"}
        onChange={(event) => store.setPayloadDraft(task.name, event.currentTarget.value)}
        spellCheck={false}
        aria-label={`${task.name} payload`}
      />
      <Button onClick={() => void store.start(task)} disabled={busy}>
        {busy ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
        Start
      </Button>
    </article>
  );
});

const RunRow = observer(({ run }: { run: TaskStatusResult }) => {
  const cancellable = ["queued", "running", "cancelling"].includes(run.state);

  return (
    <article className="run-row">
      <div className="run-row__main">
        <div className="run-row__title">
          {statusIcon(run.state)}
          <div>
            <h3>{run.task_name}</h3>
            <span>{run.task_id}</span>
          </div>
          <Badge variant={statusVariant(run.state)}>{run.state}</Badge>
        </div>
        <Progress value={run.progress} />
        <div className="run-row__meta">
          <span>{Math.round(run.progress * 100)}%</span>
          <span>{run.message ?? "--"}</span>
        </div>
        {run.result ? <pre>{JSON.stringify(run.result, null, 2)}</pre> : null}
        {run.error ? <p className="run-row__error">{run.error}</p> : null}
      </div>
      {cancellable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void taskRuntimeStore.cancel(run.task_id)}
          title="Cancel"
        >
          <Square size={15} />
        </Button>
      ) : null}
    </article>
  );
});

function kindLabel(kind: TaskDescriptor["kind"]) {
  return kind.replace("_", " ");
}

function connectionVariant(connection: string) {
  if (connection === "ready") {
    return "good";
  }
  if (connection === "error") {
    return "bad";
  }
  return "warn";
}

function statusVariant(state: TaskStatusResult["state"]) {
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
    return <CheckCircle2 className="status-icon status-icon--good" size={18} />;
  }
  if (state === "failed" || state === "cancelled") {
    return <XCircle className="status-icon status-icon--bad" size={18} />;
  }
  return <Loader2 className="status-icon spin" size={18} />;
}

export default App;
