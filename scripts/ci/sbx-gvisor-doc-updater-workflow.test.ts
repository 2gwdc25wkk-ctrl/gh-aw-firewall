import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'sbx-gvisor-doc-updater.md');
const lockPath = path.join(workflowsDir, 'sbx-gvisor-doc-updater.lock.yml');

describe('sbx gvisor doc updater workflow config', () => {
  it('pins a lower-cost model and reduced turn budget in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 20');
    expect(source).toContain('model: claude-haiku-4.5');
  });

  it('compiles model and turn budget into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('"agent_model":"claude-haiku-4.5"');
    expect(lock).toContain('COPILOT_MODEL: claude-haiku-4.5');
    expect(lock).toContain('GH_AW_MAX_TURNS: 20');
  });
});
