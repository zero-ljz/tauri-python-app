import { observer } from "mobx-react-lite";
import { AppMenu } from "./AppMenu";
import { WindowControls } from "./WindowControls";
import { windowMaximize } from "@/lib/tauri-rpc";

// 极简自定义标题栏组件（保持纯白色背景 bg-white）
export const TitleBar = observer(() => {
  // 双击标题栏最大化或还原窗口
  const handleDoubleClick = () => windowMaximize();

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between border-b bg-white select-none pr-0 pl-0"
      onDoubleClick={handleDoubleClick}
    >
      {/* ── 左边最外边缘：微小的可拖动空白边距（w-2） ── */}
      <div className="w-2 h-full cursor-default" data-tauri-drag-region />

      {/* ── 左边：菜单栏 ── */}
      <div className="flex items-center h-full">
        <AppMenu />
      </div>

      {/* ── 居中：纯窗口拖拽区域 ── */}
      <div
        className="flex-1 h-full cursor-default"
        data-tauri-drag-region
      >
        {/* 允许用户点击此处并拖动窗口 */}
      </div>

      {/* ── 右边：窗口控制按钮（无缝贴边） ── */}
      <div className="flex items-center h-full">
        <WindowControls />
      </div>
    </div>
  );
});
