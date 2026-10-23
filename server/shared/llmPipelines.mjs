/**
 * Each LLM family's training pipeline, as CUSTOM LLM TRAINING offers it
 * (owner request 2026-10-22: "Each LLM will have its own training pipeline
 * determining the type of data and format"). The registry is
 * ml/gevtape/llm_pipelines.json, the one file the Python side trains from
 * (ml.gevtape.llm_pipelines): a family's open sizes and their weight bytes,
 * its licence, the layers its adapters go on, what stays frozen, how its own
 * template renders a training target with thinking off, the data types it
 * takes, what it needs installed, and whether it is a teacher only (too big
 * for any training here).
 *
 * This side adds what the machine decides: which sizes fit the GPU, which
 * split across GPU and RAM, which fit nowhere, and the one command to fetch
 * a base (the app itself downloads no model).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIPELINE_REGISTRY = 'ml/gevtape/llm_pipelines.json';
/** The registry ships with the code: the repository this module is in. */
const DEFAULT_SOURCE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const GIB = 1024 ** 3;
/** Weights take at most this share of the GPU; the rest is activations (ml.gevtape.llm_train). */
const GPU_SHARE = 0.7;
/** RAM kept for everything else when a model is split (ml.gevtape.llm_train). */
const RAM_KEEP = 12 * GIB;
const EMPTY = Object.freeze({ families: [] });
const cache = new Map();

/** The registry file under `root` (the repository); an empty one when it cannot be read. */
export function readPipelineRegistry(root = DEFAULT_SOURCE_ROOT) {
  const file = path.join(root, ...PIPELINE_REGISTRY.split('/'));
  if (cache.has(file)) return cache.get(file);
  let registry = EMPTY;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.families)) registry = parsed;
  } catch {
    registry = EMPTY;
  }
  cache.set(file, registry);
  return registry;
}

/** bf16 weights: two bytes a parameter. */
export const weightBytes = (size) => Math.max(0, Number(size?.params) || 0) * 2;

/** Where a model of `bytes` goes here: the GPU, split across GPU and RAM, or nowhere. */
export function fitFor(bytes, { gpuBytes = 0, ramBytes = 0 } = {}) {
  if (!bytes) return 'split';
  if (gpuBytes && bytes <= GPU_SHARE * gpuBytes) return 'gpu';
  if (bytes <= gpuBytes + Math.max(0, ramBytes - RAM_KEEP)) return 'split';
  return 'none';
}

/**
 * This machine's GPU memory (nvidia-smi, when there is one) and RAM. Read once
 * per process; `execFileImpl` and `totalmem` are seams for tests.
 */
export function machineMemory({
  execFileImpl = execFileSync,
  totalmem = os.totalmem,
} = {}) {
  let gpuBytes = 0;
  try {
    const said = String(
      execFileImpl(
        'nvidia-smi',
        ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
        {
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ),
    );
    const mib = Number(said.trim().split(/\r?\n/)[0]);
    if (Number.isFinite(mib) && mib > 0) gpuBytes = mib * 1024 * 1024;
  } catch {
    gpuBytes = 0;
  }
  return { gpuBytes, ramBytes: Number(totalmem()) || 0 };
}

const complete = (row) => ({
  targets: [],
  skip: [],
  data: ['text'],
  needs: {},
  sizes: [],
  teacherOnly: false,
  experimental: false,
  licence: '',
  notes: '',
  ...row,
  format: {
    system: true,
    thinking: 'none',
    train: {},
    generate: {},
    ...(row?.format || {}),
  },
});

/** The family named, else the generic one. */
export function familyNamed(registry, name) {
  const rows = registry?.families || [];
  return complete(
    rows.find((f) => f.family === name) ||
      rows.find((f) => f.family === 'generic') ||
      {},
  );
}

/**
 * The family a base trains through: by its name where one family shares
 * another's classes (Qwen 3.6), else by the config's model_type or
 * architectures, else the generic one. Mirrors ml.gevtape.llm_pipelines.
 */
export function familyOf(registry, base, config = null) {
  const rows = registry?.families || [];
  const name = String(base || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  for (const row of rows)
    if ((row?.sizes || []).some((s) => s?.id && s.id.toLowerCase() === name))
      return complete(row);
  for (const row of rows)
    for (const needle of row?.match?.name || [])
      if (needle && name.includes(String(needle).toLowerCase()))
        return complete(row);
  const types = new Set(
    [config?.model_type, config?.text_config?.model_type]
      .map((t) => String(t || ''))
      .filter(Boolean),
  );
  const archs = new Set(
    (Array.isArray(config?.architectures) ? config.architectures : []).map(
      String,
    ),
  );
  for (const row of rows) {
    const match = row?.match || {};
    if (
      (match.model_type || []).some((t) => types.has(t)) ||
      (match.architectures || []).some((a) => archs.has(a))
    )
      return complete(row);
  }
  return familyNamed(registry, 'generic');
}

/** The one command that fetches a Hugging Face id into .gev-data/llm/base/. */
export function getCommand(id) {
  const text = String(id || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(text)) return '';
  return `hf download ${text} --local-dir .gev-data/llm/base/${text.split('/').pop()}`;
}

/** Which layers the adapters go on, as a word for the line. */
export function loraKind(targets = []) {
  const set = new Set(targets);
  const mlp = ['gate_proj', 'up_proj', 'down_proj'].some((t) => set.has(t));
  if (set.has('in_proj_qkv')) return 'attention-deltanet';
  if (set.has('in_proj'))
    return mlp ? 'attention-mamba-mlp' : 'attention-mamba';
  return mlp ? 'attention-mlp' : 'attention';
}

/**
 * Every trainable size the registry offers, grouped by family in the
 * registry's order: its id, bytes, fit here, whether it is on this PC and the
 * command to fetch it.
 */
export function baseOptions(
  registry,
  { onMachine = () => false, gpuBytes = 0, ramBytes = 0 } = {},
) {
  const out = [];
  for (const row of registry?.families || []) {
    if (row?.teacherOnly) continue;
    for (const size of row.sizes || []) {
      if (!size?.id) continue;
      const bytes = weightBytes(size);
      out.push({
        id: size.id,
        family: row.family,
        familyLabel: row.label || row.family,
        label: size.label || size.id,
        gb: Math.round(bytes / 1e9),
        fit: fitFor(bytes, { gpuBytes, ramBytes }),
        onMachine: Boolean(onMachine(size.id)),
        default: size.default === true,
        experimental: row.experimental === true,
        get: getCommand(size.id),
      });
    }
  }
  return out;
}

/** The families that are teachers only: never a student here. */
export function teacherFamilies(registry) {
  return (registry?.families || [])
    .filter((row) => row?.teacherOnly)
    .map((row) => ({
      family: row.family,
      label: row.label || row.family,
      licence: row.licence || '',
      sizes: (row.sizes || []).map((s) => ({
        id: s.id || '',
        label: s.label || '',
        params: Number(s.params) || 0,
      })),
      served: row.served || [],
      notes: row.notes || '',
    }));
}

/**
 * The pipeline a base trains through, for the PIPELINE line: the family, its
 * licence, how a target is rendered, where the adapters go, the data types,
 * what it needs, and the fit of the size chosen.
 */
export function pipelineView(
  registry,
  base,
  config = null,
  { gpuBytes = 0, ramBytes = 0 } = {},
) {
  const family = familyOf(registry, base, config);
  const size = (family.sizes || []).find((s) => s.id === base) || null;
  const bytes = size ? weightBytes(size) : 0;
  return {
    family: family.family,
    label: family.label || family.family,
    licence: family.licence || '',
    system: family.format.system !== false,
    thinking: family.format.thinking || 'none',
    targets: family.targets || [],
    lora: loraKind(family.targets),
    skip: family.skip || [],
    data: family.data || ['text'],
    needs: {
      transformers: family.needs?.transformers || '',
      kernels: family.needs?.kernels || [],
      baseline: registry?.baseline?.transformers || '',
    },
    teacherOnly: family.teacherOnly === true,
    experimental: family.experimental === true,
    size: size?.label || '',
    gb: bytes ? Math.round(bytes / 1e9) : 0,
    fit: size ? fitFor(bytes, { gpuBytes, ramBytes }) : '',
    notes: family.notes || '',
  };
}
