import { execCommand } from "./util/process.js";

export interface DockerCleanupOptions {
  enabled?: boolean;
  removeVolumesOnSuccess?: boolean;
  removeVolumesOnFailure?: boolean;
}

export interface DockerCleanupResult {
  project: string;
  actions: string[];
  skipped?: string;
}

export async function cleanupBatchDockerResources(rootCwd: string, batchNumber: number, outcome: "success" | "failure", options: DockerCleanupOptions = {}): Promise<DockerCleanupResult> {
  if (options.enabled === false) return { project: composeProjectName(batchNumber), actions: [], skipped: "disabled" };
  const project = composeProjectName(batchNumber);
  const removeVolumes = outcome === "success" ? options.removeVolumesOnSuccess !== false : options.removeVolumesOnFailure !== false;
  const actions: string[] = [];
  if (!(await dockerAvailable(rootCwd))) return { project, actions, skipped: "docker-unavailable" };

  const containers = await dockerList(rootCwd, `ps -aq --filter label=com.docker.compose.project=${project}`);
  for (const id of containers) actions.push(await dockerRun(rootCwd, `rm -f ${id}`, `container:${id}`));

  const networks = await dockerList(rootCwd, `network ls -q --filter label=com.docker.compose.project=${project}`);
  for (const id of networks) actions.push(await dockerRun(rootCwd, `network rm ${id}`, `network:${id}`));

  if (removeVolumes) {
    const volumes = await dockerList(rootCwd, `volume ls -q --filter label=com.docker.compose.project=${project}`);
    for (const id of volumes) actions.push(await dockerRun(rootCwd, `volume rm -f ${id}`, `volume:${id}`));
  } else {
    actions.push("volumes:kept");
  }

  return { project, actions };
}

export function composeProjectName(batchNumber: number): string {
  return `batch-${String(batchNumber).padStart(3, "0")}`;
}

async function dockerAvailable(cwd: string): Promise<boolean> {
  const result = await execCommand("docker version --format '{{.Server.Version}}'", cwd, 30_000);
  return result.exitCode === 0;
}

async function dockerList(cwd: string, args: string): Promise<string[]> {
  const result = await execCommand(`docker ${args}`, cwd, 30_000);
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z0-9_.-]+$/.test(line));
}

async function dockerRun(cwd: string, args: string, label: string): Promise<string> {
  const result = await execCommand(`docker ${args}`, cwd, 60_000);
  return result.exitCode === 0 ? `${label}:removed` : `${label}:skipped:${summarize(result.stderr || result.stdout)}`;
}

function summarize(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 160) || "no output";
}
