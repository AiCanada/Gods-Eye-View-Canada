/**
 * The few MLflow REST calls the AI World tab's MLFLOW sections make, against
 * the local MLflow server (server/shared/mlflowJobs.mjs starts it on
 * 127.0.0.1 with its own path prefix). REST, not the Python client, so a run
 * on the GPU in WSL2 is tracked without MLflow installed there: the server
 * reads every trainer's protocol events already and writes them here.
 *
 * https://mlflow.org/docs/latest/api_reference/rest-api.html
 */

/** MLflow's limits for one runs/log-batch call. */
export const MLFLOW_BATCH = Object.freeze({
  metrics: 1000,
  params: 100,
  tags: 100,
});
/** Longest param value and key MLflow keeps. */
export const MLFLOW_PARAM_VALUE_MAX = 6000;
export const MLFLOW_KEY_MAX = 250;

/** A key MLflow accepts: letters, digits, _ - . space / and nothing longer than it keeps. */
export function mlflowKey(raw) {
  const key = String(raw ?? '')
    .replace(/[^A-Za-z0-9_\-. /]/g, '_')
    .slice(0, MLFLOW_KEY_MAX);
  return key || '_';
}

export class MlflowError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 *   baseUrl: the server with its prefix, e.g. http://127.0.0.1:5000/api/mlflow/ui
 */
export function createMlflowRest({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const call = async (method, route, body, { raw = null, type } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method,
        headers:
          raw !== null
            ? { 'Content-Type': type || 'application/octet-stream' }
            : body === undefined
              ? {}
              : { 'Content-Type': 'application/json' },
        body:
          raw !== null
            ? raw
            : body === undefined
              ? undefined
              : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new MlflowError(
        `MLflow did not answer: ${error?.message || error}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text.slice(0, 200) };
    }
    if (!response.ok)
      throw new MlflowError(
        String(payload.message || `HTTP ${response.status}`),
        { status: response.status, code: String(payload.error_code || '') },
      );
    return payload;
  };
  const api = (route) => `/api/2.0/mlflow${route}`;
  const query = (params) =>
    new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
    ).toString();

  return {
    baseUrl: base,
    health: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      timer.unref?.();
      try {
        const response = await fetchImpl(`${base}/health`, {
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    /** The experiment's id, made when there is none by that name. */
    async experimentId(name) {
      try {
        const got = await call(
          'GET',
          `${api('/experiments/get-by-name')}?${query({ experiment_name: name })}`,
        );
        return String(got.experiment.experiment_id);
      } catch (error) {
        if (error.code !== 'RESOURCE_DOES_NOT_EXIST' && error.status !== 404)
          throw error;
      }
      const made = await call('POST', api('/experiments/create'), { name });
      return String(made.experiment_id);
    },
    async createRun({ experimentId, name, startTime, tags = {} }) {
      const got = await call('POST', api('/runs/create'), {
        experiment_id: experimentId,
        run_name: name,
        start_time: startTime,
        tags: Object.entries(tags).map(([key, value]) => ({
          key: mlflowKey(key),
          value: String(value),
        })),
      });
      return {
        runId: String(got.run.info.run_id),
        artifactUri: String(got.run.info.artifact_uri || ''),
      };
    },
    logBatch: (runId, { metrics = [], params = [], tags = [] }) =>
      call('POST', api('/runs/log-batch'), {
        run_id: runId,
        metrics,
        params,
        tags,
      }),
    updateRun: (runId, status, endTime) =>
      call('POST', api('/runs/update'), {
        run_id: runId,
        status,
        end_time: endTime,
      }),
    /** A file into the run's artifacts (the server serves artifacts itself). */
    async uploadArtifact(artifactUri, relPath, bytes, type) {
      const root = String(artifactUri).replace(/^mlflow-artifacts:\/*/, '');
      if (!root || root === String(artifactUri))
        throw new MlflowError(`not a served artifact location: ${artifactUri}`);
      const pathPart = `${root}/${relPath}`
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
      return call(
        'PUT',
        `/api/2.0/mlflow-artifacts/artifacts/${pathPart}`,
        undefined,
        {
          raw: bytes,
          type,
        },
      );
    },
    async registeredModels() {
      const got = await call(
        'GET',
        `${api('/registered-models/search')}?${query({ max_results: 100 })}`,
      );
      return Array.isArray(got.registered_models) ? got.registered_models : [];
    },
    async modelVersions(name) {
      const filter = `name='${String(name).replace(/'/g, "\\'")}'`;
      const got = await call(
        'GET',
        `${api('/model-versions/search')}?${query({ filter, max_results: 200 })}`,
      );
      return Array.isArray(got.model_versions) ? got.model_versions : [];
    },
    setAlias: (name, alias, version) =>
      call('POST', api('/registered-models/alias'), {
        name,
        alias,
        version: String(version),
      }),
    async experimentByName(name) {
      try {
        const got = await call(
          'GET',
          `${api('/experiments/get-by-name')}?${query({ experiment_name: name })}`,
        );
        return got.experiment || null;
      } catch (error) {
        if (error.code === 'RESOURCE_DOES_NOT_EXIST' || error.status === 404)
          return null;
        throw error;
      }
    },
  };
}
