import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import type { RawEnclaveAgentEntry, RawEnclaveEntry } from '../types/enclave-options';
import { validateEnclavesConfig } from './preflight';

const repository = { repo: 'octo/private', sensitivity: 'internal' as const };

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/workspace/awf',
    enclaves: normalizeEnclavesConfig([{ script: {}, repos: [repository] }]),
    ...overrides,
  } as WrapperConfig;
}

function agentConfig(
  agent: RawEnclaveAgentEntry['agent'],
  common: Record<string, unknown> = {},
): WrapperConfig {
  return config({
    enclaves: normalizeEnclavesConfig([{
      agent,
      repos: [repository],
      ...common,
    } as RawEnclaveEntry]),
    enableApiProxy: true,
    copilotGithubToken: 'token',
  });
}

describe('validateEnclavesConfig', () => {
  it('accepts minimal script and routed agent defaults', () => {
    expect(validateEnclavesConfig(config())).toEqual([]);
    expect(validateEnclavesConfig(agentConfig({ model: 'gpt-5' }))).toEqual([]);
  });

  it('accepts both keyed executors with one matching effective repository union', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, repos: [repository] },
      {
        agent: { model: 'gpt-5' },
        repos: [
          { repo: 'OCTO/PRIVATE', sensitivity: 'internal' },
          { repo: 'octo/agent-only', sensitivity: 'confidential' },
        ],
      },
    ]);
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    }))).toEqual([]);
    expect(enclaves?.repositories).toHaveLength(2);
  });

  it('fails closed if normalized entry repos and the staging union diverge', () => {
    const enclaves = normalizeEnclavesConfig([{ script: {}, repos: [repository] }])!;
    enclaves.repositories = [];
    expect(validateEnclavesConfig(config({ enclaves })).join('\n')).toMatch(
      /effective repository union does not match/,
    );
  });

  it('rejects malformed controls that bypass schema validation', () => {
    const enclaves = normalizeEnclavesConfig([{ script: {}, repos: [repository] }])!;
    Object.assign(enclaves.script!, {
      runtime: 'invalid',
      network: 'bridge',
      interpreter: 'ruby',
      timeout: 0,
      memoryLimit: 'lots',
      cpuLimit: '0',
      pidsLimit: 0,
      tmpfsLimit: '64',
      maxOutputBytes: 0,
      maxScriptBytes: 0,
      maxInvocations: 0,
    });
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    for (const pattern of [
      /script runtime "invalid" is not supported/,
      /script network must be "none"/,
      /script interpreter must be "python3"/,
      /script timeout must be between/,
      /memoryLimit is not a Docker size/,
      /cpuLimit must be a positive/,
      /must be a positive integer/,
    ]) {
      expect(errors).toMatch(pattern);
    }
  });

  it('rejects script ceilings the server cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig([{
      script: {},
      repos: [repository],
    }])!;
    enclaves.script!.maxScriptBytes = 65_537;
    enclaves.script!.maxOutputBytes = 8_193;
    enclaves.script!.maxInvocations = 10_001;
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/maxScriptBytes must be at most 65536/);
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
    expect(errors).toMatch(/maxInvocations must be at most 10000/);
  });

  it('requires the API proxy and a usable route for an agent entry', () => {
    const enclaves = normalizeEnclavesConfig([{
      agent: { model: 'gpt-5' },
      repos: [repository],
    }]);
    expect(validateEnclavesConfig(config({ enclaves })).join('\n')).toMatch(
      /requires the AWF API proxy/,
    );
    expect(validateEnclavesConfig(config({ enclaves, enableApiProxy: true })).join('\n')).toMatch(
      /COPILOT_GITHUB_TOKEN/,
    );
  });

  it('rejects invalid models and agent ceilings, including compiler-facing model controls', () => {
    const wrapper = agentConfig({ model: 'gpt-5' });
    Object.assign(wrapper.enclaves!.agent!, {
      model: ' model',
      timeout: 541,
      maxTaskBytes: 65_537,
      maxOutputBytes: 8_193,
      maxInvocations: 1_001,
      maxModelRequests: 65,
      maxModelTokens: 32_769,
    });
    const errors = validateEnclavesConfig(wrapper).join('\n');
    expect(errors).toMatch(/agent model is missing or invalid/);
    expect(errors).toMatch(/agent timeout must be between/);
    expect(errors).toMatch(/maxTaskBytes must be at most 65536/);
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
    expect(errors).toMatch(/maxInvocations must be at most 1000/);
    expect(errors).toMatch(/maxModelRequests must be at most 64/);
    expect(errors).toMatch(/maxModelTokens must be at most 32768/);
  });

  it('rejects an engine without an audited enclave image and never falls back', () => {
    const wrapper = agentConfig({ model: 'claude-test', engine: 'claude' });
    wrapper.anthropicApiKey = 'key';
    const errors = validateEnclavesConfig(wrapper).join('\n');
    expect(errors).toMatch(/engine "claude" is not implemented/);
    expect(errors).toMatch(/never fall back/);
  });

  it('rejects enclaves combined with any primary-agent Docker socket exposure', () => {
    expect(validateEnclavesConfig(config({ enableDind: true })).join('\n')).toMatch(
      /cannot be combined with enableDind/,
    );
    expect(validateEnclavesConfig(config({
      volumeMounts: ['/var/run/docker.sock:/var/run/docker.sock'],
    })).join('\n')).toMatch(/cannot expose the Docker socket/);
  });

  it('treats absence of the enclaves key as disabled', () => {
    expect(validateEnclavesConfig(config({ enclaves: undefined }))).toEqual([]);
  });
});
