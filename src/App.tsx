import { observer } from "mobx-react-lite";
import { MainLayout } from "@/components/layout/MainLayout";

// 极简应用主入口视图组件
const App = observer(() => {
  return (
    <MainLayout>
      <div className="flex h-full w-full flex-col bg-muted" />
    </MainLayout>
  );
});

export default App;
