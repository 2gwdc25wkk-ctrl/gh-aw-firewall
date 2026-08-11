import type {
  EnclaveRepository,
  EnclaveScriptExecutorConfig,
  RawEnclaveEntry,
  RawEnclavesConfig,
} from '../types/enclave-options';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  type EnclavesConfig,
} from '../types/enclave-options';

function repositoryKey(repository: EnclaveRepository): string {
  return repository.repo.toLowerCase();
}

/**
 * Semantic checks that JSON Schema cannot express: unique keyed executors,
 * duplicate repositories within one entry, and cross-entry sensitivity
 * consistency.
 */
export function validateRawEnclavesConfig(raw: RawEnclavesConfig): string[] {
  const errors: string[] = [];
  const executorKinds = new Set<'script' | 'agent'>();
  const sensitivities = new Map<string, string>();

  raw.forEach((entry, entryIndex) => {
    const hasScript = Object.prototype.hasOwnProperty.call(entry, 'script');
    const hasAgent = Object.prototype.hasOwnProperty.call(entry, 'agent');
    if (hasScript === hasAgent) {
      errors.push(`config.enclaves[${entryIndex}] must contain exactly one of script or agent`);
      return;
    }
    const kind = hasScript ? 'script' : 'agent';
    if (executorKinds.has(kind)) {
      errors.push(`config.enclaves contains duplicate executor kind "${kind}"`);
    }
    executorKinds.add(kind);

    const seen = new Set<string>();
    for (const repository of entry.repos ?? []) {
      const key = repositoryKey(repository);
      if (seen.has(key)) {
        errors.push(
          `config.enclaves[${entryIndex}].repos contains duplicate repository "${repository.repo}"`,
        );
      }
      seen.add(key);
      const sensitivity = sensitivities.get(key);
      if (sensitivity !== undefined && sensitivity !== repository.sensitivity) {
        errors.push(
          `config.enclaves repository "${repository.repo}" must use the same sensitivity across executor kinds`,
        );
      } else {
        sensitivities.set(key, repository.sensitivity);
      }
    }
  });

  return errors;
}

type NormalizedCommonConfig = Pick<
  EnclaveScriptExecutorConfig,
  | 'repositories'
  | 'runtime'
  | 'image'
  | 'timeout'
  | 'memoryLimit'
  | 'cpuLimit'
  | 'pidsLimit'
  | 'tmpfsLimit'
  | 'maxOutputBytes'
  | 'maxInvocations'
>;

function commonConfig(
  entry: RawEnclaveEntry,
  defaults: Omit<NormalizedCommonConfig, 'repositories' | 'image'>,
): NormalizedCommonConfig {
  return {
    repositories: entry.repos.map((repository) => ({ ...repository })),
    runtime: entry.runtime ?? defaults.runtime,
    image: entry.image,
    timeout: entry.timeout ?? defaults.timeout,
    memoryLimit: entry.memoryLimit ?? defaults.memoryLimit,
    cpuLimit: entry.cpuLimit ?? defaults.cpuLimit,
    pidsLimit: entry.pidsLimit ?? defaults.pidsLimit,
    tmpfsLimit: entry.tmpfsLimit ?? defaults.tmpfsLimit,
    maxOutputBytes: entry.maxOutputBytes ?? defaults.maxOutputBytes,
    maxInvocations: entry.maxInvocations ?? defaults.maxInvocations,
  };
}

/** Normalizes the keyed compiler contract into trusted runtime controls. */
export function normalizeEnclavesConfig(
  raw: RawEnclavesConfig | undefined,
): EnclavesConfig | undefined {
  if (raw === undefined) return undefined;
  const errors = validateRawEnclavesConfig(raw);
  if (errors.length > 0) {
    throw new Error(`Invalid enclave configuration:\n- ${errors.join('\n- ')}`);
  }

  const repositories = new Map<string, EnclaveRepository>();
  const normalized: EnclavesConfig = { repositories: [] };

  for (const entry of raw) {
    for (const repository of entry.repos) {
      const key = repositoryKey(repository);
      if (!repositories.has(key)) repositories.set(key, { ...repository });
    }

    if ('script' in entry) {
      const common = commonConfig(entry, ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS);
      normalized.script = {
        ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
        ...common,
        maxScriptBytes: entry.script.maxScriptBytes ?? ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS.maxScriptBytes,
      };
    } else {
      const common = commonConfig(entry, ENCLAVE_AGENT_EXECUTOR_DEFAULTS);
      normalized.agent = {
        ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
        ...common,
        engine: entry.agent.engine ?? ENCLAVE_AGENT_EXECUTOR_DEFAULTS.engine,
        profile: entry.agent.profile ?? ENCLAVE_AGENT_EXECUTOR_DEFAULTS.profile,
        model: entry.agent.model,
        maxTaskBytes: entry.agent.maxTaskBytes ?? ENCLAVE_AGENT_EXECUTOR_DEFAULTS.maxTaskBytes,
        maxModelRequests:
          entry.agent.maxModelRequests ?? ENCLAVE_AGENT_EXECUTOR_DEFAULTS.maxModelRequests,
        maxModelTokens: entry.agent.maxModelTokens ?? ENCLAVE_AGENT_EXECUTOR_DEFAULTS.maxModelTokens,
      };
    }
  }

  normalized.repositories = [...repositories.values()];
  return normalized;
}
