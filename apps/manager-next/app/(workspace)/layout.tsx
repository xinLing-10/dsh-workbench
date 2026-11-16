import { WorkspaceProvider } from "../../components/workspace-provider";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}
