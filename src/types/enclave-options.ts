/**
 * Trusted configuration for private-repository enclaves.
 *
 * The AWF file contract is a keyed array. The normalized form keeps the
 * executor-specific controls separate while carrying one case-insensitive
 * repository union for staging and the shared server ledger.
 */

export type EnclaveSensitivity = 'public' | 'internal' | 'confidential' | 'sealed';

export const ENCLAVE_SENSITIVITIES: readonly EnclaveSensitivity[] = [
  'public',
  'internal',
  'confidential',
  'sealed',
];

/** Shared per-repository budget for every executor in one AWF run. */
export const ENCLAVE_SENSITIVITY_RUN_BITS: Readonly<Record<EnclaveSensitivity, number | null>> = {
  public: null,
  internal: 64,
  confidential: 8,
  sealed: 0,
};

export interface EnclaveRepository {
  repo: string;
  sensitivity: EnclaveSensitivity;
}

export type EnclaveRuntime = 'docker' | 'gvisor' | 'sbx';
export type EnclaveScriptInterpreter = 'python3';
export type EnclaveAgentEngine = 'copilot' | 'claude' | 'codex' | 'gemini';
export type EnclaveAgentProfile = 'openai' | 'anthropic';

interface EnclaveExecutorConfig {
  repositories: EnclaveRepository[];
  runtime: EnclaveRuntime;
  /** Optional trusted image override; omission uses AWF's pinned executor image. */
  image?: string;
  timeout: number;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  tmpfsLimit: string;
  maxOutputBytes: number;
  maxInvocations: number;
}

export interface EnclaveScriptExecutorConfig extends EnclaveExecutorConfig {
  network: 'none';
  interpreter: EnclaveScriptInterpreter;
  maxScriptBytes: number;
}

export interface EnclaveAgentExecutorConfig extends EnclaveExecutorConfig {
  network: 'api-proxy-only';
  engine: EnclaveAgentEngine;
  profile: EnclaveAgentProfile;
  model: string;
  maxTaskBytes: number;
  /**
   * Compiler-facing bounds retained in the normalized contract. The current
   * native Copilot loop has no proven per-run enforcement seam for these
   * values, so they are not projected into the executor container.
   */
  maxModelRequests: number;
  maxModelTokens: number;
}

export interface EnclavesConfig {
  /** Case-insensitive union of script and agent repositories, staged once. */
  repositories: EnclaveRepository[];
  script?: EnclaveScriptExecutorConfig;
  agent?: EnclaveAgentExecutorConfig;
}

export interface EnclaveOptions {
  /** Present only when the config file contains a non-empty `enclaves` array. */
  enclaves?: EnclavesConfig;
}

interface RawEnclaveCommonConfig {
  repos: EnclaveRepository[];
  runtime?: EnclaveRuntime;
  image?: string;
  timeout?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  tmpfsLimit?: string;
  maxOutputBytes?: number;
  maxInvocations?: number;
}

export interface RawEnclaveScriptEntry extends RawEnclaveCommonConfig {
  script: {
    maxScriptBytes?: number;
  };
}

export interface RawEnclaveAgentEntry extends RawEnclaveCommonConfig {
  agent: {
    engine?: EnclaveAgentEngine;
    profile?: EnclaveAgentProfile;
    model: string;
    maxTaskBytes?: number;
    maxModelRequests?: number;
    maxModelTokens?: number;
  };
}

export type RawEnclaveEntry = RawEnclaveScriptEntry | RawEnclaveAgentEntry;
export type RawEnclavesConfig = RawEnclaveEntry[];

export const ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS: Readonly<
  Omit<EnclaveScriptExecutorConfig, 'repositories' | 'image'>
> = {
  runtime: 'docker',
  network: 'none',
  interpreter: 'python3',
  timeout: 30,
  memoryLimit: '512m',
  cpuLimit: '1',
  pidsLimit: 128,
  tmpfsLimit: '64m',
  maxOutputBytes: 8192,
  maxScriptBytes: 64 * 1024,
  maxInvocations: 32,
};

export const ENCLAVE_AGENT_EXECUTOR_DEFAULTS: Readonly<
  Omit<EnclaveAgentExecutorConfig, 'repositories' | 'image' | 'model'>
> = {
  runtime: 'docker',
  network: 'api-proxy-only',
  engine: 'copilot',
  profile: 'openai',
  timeout: 120,
  memoryLimit: '512m',
  cpuLimit: '1',
  pidsLimit: 128,
  tmpfsLimit: '64m',
  maxOutputBytes: 8192,
  maxTaskBytes: 4096,
  maxModelRequests: 8,
  maxModelTokens: 1024,
  maxInvocations: 8,
};
