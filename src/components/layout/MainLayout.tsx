import { observer } from "mobx-react-lite";
import { TitleBar } from "@/components/titlebar/TitleBar";

interface MainLayoutProps {
  children: React.ReactNode;
}

// 极简主布局组件（仅包含自定义标题栏与业务主内容区）
export const MainLayout = observer(({ children }: MainLayoutProps) => {
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* 顶部自定义标题栏 */}
      <TitleBar />
      
      {/* 主视图内容区域 */}
      <main className="flex-1 overflow-auto min-h-0">
        {children}
      </main>
    </div>
  );
});
