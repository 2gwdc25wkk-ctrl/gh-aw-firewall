import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveRepository,
  EnclavesConfig,
} from '../types/enclave-options';
import {
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  PRIVATE_REPOSITORY_PATTERN,
} from '../bounded-execution';
import { ENCLAVE_AGENT_MAX_TASK_BYTES } from './protocol';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import { findDockerSocketExposingMount } from './mount-policy';

const RUNTIMES = new Set(['docker', 'gvisor', 'sbx']);
const ENGINES = new Set(['copilot', 'claude', 'codex', 'gemini']);
const SENSITIVITIES = new Set(['public', 'internal', 'confidential', 'sealed']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

/** Engines with a published, audited enclave image and a fixed AWF model loop. */
const IMPLEMENTED_AGENT_ENGINES = new Set(['copilot']);

/**
 * Resolves whether the configured agent profile has a usable API-proxy route.
 *
 * An agent enclave holds no credentials: it can only reach a model through the
 * dedicated AWF API proxy, which injects the real key.
 */
export function resolveEnclaveAgentApiRoute(
  config: WrapperConfig,
  agent: Pick<EnclaveAgentExecutorConfig, 'engine' | 'profile'>,
): { routed: boolean; detail: string } {
  if (agent.engine === 'copilot') {
    return {
      routed: Boolean(
        config.copilotGithubToken
        || config.copilotProviderApiKey,
      ),
      detail: 'apiProxy.targets.copilot (COPILOT_GITHUB_TOKEN or Copilot BYOK route) is not configured',
    };
  }
  if (agent.profile === 'anthropic') {
    return {
      routed: Boolean(config.anthropicApiKey),
      detail: 'apiProxy.targets.anthropic (ANTHROPIC_API_KEY) is not configured',
    };
  }
  return {
    routed: Boolean(config.openaiApiKey),
    detail: 'apiProxy.targets.openai (OPENAI_API_KEY) is not configured',
  };
}

function validateRepository(
  name: string,
  repository: EnclaveRepository,
  errors: string[],
): string | undefined {
  if (!PRIVATE_REPOSITORY_PATTERN.test(repository.repo) || repository.repo.length > 140) {
    errors.push(`${name} entry "${repository.repo}" is not a bare owner/repo slug`);
    return undefined;
  }
  if (!SENSITIVITIES.has(repository.sensitivity)) {
    errors.push(`${name} entry "${repository.repo}" has an unsupported sensitivity`);
  }
  return normalizePrivateRepositoryKey(repository.repo);
}

function validateRepositoryLists(enclaves: EnclavesConfig, errors: string[]): void {
  const effective = new Map<string, EnclaveRepository>();
  const executorUnion = new Map<string, EnclaveRepository>();

  for (const [kind, executor] of [
    ['script', enclaves.script],
    ['agent', enclaves.agent],
  ] as const) {
    if (!executor) continue;
    if (executor.repositories.length === 0) {
      errors.push(`enclaves ${kind} repos is empty`);
    }
    const seen = new Set<string>();
    for (const repository of executor.repositories) {
      const key = validateRepository(`enclaves ${kind} repos`, repository, errors);
      if (!key) continue;
      if (seen.has(key)) {
        errors.push(`enclaves ${kind} repos contains a duplicate entry: "${repository.repo}"`);
      }
      seen.add(key);
      const previous = executorUnion.get(key);
      if (previous && previous.sensitivity !== repository.sensitivity) {
        errors.push(
          `enclaves repository "${repository.repo}" has conflicting sensitivities across executor kinds`,
        );
      } else if (!previous) {
        executorUnion.set(key, repository);
      }
    }
  }

  for (const repository of enclaves.repositories) {
    const key = validateRepository('enclaves effective repos', repository, errors);
    if (!key) continue;
    if (effective.has(key)) {
      errors.push(`enclaves effective repos contains a duplicate entry: "${repository.repo}"`);
    }
    effective.set(key, repository);
  }

  if (
    executorUnion.size !== effective.size
    || [...executorUnion].some(([key, repository]) => (
      effective.get(key)?.sensitivity !== repository.sensitivity
    ))
  ) {
    errors.push('enclaves effective repository union does not match the keyed executor entries');
  }
}

/** Static, fail-closed checks for the keyed enclave configuration. */
export function validateEnclavesConfig(config: WrapperConfig): string[] {
  const enclaves = config.enclaves;
  if (!enclaves) return [];

  const errors: string[] = [];
  if (config.enableDind) {
    errors.push(
      'enclaves cannot be combined with enableDind: exposing the Docker socket to the primary ' +
      'agent would allow it to inspect the gateway capability, private seeds, control network, ' +
      'and ledger state',
    );
  }
  const socketMount = findDockerSocketExposingMount(config);
  if (socketMount) {
    errors.push(
      `enclaves cannot expose the Docker socket to the primary agent through custom volume "${socketMount}": ` +
      'that would allow direct access to enclave capability and private state',
    );
  }

  validateRepositoryLists(enclaves, errors);
  const { script, agent } = enclaves;
  if (!script && !agent) errors.push('enclaves contains no keyed executor entry');

  if (script) {
    if (!RUNTIMES.has(script.runtime)) errors.push(`enclaves script runtime "${script.runtime}" is not supported`);
    if (script.network !== 'none') errors.push('enclaves script network must be "none"');
    if (script.interpreter !== 'python3') errors.push('enclaves script interpreter must be "python3"');
    validateTimeout('enclaves script timeout', script.timeout, errors);
    validateResourceLimits('enclaves script', script, errors);
    validatePositiveInteger('enclaves script maxScriptBytes', script.maxScriptBytes, errors);
    if (script.maxScriptBytes > MAX_SCRIPT_BYTES) {
      errors.push(`enclaves script maxScriptBytes must be at most ${MAX_SCRIPT_BYTES}`);
    }
    if (script.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves script maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    validateBoundedInteger('enclaves script maxInvocations', script.maxInvocations, 10_000, errors);
  }

  if (agent) {
    if (!RUNTIMES.has(agent.runtime)) errors.push(`enclaves agent runtime "${agent.runtime}" is not supported`);
    if (!ENGINES.has(agent.engine)) {
      errors.push(`enclaves agent engine "${agent.engine}" is not supported`);
    } else if (!IMPLEMENTED_AGENT_ENGINES.has(agent.engine)) {
      errors.push(
        `enclaves agent engine "${agent.engine}" is not implemented. Only "copilot" has a ` +
        'pinned native enclave image and an AWF-authored model loop; enclaves never fall back to a ' +
        'different engine.',
      );
    }
    if (agent.network !== 'api-proxy-only') {
      errors.push('enclaves agent network must be "api-proxy-only"');
    }
    if (!MODEL_PATTERN.test(agent.model)) {
      errors.push('enclaves agent model is missing or invalid');
    }
    if (!config.enableApiProxy) {
      errors.push('enclaves agent executor requires the AWF API proxy');
    } else {
      const route = resolveEnclaveAgentApiRoute(config, agent);
      if (!route.routed) {
        errors.push(
          `enclaves agent executor requires a configured API target for engine "${agent.engine}": ` +
          `${route.detail}`,
        );
      }
    }
    validateTimeout('enclaves agent timeout', agent.timeout, errors);
    validateResourceLimits('enclaves agent', agent, errors);
    validatePositiveInteger('enclaves agent maxTaskBytes', agent.maxTaskBytes, errors);
    if (agent.maxTaskBytes > ENCLAVE_AGENT_MAX_TASK_BYTES) {
      errors.push(`enclaves agent maxTaskBytes must be at most ${ENCLAVE_AGENT_MAX_TASK_BYTES}`);
    }
    if (agent.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves agent maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    validateBoundedInteger('enclaves agent maxInvocations', agent.maxInvocations, 1_000, errors);
    validateBoundedInteger('enclaves agent maxModelRequests', agent.maxModelRequests, 64, errors);
    validateBoundedInteger('enclaves agent maxModelTokens', agent.maxModelTokens, 32_768, errors);
  }

  return errors;
}

function validateTimeout(name: string, value: number, errors: string[]): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ENCLAVE_TIMEOUT_SECONDS) {
    errors.push(`${name} must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`);
  }
}

function validatePositiveInteger(name: string, value: number, errors: string[]): void {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${name} must be a positive integer`);
}

function validateBoundedInteger(
  name: string,
  value: number,
  maximum: number,
  errors: string[],
): void {
  validatePositiveInteger(name, value, errors);
  if (value > maximum) errors.push(`${name} must be at most ${maximum}`);
}

function validateResourceLimits(
  name: string,
  executor: {
    memoryLimit: string;
    cpuLimit: string;
    pidsLimit: number;
    tmpfsLimit: string;
    maxOutputBytes: number;
  },
  errors: string[],
): void {
  const dockerSize = /^[1-9][0-9]*[bkmgBKMG]$/;
  if (!dockerSize.test(executor.memoryLimit)) errors.push(`${name} memoryLimit is not a Docker size`);
  if (!dockerSize.test(executor.tmpfsLimit)) errors.push(`${name} tmpfsLimit is not a Docker size`);
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,3})?$/.test(executor.cpuLimit) || Number(executor.cpuLimit) <= 0) {
    errors.push(`${name} cpuLimit must be a positive Docker --cpus value`);
  }
  validateBoundedInteger(`${name} pidsLimit`, executor.pidsLimit, 4_096, errors);
  validatePositiveInteger(`${name} maxOutputBytes`, executor.maxOutputBytes, errors);
}
