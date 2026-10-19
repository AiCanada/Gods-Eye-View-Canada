/**
 * Ending a server child and everything it started. The MLflow server and
 * `mlflow models serve` run uvicorn as a process of their own; on Windows the
 * `py` launcher ends its own child but lets grandchildren go on (its job object
 * lets them break away), so killing `py` would leave uvicorn listening. Found
 * 2026-10-18: a killed MLflow server still answered on its port.
 *
 * Windows: `taskkill /PID <pid> /T /F` ends the whole tree. Elsewhere the child
 * is started in its own process group (`spawnOptions`) and the group is ended.
 */
import { spawnSync } from 'node:child_process';

/** Spawn options that let `killTree` end the child's whole tree. */
export function treeSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? {} : { detached: true };
}

/**
 * @param {{pid?: number, kill?: Function}} child
 * @param {{platform?: string, run?: typeof spawnSync, signalGroup?: (pid: number) => void}} [options]
 */
export function killTree(
  child,
  {
    platform = process.platform,
    run = spawnSync,
    signalGroup = (pid) => process.kill(-pid, 'SIGTERM'),
  } = {},
) {
  if (!child) return;
  const pid = Number(child.pid);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      if (platform === 'win32')
        run('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 15_000,
        });
      else signalGroup(pid);
    } catch {
      /* already gone */
    }
  }
  try {
    child.kill?.();
  } catch {
    /* already gone */
  }
}
