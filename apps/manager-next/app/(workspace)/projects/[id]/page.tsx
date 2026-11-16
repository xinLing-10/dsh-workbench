import { ProjectView } from "../../../../components/project-view";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectView key={id} projectId={id} />;
}
