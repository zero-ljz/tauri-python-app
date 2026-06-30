import { observer } from "mobx-react-lite";
import { MainLayout } from "@/components/layout/MainLayout";

// 极简应用主入口视图组件
const App = observer(() => {
  return (
    <MainLayout>
      {/* 窗口主体背景：使用 Win32 经典的浅灰色（#f0f0f0） */}
      <div className="flex flex-col h-full w-full bg-[#f0f0f0]" />
    </MainLayout>
  );
});

export default App;
