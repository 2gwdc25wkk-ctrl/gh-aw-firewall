import { validateAwfFileConfig } from '../config-file';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
} from '../types/enclave-options';
import { normalizeEnclavesConfig } from './enclave-parser';

const internalRepo = { repo: 'octo/private', sensitivity: 'internal' as const };

describe('normalizeEnclavesConfig', () => {
  it('is absent unless the array is configured', () => {
    expect(normalizeEnclavesConfig(undefined)).toBeUndefined();
  });

  it('normalizes script-only {} with conservative defaults', () => {
    expect(normalizeEnclavesConfig([
      { script: {}, repos: [internalRepo] },
    ])).toEqual({
      repositories: [internalRepo],
      script: {
        ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
        repositories: [internalRepo],
      },
    });
  });

  it('normalizes nested agent controls and common camelCase controls', () => {
    expect(normalizeEnclavesConfig([{
      agent: {
        model: 'gpt-5',
        maxTaskBytes: 1024,
        maxModelRequests: 4,
        maxModelTokens: 512,
      },
      repos: [internalRepo],
      runtime: 'gvisor',
      memoryLimit: '256m',
      timeout: 180,
    }])).toEqual({
      repositories: [internalRepo],
      agent: {
        ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
        repositories: [internalRepo],
        model: 'gpt-5',
        runtime: 'gvisor',
        memoryLimit: '256m',
        timeout: 180,
        maxTaskBytes: 1024,
        maxModelRequests: 4,
        maxModelTokens: 512,
      },
    });
  });

  it('forms one case-insensitive repository union for both executors', () => {
    expect(normalizeEnclavesConfig([
      { script: {}, repos: [internalRepo] },
      {
        agent: { model: 'gpt-5' },
        repos: [
          { repo: 'Octo/Private', sensitivity: 'internal' },
          { repo: 'octo/agent-only', sensitivity: 'confidential' },
        ],
      },
    ])).toMatchObject({
      repositories: [
        internalRepo,
        { repo: 'octo/agent-only', sensitivity: 'confidential' },
      ],
      script: { repositories: [internalRepo] },
      agent: {
        repositories: [
          { repo: 'Octo/Private', sensitivity: 'internal' },
          { repo: 'octo/agent-only', sensitivity: 'confidential' },
        ],
      },
    });
  });

  it('fails closed on duplicate executor kinds, per-entry repos, and sensitivity conflicts', () => {
    expect(() => normalizeEnclavesConfig([
      { script: {}, repos: [internalRepo] },
      { script: {}, repos: [{ repo: 'octo/other', sensitivity: 'internal' }] },
    ])).toThrow(/duplicate executor kind "script"/);
    expect(() => normalizeEnclavesConfig([{
      script: {},
      repos: [internalRepo, { repo: 'Octo/Private', sensitivity: 'internal' }],
    }])).toThrow(/duplicate repository/);
    expect(() => normalizeEnclavesConfig([
      { script: {}, repos: [internalRepo] },
      {
        agent: { model: 'gpt-5' },
        repos: [{ repo: 'Octo/Private', sensitivity: 'confidential' }],
      },
    ])).toThrow(/same sensitivity/);
  });
});

describe('enclaves JSON Schema', () => {
  it('accepts script-only, agent-only, and both keyed entries', () => {
    expect(validateAwfFileConfig({
      enclaves: [{ script: {}, repos: [internalRepo] }],
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, repos: [internalRepo] }],
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: [
        { script: { maxScriptBytes: 4096 }, repos: [internalRepo], timeout: 45 },
        {
          agent: {
            model: 'gpt-5',
            maxTaskBytes: 2048,
            maxModelRequests: 8,
            maxModelTokens: 1024,
          },
          repos: [internalRepo],
          timeout: 180,
          memoryLimit: '512m',
        },
      ],
    })).toEqual([]);
  });

  it('requires a non-empty array, repos, script object, and agent model', () => {
    for (const enclaves of [
      [],
      [{ script: {} }],
      [{ script: {}, repos: [] }],
      [{ script: null, repos: [internalRepo] }],
      [{ agent: {}, repos: [internalRepo] }],
      [{ agent: { model: '' }, repos: [internalRepo] }],
    ]) {
      expect(validateAwfFileConfig({ enclaves }).length).toBeGreaterThan(0);
    }
  });

  it('rejects duplicate kinds and duplicate or conflicting repositories', () => {
    expect(validateAwfFileConfig({
      enclaves: [
        { script: {}, repos: [internalRepo] },
        { script: {}, repos: [{ repo: 'octo/other', sensitivity: 'internal' }] },
      ],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        script: {},
        repos: [internalRepo, { repo: 'Octo/Private', sensitivity: 'internal' }],
      }],
    }).join('\n')).toMatch(/duplicate repository/);
    expect(validateAwfFileConfig({
      enclaves: [
        { script: {}, repos: [internalRepo] },
        {
          agent: { model: 'gpt-5' },
          repos: [{ repo: 'OCTO/PRIVATE', sensitivity: 'sealed' }],
        },
      ],
    }).join('\n')).toMatch(/same sensitivity/);
  });

  it('rejects the interim object shape and untrusted executor controls', () => {
    expect(validateAwfFileConfig({
      enclaves: {
        enabled: true,
        privateRepos: [internalRepo],
        executors: { script: { enabled: true } },
      },
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        script: {},
        repos: [internalRepo],
        network: 'bridge',
      }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5', tools: ['shell'] },
        repos: [internalRepo],
      }],
    }).length).toBeGreaterThan(0);
  });

  it('rejects kebab-case compatibility aliases', () => {
    expect(validateAwfFileConfig({
      enclaves: [{
        script: { 'max-script-bytes': 4096 },
        repos: [internalRepo],
        'memory-limit': '256m',
      }],
    }).length).toBeGreaterThan(0);
  });
});
