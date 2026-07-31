import React from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("Uncaught frontend error", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex h-screen items-center justify-center bg-background p-8 text-foreground">
        <section
          className="max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-sm"
          role="alert"
        >
          <h1 className="text-lg font-semibold">界面加载失败</h1>
          <p className="text-sm text-muted-foreground">
            前端遇到未处理异常。重新加载通常可以恢复；诊断信息仍保存在应用日志中。
          </p>
          <pre className="max-h-40 overflow-auto rounded bg-muted p-3 text-xs">
            {this.state.error.message}
          </pre>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </section>
      </main>
    );
  }
}
